import { describe, expect, it, vi } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  CDP_WORKER_NETWORK_LIMITS,
  CdpWorkerNetworkObservation,
} from "./CdpPageCaptureWorkerNetwork.js";

const origin = "http://127.0.0.1:43127";

const observation = (
  options: {
    readonly includeWebSocketShapes?: boolean;
    readonly includeJsonBodyShapes?: boolean;
    readonly reply?: (
      sessionId: string | undefined,
      signal: AbortSignal | undefined,
      method: string,
    ) => Promise<unknown>;
  } = {},
) => {
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: origin,
    allowed_origins: [origin],
    target_id: "page",
    include_websocket_shapes: options.includeWebSocketShapes ?? false,
    include_json_body_shapes: options.includeJsonBodyShapes ?? false,
  });
  const events = new CdpCaptureEvents(input, new Set([origin]));
  events.beginAuthorizedFrame("frame-main");
  const sent: {
    method: string;
    params: unknown;
    sessionId: string | undefined;
  }[] = [];
  const connection = {
    async send(
      method: string,
      params: unknown,
      sessionId?: string,
      signal?: AbortSignal,
    ) {
      sent.push({ method, params, sessionId });
      return (await options.reply?.(sessionId, signal, method)) ?? {};
    },
  } as unknown as CdpConnection;
  const limitations: string[] = [];
  const workers = new CdpWorkerNetworkObservation(
    { connection, sessionId: "page-session" },
    events,
    new Set([origin]),
    limitations,
  );
  return { events, limitations, sent, workers };
};

const attached = (sessionId: string) => ({
  sessionId: "page-session",
  method: "Target.attachedToTarget",
  params: {
    sessionId,
    targetInfo: { targetId: sessionId, type: "worker", url: `${origin}/w.js` },
    waitingForDebugger: false,
  },
});

const requested = (sessionId: string, requestId: string) => ({
  sessionId,
  method: "Network.requestWillBeSent",
  params: {
    requestId,
    type: "Fetch",
    request: { url: `${origin}/data`, method: "GET" },
    initiator: { type: "script" },
  },
});

describe("CDP worker network admission", () => {
  it("admits at most the worker budget and counts omitted workers", async () => {
    const { events, sent, workers } = observation();
    await workers.start();
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.workers + 3;
      index += 1
    )
      workers.ingest(attached(`worker-${String(index)}`));
    await workers.settle();

    expect(
      sent.filter(({ method }) => method === "Network.enable"),
    ).toHaveLength(CDP_WORKER_NETWORK_LIMITS.workers);
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining(
        ["network_requests", "websocket_connections", "websocket_frames"].map(
          (section) => ({
            section,
            reason: "resource_budget_exhausted",
            count: null,
          }),
        ),
      ),
    );
    expect(events.completeness.snapshot().truncated_sections).toContain(
      "network_requests",
    );
    expect(
      sent
        .filter(({ method }) => method === "Target.detachFromTarget")
        .map(({ params, sessionId }) => [sessionId, params]),
    ).toEqual(
      [0, 1, 2].map((offset) => [
        "page-session",
        {
          sessionId: `worker-${String(CDP_WORKER_NETWORK_LIMITS.workers + offset)}`,
        },
      ]),
    );
  });

  it("stops retaining worker requests and WebSockets past the request budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.requests + 2;
      index += 1
    )
      workers.ingest(requested("worker-0", `request-${String(index)}`));

    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });

    expect(events.network.size).toBe(CDP_WORKER_NETWORK_LIMITS.requests);
    expect(events.webSocketConnectionsById.size).toBe(0);
    const { excluded, truncated_sections } = events.completeness.snapshot();
    expect(excluded).toEqual(
      expect.arrayContaining([
        {
          section: "network_requests",
          reason: "resource_budget_exhausted",
          count: 2,
        },
        {
          section: "websocket_connections",
          reason: "resource_budget_exhausted",
          count: 1,
        },
        {
          section: "websocket_frames",
          reason: "resource_budget_exhausted",
          count: null,
        },
      ]),
    );
    expect(truncated_sections).toEqual(
      expect.arrayContaining(["websocket_connections", "websocket_frames"]),
    );
  });

  it("bounds releases of refused workers and stops them after admission closes", async () => {
    const { sent, workers } = observation();
    await workers.start();
    const excess = CDP_WORKER_NETWORK_LIMITS.releases + 5;
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.workers + excess;
      index += 1
    )
      workers.ingest(attached(`worker-${String(index)}`));
    await workers.settle();
    workers.ingest(attached("after-settle"));
    await workers.close();

    const released = sent.filter(
      ({ method }) => method === "Target.detachFromTarget",
    );
    expect(released).toHaveLength(CDP_WORKER_NETWORK_LIMITS.releases);
    expect(released.map(({ params }) => params)).not.toContainEqual({
      sessionId: "after-settle",
    });
  });
});

describe("CDP worker network request ownership", () => {
  it("drops worker WebSocket frames past the frame budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.frames + 3;
      index += 1
    )
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.webSocketFrameReceived",
        params: {
          requestId: "socket-0",
          timestamp: index,
          response: { opcode: 1, mask: false, payloadData: "x" },
        },
      });

    expect(
      events.webSocketConnectionsById.get("socket-0")?.events,
    ).toHaveLength(CDP_WORKER_NETWORK_LIMITS.frames);
    const { dropped_events, truncated_sections } =
      events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(3);
    expect(truncated_sections).toContain("websocket_frames");
  });

  it("reports a worker request whose ID another session already owns", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    workers.ingest(attached("worker-1"));
    await workers.settle();
    events.ingest(requested("page-session", "page-owned"));
    workers.ingest(requested("worker-0", "page-owned"));
    workers.ingest(requested("worker-0", "worker-owned"));
    workers.ingest(requested("worker-1", "worker-owned"));
    workers.ingest({
      sessionId: "worker-1",
      method: "Network.webSocketCreated",
      params: { requestId: "worker-owned", url: "ws://127.0.0.1:43127/live" },
    });

    expect(events.network.size).toBe(2);
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining([
        {
          section: "network_requests",
          reason: "invalid_protocol_value",
          count: 2,
        },
        {
          section: "websocket_connections",
          reason: "invalid_protocol_value",
          count: 1,
        },
      ]),
    );
  });

  it("does not spend worker budgets on traffic the origin policy excludes", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const socket = (requestId: string, url: string) => ({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId, url },
    });
    const frame = (requestId: string, timestamp: number) => ({
      sessionId: "worker-0",
      method: "Network.webSocketFrameReceived",
      params: {
        requestId,
        timestamp,
        response: { opcode: 1, mask: false, payloadData: "x" },
      },
    });
    workers.ingest(socket("foreign-socket", "ws://foreign.example.test/live"));
    for (let index = 0; index < CDP_WORKER_NETWORK_LIMITS.frames; index += 1)
      workers.ingest(frame("foreign-socket", index));
    for (let index = 0; index < CDP_WORKER_NETWORK_LIMITS.requests; index += 1)
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.requestWillBeSent",
        params: {
          requestId: `foreign-${String(index)}`,
          type: "Fetch",
          request: { url: "https://foreign.example.test/data", method: "GET" },
          initiator: { type: "script" },
        },
      });
    workers.ingest(socket("allowed-socket", "ws://127.0.0.1:43127/live"));
    workers.ingest(frame("allowed-socket", 0));
    workers.ingest(requested("worker-0", "allowed-request"));

    expect(
      events.webSocketConnectionsById.get("allowed-socket")?.events,
    ).toHaveLength(1);
    expect(events.network.has("allowed-request")).toBe(true);
    const { dropped_events, excluded } = events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(0);
    expect(excluded).not.toContainEqual(
      expect.objectContaining({ reason: "resource_budget_exhausted" }),
    );
  });
});

describe("CDP worker network shapes, page ownership and malformed attachments", () => {
  it("bounds retained worker frame payload bytes when shapes are captured", async () => {
    const { events, workers } = observation({ includeWebSocketShapes: true });
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });
    const payloadData = JSON.stringify({ value: "x".repeat(1024 * 1024) });
    const payloadBytes = Buffer.byteLength(payloadData);
    const retained = Math.floor(
      CDP_WORKER_NETWORK_LIMITS.frameBytes / payloadBytes,
    );
    for (let index = 0; index < retained + 2; index += 1)
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.webSocketFrameReceived",
        params: {
          requestId: "socket-0",
          timestamp: index,
          response: { opcode: 1, mask: false, payloadData },
        },
      });

    expect(
      events.webSocketConnectionsById.get("socket-0")?.events,
    ).toHaveLength(retained);
    const { dropped_events, truncated_sections } =
      events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(2);
    expect(truncated_sections).toContain("websocket_frames");
  });

  it("keeps page Network events off a record a worker owns", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest(requested("worker-0", "shared-id"));
    const page = (method: string, params: Record<string, unknown>) => {
      const event = { sessionId: "page-session", method, params };
      if (workers.admitsPageEvent(event)) events.ingest(event);
    };
    page("Network.requestWillBeSent", {
      requestId: "shared-id",
      type: "Fetch",
      request: { url: `${origin}/page-data`, method: "POST" },
      initiator: { type: "script" },
    });
    page("Network.responseReceived", {
      requestId: "shared-id",
      response: {
        url: `${origin}/page-data`,
        status: 500,
        mimeType: "text/html",
      },
    });

    expect(events.network.get("shared-id")).toMatchObject({
      url: `${origin}/data`,
      method: "GET",
      status: null,
    });
    expect(workers.responseBodySession("shared-id")?.sessionId).toBe(
      "worker-0",
    );
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: 1,
    });
  });

  it("releases a malformed attachment that still names a session", async () => {
    const { events, sent, workers } = observation();
    await workers.start();
    workers.ingest({
      sessionId: "page-session",
      method: "Target.attachedToTarget",
      params: { sessionId: "malformed-session", waitingForDebugger: false },
    });
    await workers.settle();

    expect(sent).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "malformed-session" },
      sessionId: "page-session",
    });
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining(
        ["network_requests", "websocket_connections", "websocket_frames"].map(
          (section) => ({
            section,
            reason: "invalid_protocol_value",
            count: null,
          }),
        ),
      ),
    );
  });
});

describe("CDP worker network request bytes", () => {
  it("bounds retained worker request bytes and refunds excluded requests", async () => {
    const { events, workers } = observation({ includeJsonBodyShapes: true });
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const post = (requestId: string, url: string, postData: string) => ({
      sessionId: "worker-0",
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        type: "Fetch",
        request: {
          url,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          postData,
        },
        initiator: { type: "script" },
      },
    });
    workers.ingest(
      post(
        "foreign",
        `https://foreign.example.test/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes)}`,
        "{}",
      ),
    );
    const url = `${origin}/upload`;
    const postData = JSON.stringify({ value: "x".repeat(1024 * 1024) });
    const retained = Math.floor(
      CDP_WORKER_NETWORK_LIMITS.requestBytes /
        (Buffer.byteLength(url) + Buffer.byteLength(postData)),
    );
    for (let index = 0; index < retained + 2; index += 1)
      workers.ingest(post(`upload-${String(index)}`, url, postData));

    expect(events.network.size).toBe(retained);
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining([
        {
          section: "network_requests",
          reason: "resource_budget_exhausted",
          count: 2,
        },
        { section: "network_requests", reason: "disallowed_origin", count: 1 },
      ]),
    );
  });

  it("stops updating a worker request once a redirect hop is over budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest(requested("worker-0", "redirected"));
    const longUrl = `${origin}/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes)}`;
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.requestWillBeSent",
      params: {
        requestId: "redirected",
        type: "Fetch",
        request: { url: longUrl, method: "GET" },
        initiator: { type: "script" },
        redirectResponse: { url: `${origin}/data`, status: 302 },
      },
    });
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.responseReceived",
      params: {
        requestId: "redirected",
        response: { url: longUrl, status: 200, mimeType: "application/json" },
      },
    });

    expect(events.network.get("redirected")).toMatchObject({
      url: `${origin}/data`,
      status: null,
      mime_type: null,
      redirects: [],
    });
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "network_requests",
      reason: "resource_budget_exhausted",
      count: 1,
    });
  });

  it("counts allowed worker WebSocket URLs against the byte budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const socket = (requestId: string, url: string) => ({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId, url },
    });
    workers.ingest(
      socket(
        "oversized",
        `ws://127.0.0.1:43127/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes)}`,
      ),
    );
    workers.ingest(socket("small", "ws://127.0.0.1:43127/live"));

    expect(events.webSocketConnectionsById.has("oversized")).toBe(false);
    expect(events.webSocketConnectionsById.has("small")).toBe(true);
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "websocket_connections",
      reason: "resource_budget_exhausted",
      count: 1,
    });
  });
});

describe("CDP worker network refunds, JSON eligibility and nesting", () => {
  const post = (
    requestId: string,
    url: string,
    headers: Record<string, string> = {},
    postData?: string,
    redirectFrom?: string,
  ) => ({
    sessionId: "worker-0",
    method: "Network.requestWillBeSent",
    params: {
      requestId,
      type: "Fetch",
      request: {
        url,
        method: "POST",
        headers,
        ...(postData === undefined ? {} : { postData }),
      },
      initiator: { type: "script" },
      ...(redirectFrom === undefined
        ? {}
        : { redirectResponse: { url: redirectFrom, status: 302 } }),
    },
  });

  it("refunds every hop of a worker request the origin policy later drops", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const firstHop = `${origin}/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes / 4)}`;
    for (let index = 0; index < 6; index += 1) {
      const requestId = `bounced-${String(index)}`;
      workers.ingest(post(requestId, firstHop));
      workers.ingest(
        post(
          requestId,
          "https://foreign.example.test/away",
          {},
          undefined,
          firstHop,
        ),
      );
    }
    workers.ingest(requested("worker-0", "after"));

    expect(events.network.has("after")).toBe(true);
    expect(events.completeness.snapshot().excluded).not.toContainEqual(
      expect.objectContaining({ reason: "resource_budget_exhausted" }),
    );
  });

  it("does not charge worker request bodies that get no JSON shape", async () => {
    const { events, workers } = observation({ includeJsonBodyShapes: true });
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest(
      post(
        "upload",
        `${origin}/upload`,
        { "Content-Type": "text/plain" },
        "x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes),
      ),
    );

    expect(events.network.has("upload")).toBe(true);
    expect(events.completeness.snapshot().excluded).not.toContainEqual(
      expect.objectContaining({ reason: "resource_budget_exhausted" }),
    );
  });

  it("abandons a nested worker's commands when its parent worker detaches", async () => {
    const { workers } = observation({
      reply: async (sessionId, signal) =>
        sessionId !== "nested"
          ? {}
          : await new Promise((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => reject(new AnalysisCancelledError("inspect_web_page")),
                { once: true },
              ),
            ),
    });
    await workers.start();
    workers.ingest(attached("parent"));
    workers.ingest({
      sessionId: "parent",
      method: "Target.attachedToTarget",
      params: {
        sessionId: "nested",
        targetInfo: {
          targetId: "nested",
          type: "worker",
          url: `${origin}/n.js`,
        },
        waitingForDebugger: false,
      },
    });
    workers.ingest({
      sessionId: "page-session",
      method: "Target.detachedFromTarget",
      params: { sessionId: "parent" },
    });

    await expect(workers.settle()).resolves.toBeUndefined();
  });
});

describe("CDP worker network metadata, attachment state and accepted hops", () => {
  it("bounds expanding worker response metadata and keeps the response", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const respond = (requestId: string, link: string) => {
      workers.ingest(requested("worker-0", requestId));
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.responseReceived",
        params: {
          requestId,
          response: {
            url: `${origin}/data`,
            status: 200,
            mimeType: "text/plain",
            headers: { Link: link },
          },
        },
      });
    };
    const oneLink = `<${origin}/a.js>; rel=preload`;
    respond(
      "oversized",
      `${oneLink}, `.repeat(
        Math.ceil(CDP_WORKER_NETWORK_LIMITS.metadataBytes / oneLink.length),
      ),
    );
    respond("small", oneLink);

    expect(events.network.get("oversized")?.status).toBe(200);
    const metadata = new Map(
      events.responseMetadata.map((entry) => [entry.request_id, entry]),
    );
    expect(metadata.get("oversized")?.links).toEqual([]);
    expect(metadata.get("small")?.links).toHaveLength(1);
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "metadata",
      reason: "resource_budget_exhausted",
      count: 1,
    });
  });

  it("reports pre-attachment worker state instead of REA's own attachment", async () => {
    const { limitations, workers } = observation({
      reply: async (_sessionId, _signal, method) =>
        method === "Target.getTargets"
          ? {
              targetInfos: [
                {
                  targetId: "worker-0",
                  type: "worker",
                  url: `${origin}/w.js`,
                  attached: false,
                },
              ],
            }
          : {},
    });
    await workers.start();
    workers.ingest(attached("worker-0"));
    workers.ingest(attached("late"));
    await workers.settle();

    expect(workers.workerAttachment("worker-0", true)).toBe(false);
    expect(workers.workerAttachment("unrelated", true)).toBe(true);
    expect(workers.workerAttachment("late", true)).toBe(true);
    expect(limitations).toContainEqual(
      expect.stringContaining("started after REA attached"),
    );
  });

  it("refunds a worker request hop the capture rejects", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const third = `${origin}/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.requestBytes / 3)}`;
    workers.ingest(requested("worker-0", "reused"));
    for (let index = 0; index < 2; index += 1)
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.requestWillBeSent",
        params: {
          requestId: "reused",
          type: "Fetch",
          request: { url: third, method: "GET" },
          initiator: { type: "script" },
        },
      });
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.requestWillBeSent",
      params: {
        requestId: "after",
        type: "Fetch",
        request: { url: third, method: "GET" },
        initiator: { type: "script" },
      },
    });

    expect(events.network.has("after")).toBe(true);
    expect(events.completeness.snapshot().excluded).not.toContainEqual(
      expect.objectContaining({ reason: "resource_budget_exhausted" }),
    );
  });

  it("leaves malformed body envelopes to the body parser without charging", async () => {
    const { workers } = observation({ includeJsonBodyShapes: true });
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest(requested("worker-0", "malformed"));
    workers.ingest(requested("worker-0", "valid"));

    expect(
      workers.admitsResponseBody("malformed", {
        body: "x".repeat(CDP_WORKER_NETWORK_LIMITS.responseBytes + 1),
      }),
    ).toBe(true);
    expect(
      workers.admitsResponseBody("valid", {
        body: "x".repeat(CDP_WORKER_NETWORK_LIMITS.responseBytes),
        base64Encoded: false,
      }),
    ).toBe(true);
  });
});

/** An observation with one admitted worker, `worker-0`. */
const admitted = async (options: Parameters<typeof observation>[0] = {}) => {
  const created = observation(options);
  await created.workers.start();
  created.workers.ingest(attached("worker-0"));
  await created.workers.settle();
  return created;
};

describe("CDP worker network retained strings", () => {
  const sixtyPercent = Math.ceil(
    (CDP_WORKER_NETWORK_LIMITS.requestBytes * 3) / 5,
  );

  it("charges request methods and initiator URLs to the request budget", async () => {
    for (const field of ["method", "initiator"] as const) {
      const { events, workers } = await admitted();
      for (const requestId of ["first", "second"])
        workers.ingest({
          sessionId: "worker-0",
          method: "Network.requestWillBeSent",
          params: {
            requestId,
            type: "Fetch",
            request: {
              url: `${origin}/data`,
              method: field === "method" ? "M".repeat(sixtyPercent) : "GET",
            },
            initiator:
              field === "initiator"
                ? {
                    type: "script",
                    url: `${origin}/${"x".repeat(sixtyPercent)}`,
                  }
                : { type: "script" },
          },
        });

      expect(events.network.has("first")).toBe(true);
      expect(events.network.has("second")).toBe(false);
      expect(events.completeness.snapshot().excluded).toContainEqual({
        section: "network_requests",
        reason: "resource_budget_exhausted",
        count: 1,
      });
    }
  });

  it("charges response MIME types and kept header values to the metadata budget", async () => {
    const { events, workers } = await admitted();
    const respond = (requestId: string, response: Record<string, unknown>) => {
      workers.ingest(requested("worker-0", requestId));
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.responseReceived",
        params: {
          requestId,
          response: { url: `${origin}/data`, status: 200, ...response },
        },
      });
    };
    respond("long-type", {
      mimeType: `text/${"x".repeat(CDP_WORKER_NETWORK_LIMITS.metadataBytes)}`,
    });
    respond("long-encoding", {
      mimeType: "text/plain",
      headers: {
        "Content-Encoding": "x".repeat(CDP_WORKER_NETWORK_LIMITS.metadataBytes),
      },
    });
    respond("small", {
      mimeType: "text/plain",
      headers: { "Content-Encoding": "gzip" },
    });

    expect(events.network.get("long-type")).toMatchObject({
      status: 200,
      mime_type: null,
    });
    const metadata = new Map(
      events.responseMetadata.map((entry) => [entry.request_id, entry]),
    );
    expect(metadata.get("long-encoding")?.content_encoding).toBeNull();
    expect(metadata.get("small")?.content_encoding).toBe("gzip");
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "metadata",
      reason: "resource_budget_exhausted",
      count: 2,
    });
  });

  it("keeps binary worker frames outside the shape payload budget", async () => {
    const { events, workers } = await admitted({
      includeWebSocketShapes: true,
    });
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketFrameReceived",
      params: {
        requestId: "socket-0",
        timestamp: 0,
        response: {
          opcode: 2,
          mask: false,
          payloadData: Buffer.alloc(
            CDP_WORKER_NETWORK_LIMITS.frameBytes + 3,
          ).toString("base64"),
        },
      },
    });

    expect(
      events.webSocketConnectionsById.get("socket-0")?.events,
    ).toHaveLength(1);
    expect(events.completeness.snapshot().dropped_events.websocket_frames).toBe(
      0,
    );
  });
});

describe("CDP worker network metadata and JSON shapes", () => {
  it("reports a JSON response shape lost to the metadata budget", async () => {
    const { events, workers } = await admitted({ includeJsonBodyShapes: true });
    workers.ingest(requested("worker-0", "json"));
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.responseReceived",
      params: {
        requestId: "json",
        response: {
          url: `${origin}/data`,
          status: 200,
          mimeType: "application/json",
          headers: {
            Link: "x".repeat(CDP_WORKER_NETWORK_LIMITS.metadataBytes),
          },
        },
      },
    });
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.loadingFinished",
      params: { requestId: "json", encodedDataLength: 2 },
    });

    expect(events.responseBodyRequests()).toEqual([]);
    expect(events.network.get("json")?.body_shapes.response).toBeNull();
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining([
        {
          section: "metadata",
          reason: "resource_budget_exhausted",
          count: 1,
        },
        {
          section: "json_body_shapes",
          reason: "resource_budget_exhausted",
          count: 1,
        },
      ]),
    );
  });

  it("sizes base64 bodies from their text without decoding rejected ones", async () => {
    const { workers } = await admitted({ includeJsonBodyShapes: true });
    workers.ingest(requested("worker-0", "fits"));
    workers.ingest(requested("worker-0", "oversized"));
    const fits = Buffer.alloc(
      CDP_WORKER_NETWORK_LIMITS.responseBytes - 1,
    ).toString("base64");
    const oversized = Buffer.alloc(2).toString("base64");
    const decode = vi.spyOn(Buffer, "from");
    try {
      expect(
        workers.admitsResponseBody("fits", { body: fits, base64Encoded: true }),
      ).toBe(true);
      expect(
        workers.admitsResponseBody("oversized", {
          body: oversized,
          base64Encoded: true,
        }),
      ).toBe(false);
      expect(
        // Buffer.from is overloaded; the spy types only its first signature.
        (decode.mock.calls as readonly (readonly unknown[])[]).filter(
          (call) => call[1] === "base64",
        ),
      ).toEqual([]);
    } finally {
      decode.mockRestore();
    }
  });

  it("releases a worker attachment that omits its target ID", async () => {
    const { events, sent, workers } = observation();
    await workers.start();
    workers.ingest({
      sessionId: "page-session",
      method: "Target.attachedToTarget",
      params: {
        sessionId: "anonymous",
        targetInfo: { type: "worker", url: `${origin}/w.js` },
        waitingForDebugger: false,
      },
    });
    await workers.settle();

    expect(sent).not.toContainEqual(
      expect.objectContaining({
        method: "Network.enable",
        sessionId: "anonymous",
      }),
    );
    expect(sent).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "anonymous" },
      sessionId: "page-session",
    });
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: null,
    });
  });
});
