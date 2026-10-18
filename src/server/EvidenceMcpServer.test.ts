import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvestigationRecords } from "../application/investigation/InvestigationRecords.js";
import {
  EvidenceMcpServer,
  extractEvidenceId,
  forgetPendingMcpRequest,
} from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./toolResult.js";
import { ActivityJournal } from "../application/activity/ActivityJournal.js";

const firstText = (result: {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string | undefined => {
  for (const item of result.content) {
    if (item.type === "text") return item.text;
  }
  return undefined;
};

const activityRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    activityRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MCP request bookkeeping", () => {
  it("releases list, tool, and completion state when cancellation arrives", () => {
    const completion = new AbortController();
    const pendingTools = new Map([[7, "inspect_artifact"]]);
    const pendingToolLists = new Set([7]);
    const pendingCompletions = new Map([[7, completion]]);

    forgetPendingMcpRequest(
      pendingTools,
      pendingToolLists,
      pendingCompletions,
      7,
    );

    expect(pendingTools.has(7)).toBe(false);
    expect(pendingToolLists.has(7)).toBe(false);
    expect(completion.signal.aborted).toBe(true);
    expect(pendingCompletions.has(7)).toBe(false);
  });
});

describe("SDK validation error delivery", () => {
  it("bounds oversized errors, retains their source, and preserves fitting and valid calls", async () => {
    const delivery = new ToolResultDelivery(4096);
    const records = new InvestigationRecords();
    const server = new EvidenceMcpServer(
      { name: "sdk-validation-budget-test", version: "1" },
      { capabilities: {} },
      (evidence) => records.recordEvidence(evidence),
      delivery,
    );
    server.registerTool(
      "procedure_pseudo_code",
      { inputSchema: z.strictObject({ required: z.string() }) },
      async () => ({ content: [{ type: "text", text: "valid call" }] }),
    );
    const client = new Client({
      name: "sdk-validation-budget-client",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const oversizedKey = `unexpected_${"x".repeat(6000)}`;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const oversized = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present", [oversizedKey]: true },
      });
      expect(oversized.isError).toBe(true);
      expect(oversized.structuredContent).toBeUndefined();
      expect(oversized._meta).toEqual({
        provenance: { untrusted_content: true, source: "analysis_target" },
      });
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(4096);
      const oversizedError = z
        .object({
          error: z.object({
            code: z.string(),
            details: z.object({
              reported_limits: z.record(z.string(), z.unknown()),
            }),
          }),
        })
        .parse(JSON.parse(firstText(oversized) ?? "null"));
      expect(oversizedError.error.code).toBe("resource_constraint");
      const reportedLimits = oversizedError.error.details.reported_limits;
      expect(reportedLimits).toMatchObject({
        evidence_reference: {
          kind: "retained-evidence",
          evidence_id: expect.any(String),
        },
        diagnostic_truncated: true,
      });
      expect(reportedLimits).not.toHaveProperty("retention");
      const bundle = records.exportEvidenceBundle();
      expect(bundle.records).toHaveLength(1);
      expect(bundle.records[0]?.operation).toBe("mcp_tool_error");
      expect(bundle.records[0]?.raw_result).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining(oversizedKey) },
        ],
      });
      const evidenceReference = z
        .object({ evidence_id: z.string() })
        .parse(reportedLimits.evidence_reference);
      expect(bundle.records[0]?.evidence_id).toBe(
        evidenceReference.evidence_id,
      );

      const fitting = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { unexpected: true },
      });
      expect(fitting.isError).toBe(true);
      expect(firstText(fitting)).toContain("Input validation error");

      const quotedKey = '"\\'.repeat(350);
      const quoted = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present", [quotedKey]: true },
      });
      expect(quoted.isError).toBe(true);
      expect(firstText(quoted)).toContain("Input validation error");
      expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThan(4096);
      expect(records.exportEvidenceBundle().records).toHaveLength(1);

      const valid = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present" },
      });
      expect(valid.content).toContainEqual({
        type: "text",
        text: "valid call",
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("MCP activity journal", () => {
  it("records tool completion without caller arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-mcp-activity-"));
    activityRoots.push(root);
    const journal = new ActivityJournal(join(root, "activity.jsonl"));
    const server = new EvidenceMcpServer(
      { name: "activity-test", version: "1" },
      { capabilities: {} },
      undefined,
      new ToolResultDelivery(4096),
      undefined,
      false,
      journal,
    );
    server.registerTool(
      "activity_test_tool",
      { inputSchema: z.object({ value: z.string() }) },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const client = new Client({ name: "activity-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const progress: Array<{
        progress: number;
        total?: number | undefined;
      }> = [];
      await client.callTool(
        {
          name: "activity_test_tool",
          arguments: { value: "private-target-value" },
        },
        { onprogress: (update) => progress.push(update) },
      );
      await expect(journal.read()).resolves.toMatchObject([
        { tool: "activity_test_tool", status: "completed" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ progress: 0, total: 1 }),
          expect.objectContaining({ progress: 1, total: 1 }),
        ]),
      );
      await expect(journal.read()).resolves.not.toContainEqual(
        expect.objectContaining({ tool: "private-target-value" }),
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("emits periodic progress updates with estimated duration during execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-mcp-activity-periodic-"));
    activityRoots.push(root);
    const journal = new ActivityJournal(join(root, "activity.jsonl"));
    const server = new EvidenceMcpServer(
      { name: "activity-periodic-test", version: "1" },
      { capabilities: {} },
      undefined,
      new ToolResultDelivery(4096),
      undefined,
      false,
      journal,
    );
    server.registerTool(
      "long_running_tool",
      { inputSchema: z.object({}) },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { content: [{ type: "text", text: "done" }] };
      },
    );
    const client = new Client({ name: "periodic-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const updates: Array<{
        progress: number;
        total?: number | undefined;
        message?: string | undefined;
      }> = [];
      await client.callTool(
        {
          name: "long_running_tool",
          arguments: {},
        },
        { onprogress: (update) => updates.push(update) },
      );
      // Started (0), at least one periodic running update (>0 and <1), and Completed (1)
      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates[0]).toMatchObject({ progress: 0, total: 1 });
      expect(updates[updates.length - 1]).toMatchObject({
        progress: 1,
        total: 1,
      });
      for (const [index, update] of updates.entries()) {
        const previous = updates[index - 1];
        if (previous !== undefined)
          expect(update.progress).toBeGreaterThanOrEqual(previous.progress);
      }
      const middle = updates.slice(1, -1);
      expect(
        middle.some((u) => u.message?.includes("long_running_tool running")),
      ).toBe(true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  describe("extractEvidenceId", () => {
    it("extracts top-level evidence_id", () => {
      expect(extractEvidenceId({ evidence_id: "evi-123" })).toBe("evi-123");
    });

    it("extracts evidence_id from partial_observation in error details", () => {
      const result = {
        error: {
          details: {
            partial_observation: {
              kind: "retained-evidence",
              evidence_id: "evi-partial-456",
            },
          },
        },
      };
      expect(extractEvidenceId(result)).toBe("evi-partial-456");
    });

    it("extracts evidence_id from reported_limits evidence_reference in error details", () => {
      const result = {
        error: {
          details: {
            reported_limits: {
              evidence_reference: {
                kind: "retained-evidence",
                evidence_id: "evi-limits-789",
              },
            },
          },
        },
      };
      expect(extractEvidenceId(result)).toBe("evi-limits-789");
    });

    it("returns undefined when no evidence_id is present", () => {
      expect(extractEvidenceId(null)).toBeUndefined();
      expect(extractEvidenceId({})).toBeUndefined();
      expect(extractEvidenceId({ error: {} })).toBeUndefined();
    });
  });
});
