import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  CDP_WORKER_NETWORK_LIMITS,
  CdpWorkerNetworkObservation,
} from "./CdpPageCaptureWorkerNetwork.js";

const origin = "http://127.0.0.1:43127";

const observation = () => {
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: origin,
    allowed_origins: [origin],
    target_id: "page",
  });
  const events = new CdpCaptureEvents(input, new Set([origin]));
  events.beginAuthorizedFrame("frame-main");
  const sent: {
    method: string;
    params: unknown;
    sessionId: string | undefined;
  }[] = [];
  const connection = {
    async send(method: string, params: unknown, sessionId?: string) {
      sent.push({ method, params, sessionId });
      return {};
    },
  } as unknown as CdpConnection;
  const workers = new CdpWorkerNetworkObservation(
    { connection, sessionId: "page-session" },
    events,
    new Set([origin]),
    [],
  );
  return { events, sent, workers };
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
});
