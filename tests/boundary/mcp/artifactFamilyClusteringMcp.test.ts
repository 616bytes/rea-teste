import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { parseArtifactInventoryEvidence } from "../../../src/domain/artifactInventoryEvidence.js";
import { createServer } from "../../../src/server/createServer.js";
import type { Evidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** One archive whose entries are fixed, so only the bytes we choose differ. */
const writeArchive = async (
  path: string,
  entries: readonly (readonly [string, string])[],
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of entries)
    await writer.add(name, new TextReader(content));
  await writeFile(path, await writer.close());
};

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const resultOf = (result: ToolCallResult): JsonValue => {
  expect(result.isError).not.toBe(true);
  const structured = result.structuredContent as
    | { readonly normalized_result?: JsonValue }
    | null
    | undefined;
  if (structured?.normalized_result === undefined)
    throw new Error("Tool returned no structured result");
  return structured.normalized_result;
};

/** Read back the complete Evidence this call retained in the session. */
const retainedEvidence = (
  result: ToolCallResult,
  session: ReturnType<typeof createTestBinarySession>,
): Evidence => {
  expect(result.isError).not.toBe(true);
  const evidenceId = (
    result.structuredContent as { evidence_id?: unknown } | undefined
  )?.evidence_id;
  if (typeof evidenceId !== "string")
    throw new Error("Tool returned no Evidence id");
  const evidence = session.evidenceById(evidenceId);
  if (evidence === undefined)
    throw new Error(`Evidence ${evidenceId} was not retained`);
  return evidence;
};

it("clusters three inspected archives through MCP by family and shared members", async () => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-mcp-");
  const alpha = join(root, "alpha.zip");
  const beta = join(root, "beta.zip");
  const gamma = join(root, "gamma.zip");
  await writeArchive(alpha, [
    ["one.txt", "shared-entry"],
    ["two.txt", "alpha-entry"],
  ]);
  await writeArchive(beta, [
    ["one.txt", "shared-entry"],
    ["two.txt", "beta-entry"],
  ]);
  // Byte-identical to alpha, so both share one root content digest.
  await copyFile(alpha, gamma);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "cluster-artifacts-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const members: { label: string; evidence: Evidence }[] = [];
    for (const [label, path] of [
      ["alpha", alpha],
      ["beta", beta],
      ["gamma", gamma],
    ] as const) {
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      members.push({ label, evidence: retainedEvidence(inspected, session) });
    }

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: { members },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly {
        readonly tier: string | null;
        readonly members: readonly { readonly label: string }[];
      }[];
      readonly shared_members: readonly {
        readonly member_count: number;
        readonly observations: readonly {
          readonly label: string;
          readonly evidence_id: string;
        }[];
      }[];
      readonly coverage: {
        readonly member_scope: string;
        readonly members_without_byte_root_digest: number;
        readonly nodes_without_byte_identity: number;
      };
      readonly partially_shared_members: readonly {
        readonly member_count: number;
      }[];
    };

    expect(result.status).toBe("partitioned");
    // Real container inspection inventories the entries, not only the root.
    expect(result.coverage.member_scope).toBe("container-entries");
    // Alpha and gamma are byte-identical: one family, beta stays outside it.
    expect(result.families).toHaveLength(1);
    expect(result.families[0]?.tier).toBe("root-sha256");
    expect(result.families[0]?.members.map(({ label }) => label)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(result.summary.members_without_family).toBe(1);
    // one.txt is in every member; two.txt only in alpha and gamma.
    expect(result.shared_members).toHaveLength(1);
    expect(result.shared_members[0]?.member_count).toBe(3);
    // Every index row carries the Evidence id of each member that observed it,
    // with the caller's label next to it rather than instead of it.
    expect(
      result.shared_members[0]?.observations.map(
        ({ label, evidence_id: evidenceId }) => [
          label,
          evidenceId === members[0]!.evidence.evidence_id,
        ],
      ),
    ).toEqual([
      ["alpha", true],
      ["beta", false],
      ["gamma", false],
    ]);
    // Archives are read as bytes, so these members keep byte-root identity and
    // no directory node is indexed.
    expect(result.coverage.members_without_byte_root_digest).toBe(0);
    expect(result.coverage.nodes_without_byte_identity).toBe(0);
    // Below the whole-set threshold: two.txt across alpha and gamma, and the
    // alpha/gamma root node itself, which is why the identical pair appears in
    // both the family list and the member index without contradiction.
    expect(result.partially_shared_members).toHaveLength(2);
    expect(
      result.partially_shared_members.every(
        ({ member_count }) => member_count === 2,
      ),
    ).toBe(true);
    // beta's own root and its two.txt are each observed in exactly one member.
    expect(result.summary.unique_members).toBe(2);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);

/**
 * The real truncated-inventory case: a universal Mach-O whose slices no
 * adapter on this host can read. The producer observes the root and every node
 * it listed while declaring `coverage.status` "unknown", so the counts match
 * and only the declaration carries the incompleteness. Members like it are
 * unplaced with "incomplete-inventory". A host with a native slice adapter
 * answers completely, which is why this case is asked for rather than assumed.
 *
 * Hand-built contradictions are deliberately not used here: a ZIP whose stored
 * bytes disagree with the CRC its central directory declares is refused by the
 * producer even under integrity_policy record-and-continue, so no such member
 * can be obtained from a real file.
 */
it("keeps a member with unknown child coverage unplaced", async (context) => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-fat-");
  const universal = join(root, "universal");
  // Two slices of one file: a FAT container no adapter here can split.
  await writeFile(
    universal,
    fatImage([
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
    ]),
  );
  const archive = join(root, "archive.zip");
  await writeArchive(archive, [["one.txt", "shared-entry"]]);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "cluster-artifacts-incomplete",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const members: { label: string; evidence: Evidence }[] = [];
    for (const [label, path] of [
      ["archive", archive],
      ["universal", universal],
    ] as const) {
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      members.push({ label, evidence: retainedEvidence(inspected, session) });
    }

    // The member's own declared coverage decides whether this host can read
    // its children, read through the owning parser rather than re-derived.
    const declared = parseArtifactInventoryEvidence(members[1]!.evidence)
      .inventory.coverage;
    if (declared.status === "complete")
      context.skip(
        "This host has a native adapter for universal Mach-O slices.",
      );

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: { members },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly {
        readonly family_id: string;
        readonly members: readonly { readonly label: string }[];
        readonly unknown_members: readonly {
          readonly label: string;
          readonly reason: string;
        }[];
      }[];
      readonly coverage: { readonly member_scope: string };
      readonly limitations: readonly string[];
    };

    expect(result.status).toBe("partial");
    expect(result.coverage.member_scope).toBe("container-entries");
    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(
      unplaced?.unknown_members.map(({ label, reason }) => [label, reason]),
    ).toEqual([["universal", "incomplete-inventory"]]);
    // Neither member is claimed as identical or different.
    expect(result.families.flatMap(({ members: rows }) => rows)).toHaveLength(
      0,
    );
    expect(result.summary.members_with_unknown_inventory).toBe(1);
    expect(result.summary.members_with_complete_inventory).toBe(1);
    expect(result.summary.members_without_family).toBe(1);
    // The producer's own limitation travels with the member.
    expect(
      result.limitations.some((item) =>
        item.startsWith("universal: Universal Mach-O slices"),
      ),
    ).toBe(true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);

it("refuses a member that is not artifact inventory Evidence", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Clustering must not launch a provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "cluster-artifacts-refusal",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const refused = await client.callTool({
      name: "cluster_artifacts",
      arguments: {
        members: [
          { label: "a", evidence: { evidence_id: `ev_${"0".repeat(64)}` } },
          { label: "b", evidence: { evidence_id: `ev_${"1".repeat(64)}` } },
        ],
      },
    });
    // A member that is not assembled Evidence is refused by the advertised
    // schema, so no artifact processor ever sees it.
    expect(refused.isError).toBe(true);
    const text = refused.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toMatch(/Input validation/u);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
