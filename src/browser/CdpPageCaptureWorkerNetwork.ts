import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  isHttpUrl,
  recordValue,
} from "./CdpCaptureValues.js";

/**
 * Bounds one capture's worker attachments and retained worker request
 * identities. Each admitted worker holds a browser session and two commands;
 * the request bound matches the script metadata record bound.
 */
export const CDP_WORKER_NETWORK_LIMITS = {
  workers: 256,
  requests: 50_000,
} as const;

/** Auto-attach dedicated workers on a session without pausing their start. */
const WORKER_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "worker" }],
} as const;

/** Chrome's reply for a command sent to a session that no longer exists. */
const SESSION_NOT_FOUND = -32_001;

/** Events that open a request or WebSocket lifecycle on one session. */
const REQUEST_START_EVENTS: ReadonlySet<string> = new Set([
  "Network.requestWillBeSent",
  "Network.webSocketCreated",
]);

interface WorkerNetworkContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
}

/**
 * Observe the network activity of the page's own dedicated workers.
 *
 * Chrome reports a dedicated worker's requests on the worker target rather
 * than on the page that created it. REA auto-attaches those workers, and the
 * workers they start, without pausing them, enables only their Network
 * domain, and routes their Network events through the page's origin policy.
 * Auto-attached sessions belong to the page session, so detaching the page
 * session also releases them.
 */
export class CdpWorkerNetworkObservation {
  /** Admitted worker sessions; each signal aborts when its session detaches. */
  readonly #workerSessions = new Map<string, AbortController>();
  readonly #requestSessions = new Map<string, string>();
  readonly #pending = new Set<Promise<void>>();
  #admittedWorkers = 0;
  #failure: { readonly cause: unknown } | undefined;
  #closed = false;

  constructor(
    private readonly context: WorkerNetworkContext,
    private readonly events: CdpCaptureEvents,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly limitations: string[],
  ) {}

  /** Auto-attach existing and new dedicated workers without pausing them. */
  async start(): Promise<void> {
    const result = await optionalCdpCommand(
      this.context,
      "Target.setAutoAttach",
      WORKER_AUTO_ATTACH,
      this.limitations,
    );
    if (result === undefined) {
      this.events.completeness.exclude(
        "network_requests",
        "provider_unavailable",
        null,
      );
      return;
    }
    this.limitations.push(
      "Dedicated worker network activity, including workers started by other workers, is observed from when REA attaches to each worker; requests a worker sends before then, and service or shared worker requests, are unavailable.",
    );
  }

  /** Track worker sessions and forward Network events of requests they started. */
  ingest(event: CdpEvent): void {
    const fromWorker =
      event.sessionId !== undefined &&
      this.#workerSessions.has(event.sessionId);
    if (event.sessionId === this.context.sessionId || fromWorker) {
      if (event.method === "Target.attachedToTarget") {
        this.#attached(event.params);
        return;
      }
      if (event.method === "Target.detachedFromTarget") {
        this.#detached(event.params);
        return;
      }
    }
    if (
      !fromWorker ||
      event.sessionId === undefined ||
      !event.method.startsWith("Network.")
    )
      return;
    const requestId = cdpStringValue(recordValue(event.params)?.requestId);
    if (requestId !== undefined) {
      const owner = this.#requestSessions.get(requestId);
      if (owner === undefined) {
        // Chrome announces a worker's own script on the page session and
        // completes it on the worker session. Keep page-owned records and
        // requests that began before attachment out of the worker lifecycle.
        if (
          !REQUEST_START_EVENTS.has(event.method) ||
          this.events.network.has(requestId) ||
          this.events.webSocketConnectionsById.has(requestId)
        )
          return;
        if (this.#requestSessions.size >= CDP_WORKER_NETWORK_LIMITS.requests) {
          this.events.completeness.exclude(
            "network_requests",
            "resource_budget_exhausted",
          );
          return;
        }
        this.#requestSessions.set(requestId, event.sessionId);
      } else if (owner !== event.sessionId) return;
    }
    this.events.ingest(event);
  }

  /**
   * Select the session that can return a request's response body. `undefined`
   * means the request came from a worker whose session has already detached.
   */
  responseBodySession(
    requestId: string,
  ): { readonly sessionId: string | undefined } | undefined {
    const workerSession = this.#requestSessions.get(requestId);
    if (workerSession === undefined)
      return { sessionId: this.context.sessionId };
    return this.#workerSessions.has(workerSession)
      ? { sessionId: workerSession }
      : undefined;
  }

  /** Surface transport or cancellation failures from worker commands issued so far. */
  async settle(): Promise<void> {
    await this.#drain();
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  /** Stop admitting workers and wait for issued commands before the session closes. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#drain();
  }

  #attached(value: unknown): void {
    const params = recordValue(value);
    const sessionId = cdpStringValue(params?.sessionId);
    const targetInfo = recordValue(params?.targetInfo);
    const type = cdpStringValue(targetInfo?.type);
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      targetInfo === undefined ||
      type === undefined
    ) {
      this.events.completeness.exclude(
        "network_requests",
        "invalid_protocol_value",
        null,
      );
      return;
    }
    // Browsers that ignore the auto-attach filter may still report frames.
    if (type !== "worker" || this.#closed) return;
    const rawUrl = cdpStringValue(targetInfo.url);
    if (allowedSanitizedUrl(rawUrl, this.allowedOrigins) === undefined) {
      this.events.completeness.exclude(
        "network_requests",
        rawUrl === undefined || rawUrl === ""
          ? "unattributed_origin"
          : isHttpUrl(rawUrl)
            ? "disallowed_origin"
            : "unsupported_url",
        null,
      );
      return;
    }
    if (this.#admittedWorkers >= CDP_WORKER_NETWORK_LIMITS.workers) {
      this.events.completeness.exclude(
        "network_requests",
        "resource_budget_exhausted",
      );
      return;
    }
    this.#admittedWorkers += 1;
    const detach = new AbortController();
    this.#workerSessions.set(sessionId, detach);
    this.#track(this.#observeWorker(sessionId, detach.signal));
  }

  #detached(value: unknown): void {
    const sessionId = cdpStringValue(recordValue(value)?.sessionId);
    if (sessionId === undefined) return;
    // Chrome does not answer commands pending on a session that detaches.
    this.#workerSessions.get(sessionId)?.abort();
    this.#workerSessions.delete(sessionId);
  }

  /** Enable the worker's Network domain, then auto-attach the workers it starts. */
  async #observeWorker(
    sessionId: string,
    detached: AbortSignal,
  ): Promise<void> {
    try {
      await this.#send("Network.enable", {}, sessionId, detached);
    } catch (cause: unknown) {
      this.#rejected(sessionId, cause, detached);
      this.#workerSessions.delete(sessionId);
      return;
    }
    try {
      await this.#send(
        "Target.setAutoAttach",
        WORKER_AUTO_ATTACH,
        sessionId,
        detached,
      );
    } catch (cause: unknown) {
      this.#rejected(sessionId, cause, detached);
    }
  }

  async #send(
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    sessionId: string,
    detached: AbortSignal,
  ): Promise<void> {
    await this.context.connection.send(
      method,
      parameters,
      sessionId,
      this.context.signal === undefined
        ? detached
        : AbortSignal.any([this.context.signal, detached]),
    );
  }

  /**
   * Classify a rejected worker command. A worker can exit before its session
   * accepts or answers commands; network coverage is already attach-limited,
   * so that does not invalidate the page capture. Any other rejection from a live
   * worker leaves its traffic unobserved and is reported as unavailable.
   * Transport and cancellation failures propagate.
   */
  #rejected(sessionId: string, cause: unknown, detached: AbortSignal): void {
    if (
      cause instanceof AnalysisCancelledError &&
      detached.aborted &&
      this.context.signal?.aborted !== true
    )
      return;
    if (!(cause instanceof CdpCommandRejection)) throw cause;
    if (
      !this.#workerSessions.has(sessionId) ||
      cause.code === SESSION_NOT_FOUND
    ) {
      this.#workerSessions.delete(sessionId);
      return;
    }
    this.events.completeness.exclude(
      "network_requests",
      "provider_unavailable",
    );
  }

  #track(operation: Promise<void>): void {
    const tracked: Promise<void> = operation
      .catch((cause: unknown) => {
        this.#failure ??= { cause };
      })
      .finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }
}
