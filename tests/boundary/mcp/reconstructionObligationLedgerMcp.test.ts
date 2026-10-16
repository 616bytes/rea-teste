import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { reviewedObligation } from "../../../src/application/ReconstructionObligationLedger.fixture.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

type LedgerCall = (
  ledgerArguments: Record<string, unknown>,
) => ReturnType<Client["callTool"]>;

/** Run calls against the ledger tool through one live in-memory MCP session. */
const withLedgerTool = async (
  run: (callLedger: LedgerCall) => Promise<void>,
): Promise<void> => {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "obligation-ledger-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run((ledgerArguments) =>
      client.callTool({
        name: "build_reconstruction_obligation_ledger",
        arguments: ledgerArguments,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
};

const fixtureRecord = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "observe", parameters: { label }, result: { label } },
  );

const callerInputFailure = (message: string) => ({
  error: {
    code: "invalid_request",
    category: "invalid_input",
    details: {
      operation: "build_reconstruction_obligation_ledger",
      issues: [
        expect.objectContaining({ message: expect.stringContaining(message) }),
      ],
    },
  },
});

describe("reconstruction obligation ledger MCP parity", () => {
  it("returns canonical bundle failures as caller input errors", async () => {
    const canonical = createEvidenceBundle([
      fixtureRecord("first"),
      fixtureRecord("second"),
    ]);
    await withLedgerTool(async (callLedger) => {
      const request = (evidenceBundle: unknown) =>
        callLedger({
          evidence_bundle: evidenceBundle,
          reviewed_obligations: [],
          manifest: { bindings: [], contradictions: [] },
        });
      const valid = await request(canonical);
      expect(valid.isError).not.toBe(true);
      expect(valid.structuredContent).toMatchObject({
        normalized_result: { status: "unknown", summary: { total: 0 } },
      });
      const result = await request({
        ...canonical,
        records: [...canonical.records].reverse(),
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject(
        callerInputFailure("Evidence bundle manifests are not canonical"),
      );
    });
  });

  it("returns absent review Evidence as a caller input error", async () => {
    const absentEvidenceId = `ev_${"a".repeat(64)}`;
    await withLedgerTool(async (callLedger) => {
      const result = await callLedger({
        evidence_bundle: createEvidenceBundle([]),
        reviewed_obligations: [
          reviewedObligation("obl.review.absent", absentEvidenceId),
        ],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject(
        callerInputFailure(
          `Reviewed obligation Evidence is missing: ${absentEvidenceId}`,
        ),
      );
    });
  });

  it("returns a duplicated Evidence record as a caller input error", async () => {
    const canonical = createEvidenceBundle([fixtureRecord("duplicated")]);
    await withLedgerTool(async (callLedger) => {
      const result = await callLedger({
        evidence_bundle: {
          ...canonical,
          records: [...canonical.records, ...canonical.records],
        },
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject(
        callerInputFailure("Evidence bundle contains duplicate record IDs"),
      );
    });
  });

  it("returns the complete Evidence-backed ledger inline", async () => {
    await withLedgerTool(async (callLedger) => {
      const result = await callLedger({
        evidence_bundle: createEvidenceBundle([]),
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        normalized_result: {
          schema: "ReconstructionObligationLedger",
          status: "unknown",
          summary: { total: 0 },
        },
      });
    });
  });
});
