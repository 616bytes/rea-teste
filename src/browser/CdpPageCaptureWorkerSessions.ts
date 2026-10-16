import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import type { CdpNetworkEventSource } from "./CdpCaptureEventTypes.js";
import { cdpStringValue, recordValue } from "./CdpCaptureValues.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpEvent } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import type { CaptureContext } from "./CdpPageCapture.js";

/** Only this page's dedicated workers attach; every other child is excluded. */
const WORKER_FILTER = [
  { type: "worker", exclude: false },
  { exclude: true },
] as const;

/**
 * Multiplexes Network events from dedicated worker sessions that Chromium
 * flattens onto the page connection. Attaching a session never pauses or
 * otherwise alters the worker: auto-attach runs with
 * `waitForDebuggerOnStart` disabled, and only `Network.enable` is sent to the
 * worker session.
 */
export class CdpPageCaptureWorkerSessions {
  readonly #context: CaptureContext;
  readonly #limitations: string[];
  readonly #completeness: CdpCaptureCompleteness;
  readonly #workerTargets = new Map<string, string>();
  readonly #pendingEnables = new Set<Promise<void>>();
  #failure: { readonly cause: unknown } | undefined;

  constructor(
    context: CaptureContext,
    limitations: string[],
    completeness: CdpCaptureCompleteness,
  ) {
    this.#context = context;
    this.#limitations = limitations;
    this.#completeness = completeness;
  }

  /**
   * Ask Chromium to flatten this page's dedicated workers onto the connection.
   * Browsers without the command keep the capture working with worker network
   * activity unobserved and an explicit limitation.
   */
  async enable(): Promise<void> {
    const attached = await optionalCdpCommand(
      this.#context,
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: WORKER_FILTER,
      },
      this.#limitations,
    );
    if (attached === undefined) this.#completeness.attachLimited("workers");
  }

  /** Track child attach and detach notifications delivered on the page session. */
  observe(event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget")
      this.#admitWorkerSession(event.params);
    else if (event.method === "Target.detachedFromTarget")
      this.#releaseWorkerSession(event.params);
  }

  /** Worker attribution for events observed on one admitted worker session. */
  sourceFor(sessionId: string | undefined): CdpNetworkEventSource | undefined {
    const workerTargetId =
      sessionId === undefined ? undefined : this.#workerTargets.get(sessionId);
    return workerTargetId === undefined
      ? undefined
      : { worker_target_id: workerTargetId };
  }

  /** Session that currently observes the identified worker, if still attached. */
  sessionFor(workerTargetId: string): string | undefined {
    for (const [sessionId, targetId] of this.#workerTargets)
      if (targetId === workerTargetId) return sessionId;
    return undefined;
  }

  /**
   * Wait for every worker `Network.enable` sent so far. The first failure that
   * is not an expected worker termination is rethrown with its original error
   * semantics, because worker traffic would otherwise silently vanish.
   */
  async settle(): Promise<void> {
    while (this.#pendingEnables.size > 0)
      await Promise.all(this.#pendingEnables);
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  /**
   * Stop admitting workers and release the sessions this capture attached.
   * Best effort per command: the owning page-session detach and transport
   * close remain the definitive release boundary.
   */
  async release(): Promise<void> {
    await this.settle().catch(() => undefined);
    for (const sessionId of [...this.#workerTargets.keys()]) {
      await sendBestEffort(
        this.#context.connection,
        "Network.disable",
        {},
        sessionId,
      );
      await sendBestEffort(
        this.#context.connection,
        "Target.detachFromTarget",
        { sessionId },
        undefined,
      );
    }
    this.#workerTargets.clear();
    await sendBestEffort(
      this.#context.connection,
      "Target.setAutoAttach",
      { autoAttach: false, filter: WORKER_FILTER },
      this.#context.sessionId,
    );
  }

  #admitWorkerSession(params: unknown): void {
    const record = recordValue(params);
    const workerSessionId = cdpStringValue(record?.sessionId);
    const targetInfo = recordValue(record?.targetInfo);
    const type = cdpStringValue(targetInfo?.type);
    if (workerSessionId === undefined || workerSessionId.length === 0) {
      this.#completeness.exclude("workers", "invalid_protocol_value");
      return;
    }
    // The CDP filter should admit only dedicated workers; ignore any other
    // child target rather than claim observation it does not have.
    if (type === undefined || !type.includes("worker")) return;
    const workerTargetId = cdpStringValue(targetInfo?.targetId);
    if (workerTargetId === undefined || workerTargetId.length === 0) {
      this.#completeness.exclude("workers", "invalid_protocol_value");
      return;
    }
    if (this.#workerTargets.has(workerSessionId)) return;
    this.#workerTargets.set(workerSessionId, workerTargetId);
    const enabling = this.#enableWorkerNetwork(workerSessionId);
    this.#pendingEnables.add(enabling);
    void enabling.then(
      () => this.#pendingEnables.delete(enabling),
      () => this.#pendingEnables.delete(enabling),
    );
  }

  async #enableWorkerNetwork(workerSessionId: string): Promise<void> {
    try {
      await this.#context.connection.send(
        "Network.enable",
        {},
        workerSessionId,
        this.#context.signal,
      );
    } catch (cause: unknown) {
      if (
        cause instanceof CdpCommandRejection &&
        cause.code === -32_001 &&
        cause.reportedMessage === "Session with given id not found."
      ) {
        // The worker terminated between attach and enable; nothing to observe.
        this.#workerTargets.delete(workerSessionId);
        return;
      }
      this.#failure ??= { cause };
    }
  }

  #releaseWorkerSession(params: unknown): void {
    const sessionId = cdpStringValue(recordValue(params)?.sessionId);
    if (sessionId !== undefined) this.#workerTargets.delete(sessionId);
  }
}

const sendBestEffort = async (
  connection: CaptureContext["connection"],
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
): Promise<void> => {
  try {
    await connection.send(method, params, sessionId);
  } catch {
    // Best-effort release; the page-session detach and socket close own the
    // definitive boundary.
  }
};
