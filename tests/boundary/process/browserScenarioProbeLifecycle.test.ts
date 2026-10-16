import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import type { BrowserScenario } from "../../../src/domain/browserScenario.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  FAKE_BROWSER_SCENARIO_PROVIDER_IDENTITY,
  fakeBrowserScenarioCapture,
} from "../../fixtures/browserScenarioCapture.js";
import { createBrowserObservationProvider } from "../../../src/composition/browserObservation.js";
import { createElectronObservationProvider } from "../../../src/composition/electronObservation.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("keeps the shared browser scenario provider open when the SDK discards its discovery probe", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const scenarioClose = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Scenario cleanup failed"))
    .mockResolvedValue(undefined);
  const browserObservation = createBrowserObservationProvider();
  const browserClose = vi
    .spyOn(browserObservation, "close")
    .mockResolvedValue(undefined);
  const electronObservation = createElectronObservationProvider();
  const electronClose = vi
    .spyOn(electronObservation, "close")
    .mockResolvedValue(undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async () => {
      throw new Error("Unexpected scenario capture");
    },
    close: scenarioClose,
  };
  const factories: Parameters<RuntimeDependencies["serve"]>[0][] = [];
  const runtime: RuntimeDependencies = {
    env: {},
    serve: (factory) => {
      factories.push(factory);
      return { close: async () => undefined };
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(runtime, session, {
    logger: silentLogger,
    serverLogger: silentLogger,
    environment: runtime.env,
    delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    loadOptionalProviders: async () => ({
      browserObservation,
      browserScenarioCapture,
      electronObservation,
    }),
  });
  if (!transport.ok) throw new Error("Transport failed");
  const factory = factories[0];
  if (factory === undefined) throw new Error("Missing SDK server factory");
  try {
    const probe = await factory({ era: "modern" });
    await probe.close();
    const replacement = await factory({ era: "legacy" });
    await replacement.close();
    expect(browserClose).not.toHaveBeenCalled();
    expect(scenarioClose).not.toHaveBeenCalled();
    expect(electronClose).not.toHaveBeenCalled();

    await expect(transport.closeOptionalProviders()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "Scenario cleanup failed" })],
    });
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(scenarioClose).toHaveBeenCalledTimes(1);
    expect(electronClose).toHaveBeenCalledTimes(1);
    await transport.closeOptionalProviders();
    await transport.closeOptionalProviders();
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(scenarioClose).toHaveBeenCalledTimes(2);
    expect(electronClose).toHaveBeenCalledTimes(1);
  } finally {
    await transport.closeAndroid();
    await session.close();
  }
});

it("closes optional providers when MCP server startup throws", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const scenarioClose = vi.fn(async () => undefined);
  const browserObservation = createBrowserObservationProvider();
  const browserClose = vi
    .spyOn(browserObservation, "close")
    .mockResolvedValue(undefined);
  const electronObservation = createElectronObservationProvider();
  const electronClose = vi
    .spyOn(electronObservation, "close")
    .mockResolvedValue(undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async () => {
      throw new Error("Unexpected scenario capture");
    },
    close: scenarioClose,
  };
  const runtime: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("Server startup failed");
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  try {
    const transport = await startMcpTransport(runtime, session, {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: runtime.env,
      delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
      loadOptionalProviders: async () => ({
        browserObservation,
        browserScenarioCapture,
        electronObservation,
      }),
    });

    expect(transport).toEqual({ ok: false });
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(scenarioClose).toHaveBeenCalledTimes(1);
    expect(electronClose).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});

const wireReplySchema = z.looseObject({ id: z.number() });
type WireReply = z.infer<typeof wireReplySchema>;

/** Resolve newline-delimited JSON-RPC replies from a server's stdout by id. */
const collectWireReplies = (
  stdout: PassThrough,
): ((id: number) => Promise<WireReply>) => {
  const replies = new Map<number, WireReply>();
  const waiters = new Map<number, (reply: WireReply) => void>();
  let buffered = "";
  stdout.on("data", (chunk: Buffer | string) => {
    buffered += String(chunk);
    for (
      let newline = buffered.indexOf("\n");
      newline >= 0;
      newline = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === "") continue;
      // Notifications carry no id and are not awaited here.
      const reply = wireReplySchema.safeParse(JSON.parse(line) as unknown);
      if (!reply.success) continue;
      replies.set(reply.data.id, reply.data);
      waiters.get(reply.data.id)?.(reply.data);
    }
  });
  return (id) => {
    const known = replies.get(id);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => waiters.set(id, resolve));
  };
};

it("keeps capture_browser_scenario available on the pinned server after the SDK discards its discovery probe", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const scenarios: BrowserScenario[] = [];
  const scenarioClose = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => FAKE_BROWSER_SCENARIO_PROVIDER_IDENTITY,
    captureScenario: async (scenario) => {
      scenarios.push(scenario);
      return ok(fakeBrowserScenarioCapture(scenario));
    },
    close: scenarioClose,
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reply = collectWireReplies(stdout);
  const send = (message: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(message)}\n`);
  };
  let serverInstances = 0;
  const started = await startMcpTransport(
    {
      env: {},
      // The production stdio entry owns the era decision; only the wire is
      // replaced so the probe/discard sequence runs exactly as over a pipe.
      serve: (factory, options) =>
        serveStdio(factory, {
          ...options,
          transport: new StdioServerTransport(stdin, stdout),
        }),
      createServer: (source, options) => {
        serverInstances += 1;
        return createServer(source, options);
      },
      writeStderr: () => undefined,
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
    },
    session,
    {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: {},
      delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
      loadOptionalProviders: async () => ({ browserScenarioCapture }),
    },
  );
  if (!started.ok) throw new Error("Transport failed");
  try {
    // A modern client opens with server/discover, which the SDK serves from an
    // optimistic probe instance.
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    });
    expect(await reply(1)).toMatchObject({
      result: { supportedVersions: expect.any(Array) },
    });
    expect(serverInstances).toBe(1);

    // A legacy initialize on the same connection makes the SDK discard that
    // probe instance (closing it) and pin a replacement.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "probe-discard", version: "1.0.0" },
      },
    });
    expect(await reply(2)).toMatchObject({
      result: { serverInfo: { name: "rea" } },
    });
    expect(serverInstances).toBe(2);
    expect(scenarioClose).not.toHaveBeenCalled();

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "capture_browser_scenario",
        arguments: {
          browser: { mode: "launch", executable_path: process.execPath },
          start_url: { url: "https://app.example.test/", query: [] },
          actions: [
            { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
          ],
        },
      },
    });
    const captured = await reply(3);
    expect(captured, JSON.stringify(captured)).toMatchObject({
      result: {
        structuredContent: {
          normalized_result: { browser: { product: "Test Browser" } },
        },
      },
    });
    expect(captured).not.toHaveProperty("result.isError", true);
    expect(scenarios.map((scenario) => scenario.start_url.url)).toEqual([
      "https://app.example.test/",
    ]);
    expect(scenarioClose).not.toHaveBeenCalled();

    // Connection shutdown closes server instances, not the shared provider;
    // only process shutdown closes it, exactly once.
    await started.handle.close();
    expect(scenarioClose).not.toHaveBeenCalled();
    await started.closeOptionalProviders();
    expect(scenarioClose).toHaveBeenCalledTimes(1);
    await started.closeOptionalProviders();
    expect(scenarioClose).toHaveBeenCalledTimes(1);
  } finally {
    await started.handle.close();
    await started.closeAndroid();
    await started.closeOptionalProviders();
    await session.close();
    stdin.destroy();
    stdout.destroy();
  }
});
