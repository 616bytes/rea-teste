import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  uiPageEvidence,
  uiPageInspection,
  uiRelatedEvidence,
  uiSessionEvidence,
} from "../../fixtures/uiStateTransition.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("UI state derivation must not open a provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "ui-state-transition-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
};

it("advertises and derives portable and retained browser state transitions identically", async () => {
  const { client, session } = await connect();
  const before = uiPageEvidence();
  const complete = uiPageInspection().completeness;
  const after = uiPageEvidence(
    uiPageInspection({
      capture_window: {
        started_at: "2026-10-15T12:00:01.000Z",
        ended_at: "2026-10-15T12:00:01.000Z",
        observation_ms: 0,
      },
      completeness: {
        ...complete,
        status: "policy_filtered",
        conditions: ["attach_limited", "policy_filtered"],
        policy_filtered_sections: ["dom"],
        attach_limited_sections: ["accessibility"],
      },
    }),
  );
  const sessionWindow = uiSessionEvidence();
  const related = uiRelatedEvidence();
  const sourceRecords = [before, after, sessionWindow, related];
  for (const evidence of sourceRecords)
    expect(session.evidenceById(evidence.evidence_id)).toBeUndefined();
  const recordEvidence = vi.spyOn(session, "recordEvidence");
  const schemas = await advertisedMcpToolSchemas(
    client,
    "derive_ui_state_transition",
  );
  const action = {
    action_id: "open-settings",
    description: "External Pyppeteer clicked the settings control.",
    provenance: "caller-declared" as const,
  };
  const inputs = [
    {
      before,
      after,
      action,
      selection: { offset: 0, limit: 2 },
      session: sessionWindow,
      related_evidence: [related],
    },
    {
      before: { kind: "retained-evidence", evidence_id: before.evidence_id },
      after: { kind: "retained-evidence", evidence_id: after.evidence_id },
      action,
      selection: { offset: 0, limit: 2 },
      session: {
        kind: "retained-evidence",
        evidence_id: sessionWindow.evidence_id,
      },
      related_evidence: [
        { kind: "retained-evidence", evidence_id: related.evidence_id },
      ],
    },
  ];
  const outputs = [];
  const outputEvidenceIds: string[] = [];
  for (const input of inputs) {
    expect(
      schemas.ajv.validate(schemas.inputSchema, input),
      JSON.stringify(schemas.ajv.errors),
    ).toBe(true);
    const response = await client.callTool({
      name: "derive_ui_state_transition",
      arguments: input,
    });
    expect(response.isError).not.toBe(true);
    expect(
      schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
      JSON.stringify(schemas.ajv.errors),
    ).toBe(true);
    const parsed = toolContract(
      "derive_ui_state_transition",
    ).outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(parsed);
    expect(evidence.normalized_result).toMatchObject({
      adapter: "browser-page-v1",
      transition: {
        association: "caller-declared-between-observations",
        session: { status: "observed", timeline_event_count: 1 },
      },
      before: {
        accessibility: {
          items: [{ node_id: "ax-root" }, { node_id: "ax-save" }],
        },
      },
      after: {
        dom: {
          status: "partial",
          reason:
            "The retained dom observation is policy-filtered; consult the source Evidence coverage.",
        },
        accessibility: {
          status: "partial",
          reason:
            "The retained accessibility observation is attach-limited; consult the source Evidence coverage.",
        },
      },
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    expect(
      evidence.evidence_links.every(
        (evidenceId) => session.evidenceById(evidenceId) !== undefined,
      ),
    ).toBe(true);
    outputs.push(evidence.normalized_result);
    outputEvidenceIds.push(evidence.evidence_id);
  }
  const inlineEvidenceId = outputEvidenceIds[0];
  if (inlineEvidenceId === undefined)
    throw new Error("The inline transition did not return Evidence");
  expect(
    recordEvidence.mock.calls
      .slice(0, 5)
      .map(([evidence]) => evidence.evidence_id),
  ).toEqual([
    ...sourceRecords.map((evidence) => evidence.evidence_id),
    inlineEvidenceId,
  ]);
  for (const evidence of sourceRecords)
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(outputs[0]).toEqual(outputs[1]);
  expect(
    schemas.ajv.validate(schemas.inputSchema, {
      before,
      after,
      action: { ...action, provenance: "observed" },
    }),
  ).toBe(false);
});
