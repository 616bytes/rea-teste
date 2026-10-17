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

/** An admitted worker session and the signal its detach fires. */
interface AdmittedWorkerSession {
  readonly targetId: string;
  readonly detach: AbortController;
}

/**
 * Bind one command to the capture's cancellation and a worker session's
 * detach signal, so commands to an exited worker settle immediately instead
 * of waiting out a transport deadline Chromium will never answer.
 */
export const workerCommandSignal = (
  capture: AbortSignal | undefined,
  workerDetach: AbortSignal,
): AbortSignal =>
  capture === undefined
    ? workerDetach
    : AbortSignal.any([capture, workerDetach]);

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
  readonly #workerTargets = new Map<string, AdmittedWorkerSession>();
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
    const worker =
      sessionId === undefined ? undefined : this.#workerTargets.get(sessionId);
    return worker === undefined
      ? undefined
      : { worker_target_id: worker.targetId };
  }

  /**
   * Session and detach signal that currently observe the identified worker,
   * if that worker is still attached.
   */
  admittedWorker(
    workerTargetId: string,
  ):
    | { readonly sessionId: string; readonly detachSignal: AbortSignal }
    | undefined {
    for (const [sessionId, worker] of this.#workerTargets)
      if (worker.targetId === workerTargetId)
        return { sessionId, detachSignal: worker.detach.signal };
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
   * One short deadline bounds the whole sequence when the browser keeps its
   * socket open but stops replying, as `cleanupCdpTargetCommands` bounds the
   * page session's cleanup; the owning page-session detach and transport
   * close remain the definitive release boundary.
   */
  async release(): Promise<void> {
    await this.settle().catch(() => undefined);
    const cleanup = new AbortController();
    const domainSignal =
      this.#context.signal === undefined
        ? cleanup.signal
        : AbortSignal.any([cleanup.signal, this.#context.signal]);
    const timeout = setTimeout(() => cleanup.abort(), 1_000);
    timeout.unref();
    try {
      if (this.#context.signal?.aborted !== true)
        for (const sessionId of [...this.#workerTargets.keys()]) {
          if (domainSignal.aborted) break;
          await sendBestEffort(
            this.#context.connection,
            "Network.disable",
            {},
            sessionId,
            domainSignal,
          );
        }
      // Cancellation skips optional worker shutdown but still releases the
      // attached sessions using the independent, bounded cleanup signal.
      for (const sessionId of [...this.#workerTargets.keys()]) {
        if (cleanup.signal.aborted) break;
        await sendBestEffort(
          this.#context.connection,
          "Target.detachFromTarget",
          { sessionId },
          undefined,
          cleanup.signal,
        );
      }
      this.#workerTargets.clear();
      await sendBestEffort(
        this.#context.connection,
        "Target.setAutoAttach",
        { autoAttach: false, filter: WORKER_FILTER },
        this.#context.sessionId,
        cleanup.signal,
      );
    } finally {
      clearTimeout(timeout);
      cleanup.abort();
    }
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
    const worker: AdmittedWorkerSession = {
      targetId: workerTargetId,
      detach: new AbortController(),
    };
    this.#workerTargets.set(workerSessionId, worker);
    const enabling = this.#enableWorkerNetwork(workerSessionId, worker);
    this.#pendingEnables.add(enabling);
    void enabling.then(
      () => this.#pendingEnables.delete(enabling),
      () => this.#pendingEnables.delete(enabling),
    );
  }

  async #enableWorkerNetwork(
    workerSessionId: string,
    worker: AdmittedWorkerSession,
  ): Promise<void> {
    try {
      await this.#context.connection.send(
        "Network.enable",
        {},
        workerSessionId,
        workerCommandSignal(this.#context.signal, worker.detach.signal),
      );
    } catch (cause: unknown) {
      if (
        worker.detach.signal.aborted ||
        (cause instanceof CdpCommandRejection &&
          cause.code === -32_001 &&
          cause.reportedMessage === "Session with given id not found.")
      ) {
        // The worker exited around the enable; nothing of it remains
        // observable, so keep the page capture intact.
        this.#workerTargets.delete(workerSessionId);
        return;
      }
      this.#failure ??= { cause };
    }
  }

  #releaseWorkerSession(params: unknown): void {
    const sessionId = cdpStringValue(recordValue(params)?.sessionId);
    if (sessionId === undefined) return;
    const worker = this.#workerTargets.get(sessionId);
    if (worker === undefined) return;
    this.#workerTargets.delete(sessionId);
    // Chromium leaves commands sent to a detached flat session unanswered;
    // aborting settles them now rather than at the transport deadline.
    worker.detach.abort();
  }
}

const sendBestEffort = async (
  connection: CaptureContext["connection"],
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  try {
    await connection.send(method, params, sessionId, signal);
  } catch {
    // Best-effort release under the shared cleanup deadline; the
    // page-session detach and socket close own the definitive boundary.
  }
};
