import { createServer, type Socket } from "node:net";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { WEB_RUNTIME_LIMITS } from "../../../src/domain/webRuntime.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";

// Exercise the real transport's production budget without waiting twenty seconds.
beforeEach(() => {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback,
    milliseconds,
    ...args
  ) =>
    schedule(
      callback,
      milliseconds === WEB_RUNTIME_LIMITS.commandTimeoutMs ? 100 : milliseconds,
      ...args,
    )) as typeof setTimeout);
});

afterEach(() => vi.restoreAllMocks());

it("bounds a stalled WebSocket handshake and releases its socket", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP address");
  try {
    await expect(
      CdpConnection.connect(
        `ws://127.0.0.1:${String(address.port)}/target`,
        "inspect_web_page",
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["Target.attachToTarget", "Page.enable", "Runtime.enable"])(
  "times out %s after HTTP discovery and closes the target session",
  async (hangOnMethod) => {
    const browser = await startFakeCdpBrowser({ hangOnMethod });
    try {
      const result = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
        { signal: AbortSignal.timeout(1_000) },
      );
      if (result.ok) throw new Error("Expected a target command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      expect(browser.commands.map(({ method }) => method)).toContain(
        hangOnMethod,
      );
      await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      await browser.close();
    }
  },
);

it("ignores a late timed-out reply and keeps following commands correlated", async () => {
  const browser = await startFakeCdpBrowser({ hangOnMethod: "Page.enable" });
  const connection = await CdpConnection.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
  );
  try {
    await expect(
      connection.send("Page.enable", {}, undefined, AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ reason: "timeout" });
    const command = browser.commands[0];
    if (command === undefined)
      throw new Error("Expected the timed-out command");
    browser.emitRawMessage(JSON.stringify({ id: command.id, result: {} }));
    await expect(connection.send("Runtime.enable")).resolves.toEqual({});
  } finally {
    await connection.close();
    await browser.close();
  }
});

it.each(["success", "rejection", "abort", "disconnect"])(
  "releases handshake and command timers on %s",
  async (outcome) => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const browser = await startFakeCdpBrowser({
      ...(outcome === "abort" ? { hangOnMethod: "Runtime.enable" } : {}),
      ...(outcome === "disconnect" ? { closeOnMethod: "Runtime.enable" } : {}),
    });
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
      controller.signal,
    );
    try {
      const pending = connection.send(
        outcome === "rejection" ? "Fixture.unmodeledMethod" : "Runtime.enable",
        {},
        undefined,
        controller.signal,
      );
      const assertion =
        outcome === "success"
          ? expect(pending).resolves.toEqual({})
          : expect(pending).rejects.toMatchObject({
              _tag:
                outcome === "abort"
                  ? "AnalysisCancelledError"
                  : "BrowserObservationError",
            });
      if (outcome === "abort") controller.abort();
      await assertion;
      const scheduled = vi.mocked(globalThis.setTimeout);
      const deadlines = scheduled.mock.calls.flatMap((call, index) =>
        call[1] === WEB_RUNTIME_LIMITS.commandTimeoutMs
          ? [scheduled.mock.results[index]?.value]
          : [],
      );
      expect(deadlines).toHaveLength(2);
      for (const timer of deadlines)
        expect(cleared).toHaveBeenCalledWith(timer);
      expect(removeAbort).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
      await browser.close();
    }
  },
);

it.each(["Runtime.enable", "Debugger.enable"])(
  "times out Inspector %s and preserves observations received before expiry",
  async (hangOnMethod) => {
    const inspector = await startFakeV8Inspector({
      targetUrl: "https://fixture.example/app.js",
      hangOnMethod,
    });
    try {
      const result = await new V8InspectorProvider().observe(
        {
          inspector_endpoint: inspector.endpoint,
          target_id: inspector.targetId,
          observation_ms: 0,
        },
        { signal: AbortSignal.timeout(1_000) },
      );
      if (result.ok) throw new Error("Expected an Inspector command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      expect(result.error.partialObservation).toMatchObject({
        capture: {
          events_observed: hangOnMethod === "Debugger.enable" ? 1 : 0,
        },
      });
    } finally {
      await inspector.close();
    }
  },
);

it("keeps the chosen observation window independent of command deadlines", async () => {
  const browser = await startFakeCdpBrowser();
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 250,
      }),
    );
    expect(result.ok).toBe(true);
  } finally {
    await browser.close();
  }
});
