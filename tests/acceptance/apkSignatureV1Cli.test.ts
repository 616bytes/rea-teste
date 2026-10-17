import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../src/application/binary/BinarySessionComposition.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createServer } from "../../src/server/createServer.js";
import {
  APK_SIGNATURE_V2_ID,
  APK_SIGNATURE_V3_ID,
  LEAF_CERTIFICATE,
  LEAF_SHA256,
  LEAF_SUBJECT,
  OPENSSL_BLOCK_ISSUER_SERIAL,
  ROOT_CERTIFICATE,
  v2SchemeValue,
  v3SchemeValue,
  withSigningBlock,
  zipEntryOffsets,
  zipWith,
} from "../fixtures/apkSignature/v1SignatureBlock.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "names the v1 signer certificate and a v1/v2 signer mismatch identically through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apk-v1-signer-");
    const v1Zip = await zipWith([
      { name: "classes.dex", data: "dex" },
      { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0" },
      { name: "META-INF/CERT.SF", data: "Signature-Version: 1.0" },
      { name: "META-INF/CERT.EC", data: OPENSSL_BLOCK_ISSUER_SERIAL },
    ]);
    const v1Only = join(root, "v1-only.apk");
    await writeFile(v1Only, v1Zip);
    // The v2 block names a different certificate than the JAR signature.
    const mixed = join(root, "v1-v2-mismatch.apk");
    await writeFile(
      mixed,
      withSigningBlock(v1Zip, [
        { id: APK_SIGNATURE_V2_ID, value: v2SchemeValue(ROOT_CERTIFICATE) },
      ]),
    );

    // Rotated v1 + v3 without v2: v1 keeps the original key (the lineage's
    // first node), v3 signs with the newest. That is the expected layout.
    const rotated = join(root, "v1-v3-rotated.apk");
    await writeFile(
      rotated,
      withSigningBlock(v1Zip, [
        {
          id: APK_SIGNATURE_V3_ID,
          value: v3SchemeValue(ROOT_CERTIFICATE, [
            LEAF_CERTIFICATE,
            ROOT_CERTIFICATE,
          ]),
        },
      ]),
    );
    // A lineage that does not start at the v1 key is still a mismatch.
    const misrotated = join(root, "v1-v3-misrotated.apk");
    await writeFile(
      misrotated,
      withSigningBlock(v1Zip, [
        {
          id: APK_SIGNATURE_V3_ID,
          value: v3SchemeValue(LEAF_CERTIFICATE, [
            ROOT_CERTIFICATE,
            LEAF_CERTIFICATE,
          ]),
        },
      ]),
    );

    const contract = toolContract("inspect_apk_signature");
    const viaCli = async (path: string) => {
      const result = await cli.run({
        arguments: ["inspect-apk-signature", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return contract.outputSchema.parse(result.json);
    };
    const cliV1 = await viaCli(v1Only);
    const cliMixed = await viaCli(mixed);
    const cliRotated = await viaCli(rotated);
    const cliMisrotated = await viaCli(misrotated);

    expect(cliV1.normalized_result.schemes.v1.signers).toMatchObject([
      {
        signature_file: "META-INF/CERT.SF",
        block_file: "META-INF/CERT.EC",
        certificate: { sha256_fingerprint: LEAF_SHA256, subject: LEAF_SUBJECT },
        decode_error: null,
      },
    ]);
    expect(cliV1.normalized_result.posture).toMatchObject({
      v1_only: true,
      v1_signers_match_block_signers: null,
    });
    expect(cliMixed.normalized_result.posture).toMatchObject({
      v1_only: false,
      v1_signers_match_block_signers: false,
    });
    expect(cliRotated.normalized_result.posture).toMatchObject({
      v1_only: false,
      rotation_present: true,
      signer_change_declared_by_rotation: false,
      v1_signers_match_block_signers: true,
    });
    expect(
      cliMisrotated.normalized_result.posture.v1_signers_match_block_signers,
    ).toBe(false);
    expect(cliV1.limitations.join(" ")).toContain("NOT verified");

    const session = composeBinarySession(new AnalysisProviderRegistry([]));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "apk-v1-signer-parity", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === "inspect_apk_signature",
      );
      const outputSchema: Record<string, unknown> | undefined =
        tool?.outputSchema;
      if (tool === undefined || outputSchema === undefined)
        throw new Error(
          "inspect_apk_signature must advertise an output schema",
        );
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      for (const [path, fromCli] of [
        [v1Only, cliV1],
        [mixed, cliMixed],
        [rotated, cliRotated],
      ] as const) {
        const reply = await client.callTool({
          name: tool.name,
          arguments: { path },
        });
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        expect(
          ajv.validate(outputSchema, reply.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const evidence = parseEvidence(reply.structuredContent);
        expect(evidence.normalized_result).toEqual(fromCli.normalized_result);
        expect(evidence.evidence_id).toBe(fromCli.evidence_id);
      }
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

cliTest(
  "keeps a v1 signer unknown where apksig refuses its signature block entry",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apk-v1-entry-");
    const block = "META-INF/CERT.EC";
    // apksigner writes local headers with sizes, not data descriptors.
    const signed = await zipWith(
      [
        { name: "classes.dex", data: "dex" },
        { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0" },
        { name: "META-INF/CERT.SF", data: "Signature-Version: 1.0" },
        { name: block, data: OPENSSL_BLOCK_ISSUER_SERIAL },
      ],
      { dataDescriptor: false },
    );
    const padded = await zipWith(
      [
        { name: "META-INF/CERT.SF", data: "Signature-Version: 1.0" },
        {
          name: block,
          data: Uint8Array.from([...OPENSSL_BLOCK_ISSUER_SERIAL, 0, 0]),
        },
      ],
      { dataDescriptor: false },
    );
    const mutated = async (
      name: string,
      mutate: (bytes: Buffer, at: { central: number; local: number }) => void,
    ) => {
      const bytes = Buffer.from(signed);
      mutate(bytes, zipEntryOffsets(signed, block));
      const path = join(root, name);
      await writeFile(path, bytes);
      return path;
    };
    const cases = [
      [await mutated("intact.apk", () => undefined), null],
      [
        await mutated("local-size-plus1.apk", (bytes, { local }) => {
          bytes.writeUInt32LE(bytes.readUInt32LE(local + 18) + 1, local + 18);
        }),
        /^local header compressed size \d+ differs from the central directory's \d+$/,
      ],
      [
        await mutated("local-name-differs.apk", (bytes, { local }) => {
          bytes.write("META-INF/CERT.XY", local + 30, "latin1");
        }),
        "local header name differs from the central directory's",
      ],
      [
        await mutated("encrypted-flag.apk", (bytes, { central, local }) => {
          bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
          bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6);
        }),
        "entry is encrypted (general-purpose flag bit 0)",
      ],
      [
        await mutated("zip64-sentinel.apk", (bytes, { central }) => {
          bytes.writeUInt32LE(0xffffffff, central + 24);
        }),
        "Zip64 entry sizes are not read",
      ],
    ] as const;
    // Bytes after the ContentInfo are ignored, as apksig ignores them, and
    // reported as a limitation rather than refusing the block.
    const paddedPath = join(root, "trailing-bytes.apk");
    await writeFile(paddedPath, padded);
    const paddedResult = await cli.run({
      arguments: ["inspect-apk-signature", paddedPath, "--json"],
    });
    expect(paddedResult.exitCode, paddedResult.stderr).toBe(0);
    const paddedEvidence = toolContract(
      "inspect_apk_signature",
    ).outputSchema.parse(paddedResult.json);
    expect(paddedEvidence.normalized_result.schemes.v1.signers).toMatchObject([
      { certificate: { sha256_fingerprint: LEAF_SHA256 }, decode_error: null },
    ]);
    expect(paddedEvidence.limitations).toContain(
      `${block}: 2 bytes follow the PKCS#7 ContentInfo and were ignored, as apksig ignores them.`,
    );

    for (const [path, decodeError] of cases) {
      const result = await cli.run({
        arguments: ["inspect-apk-signature", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = toolContract("inspect_apk_signature").outputSchema.parse(
        result.json,
      ).normalized_result;
      const [signer, ...rest] = report.schemes.v1.signers;
      expect(rest, path).toEqual([]);
      if (decodeError === null) {
        expect(signer?.decode_error, path).toBeNull();
        expect(signer?.certificate?.sha256_fingerprint, path).toBe(LEAF_SHA256);
        continue;
      }
      // Unknown, not absent: the signer stays listed without a certificate.
      expect(report.schemes.v1.present, path).toBe(true);
      expect(signer?.certificate, path).toBeNull();
      if (typeof decodeError === "string")
        expect(signer?.decode_error, path).toBe(decodeError);
      else expect(signer?.decode_error, path).toMatch(decodeError);
    }
  },
);
