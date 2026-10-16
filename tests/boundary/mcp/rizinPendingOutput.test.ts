import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { createInjectedProcess } from "../providers/RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "../providers/RizinTestInferiorTty.js";

const test = it.skipIf(process.platform === "win32");

test.each(["exit", "deadline", "framed-exit"] as const)(
  "retains received command bytes through MCP after %s",
  async (mode) => {
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        setImmediate(() => {
          control.output("complete prefix\0unfinished diagnostic Ω");
          if (mode === "framed-exit") control.output("\0");
          if (mode !== "deadline") control.exit();
        });
      },
    });
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        frameTimeoutMs: 100,
      },
    );
    const server = new McpServer({ name: "rizin-partial-test", version: "1" });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "rizin-partial-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const startReply = await client.callTool({
        name: "start_rizin_debug_session",
        arguments: {
          path: "fixture.bin",
          inferior_tty: await rizinTestInferiorTty(),
        },
      });
      expect(startReply.isError).not.toBe(true);
      const started = toolContract(
        "start_rizin_debug_session",
      ).outputSchema.parse(startReply.structuredContent);
      const reply = await client.callTool({
        name: "rizin_debug_command",
        arguments: { session_id: started.session_id, command: "dr" },
      });
      expect(reply.isError).not.toBe(true);
      const expected = {
        output: "complete prefix\nunfinished diagnostic Ω",
        completion_status: "unknown",
        output_truncated: mode === "deadline",
      };
      expect(reply.structuredContent).toMatchObject({
        normalized_result: expected,
        raw_result: expected,
      });
    } finally {
      injected.control.exit();
      await client.close();
      await server.close();
      await manager.closeAll();
    }
  },
);

test.each([
  { mode: "exit", maximum: 10, invalid: true, expected: "first\n�A" },
  { mode: "cancel", maximum: 9, invalid: true, expected: "first\n�" },
  { mode: "exit", maximum: 9, invalid: false, expected: "first\n�" },
  { mode: "cancel", maximum: 8, invalid: true, expected: "first" },
])(
  "bounds pending UTF-8 after $mode (budget: $maximum, invalid: $invalid)",
  async ({ mode, maximum, invalid, expected }) => {
    const controller = new AbortController();
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        if (!text.includes("!echo __REA_COMMAND_COMPLETE_")) return;
        control.output(
          Buffer.concat([
            Buffer.from("first\0"),
            invalid ? Buffer.from([0xff]) : Buffer.from("�"),
            Buffer.from("ABCDEFGHIJKLM"),
          ]),
        );
        if (mode === "exit") control.exit();
        else controller.abort();
      },
    });
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        maxCommandOutputBytes: maximum,
      },
    );
    try {
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: await rizinTestInferiorTty(),
      });
      if (!started.ok) throw started.error;
      const result = await manager.execute(
        started.value.session_id,
        "dr",
        controller.signal,
      );
      const evidence = result.ok
        ? result.value.evidence
        : result.error.partialObservation;
      expect(evidence).toMatchObject({
        normalized_result: {
          output: expected,
          output_truncated: true,
          completion_status: "unknown",
        },
        raw_result: { output: expected, output_truncated: true },
      });
      if (invalid)
        expect(evidence).toMatchObject({
          normalized_result: { output_invalid_utf8: true },
        });
      else
        expect(evidence).not.toHaveProperty(
          "normalized_result.output_invalid_utf8",
        );
      if (!result.ok) expect(result.error.capturedOutput?.truncated).toBe(true);
      expect(
        manager.status(started.value.session_id)?.output_invalid_utf8,
      ).toBe(invalid);
    } finally {
      injected.control.exit();
      await manager.closeAll();
    }
  },
);

test("rejects an unfinished unsolicited frame before command dispatch", async () => {
  let dispatched = false;
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      const marker = /!echo (__REA_COMMAND_COMPLETE_\w+)/u.exec(text)?.[1];
      if (marker === undefined) return;
      dispatched = true;
      setImmediate(() => control.output(`new command\0${marker}\n\0`));
    },
  });
  const manager = createRizinTestManager(
    {},
    { spawnProcess: injected.spawnProcess },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    injected.control.output("unclaimed old output");
    const result = await manager.execute(started.value.session_id, "dr");
    expect(result.ok).toBe(false);
    expect(dispatched).toBe(false);
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});

test("publishes the bounded prefix when an oversized frame has no terminator", async () => {
  const injected = createInjectedProcess({
    onWrite: (text, control) => {
      if (text.includes("!echo __REA_COMMAND_COMPLETE_"))
        setImmediate(() =>
          control.output(Buffer.alloc(16 * 1024 * 1024 + 1, "x")),
        );
    },
  });
  const manager = createRizinTestManager(
    {},
    {
      spawnProcess: injected.spawnProcess,
      maxCommandOutputBytes: 20,
      frameTimeoutMs: 100,
    },
  );
  try {
    const started = await manager.start({
      path: "fixture.bin",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const result = await manager.execute(started.value.session_id, "dr");
    if (!result.ok) throw result.error;
    expect(result.value.evidence).toMatchObject({
      normalized_result: {
        output: "x".repeat(20),
        output_truncated: true,
        completion_status: "unknown",
      },
    });
  } finally {
    injected.control.exit();
    await manager.closeAll();
  }
});
