import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  uiPageEvidence,
  uiPageInspection,
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
  const after = uiPageEvidence(
    uiPageInspection({
      capture_window: {
        started_at: "2026-10-15T12:00:01.000Z",
        ended_at: "2026-10-15T12:00:01.000Z",
        observation_ms: 0,
      },
    }),
  );
  const sessionWindow = uiSessionEvidence();
  for (const evidence of [before, after, sessionWindow]) {
    const recorded = session.recordEvidence(evidence);
    if (!recorded.ok) throw recorded.error;
  }
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
    },
  ];
  const outputs = [];
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
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    outputs.push(evidence.normalized_result);
  }
  expect(outputs[0]).toEqual(outputs[1]);
  expect(
    schemas.ajv.validate(schemas.inputSchema, {
      before,
      after,
      action: { ...action, provenance: "observed" },
    }),
  ).toBe(false);
});
