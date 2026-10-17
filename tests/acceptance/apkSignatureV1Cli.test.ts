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
  LEAF_SHA256,
  LEAF_SUBJECT,
  OPENSSL_BLOCK_ISSUER_SERIAL,
  ROOT_CERTIFICATE,
  v2SchemeValue,
  withSigningBlock,
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
