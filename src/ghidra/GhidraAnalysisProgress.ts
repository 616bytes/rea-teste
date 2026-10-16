import { z } from "zod";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type { JsonValue } from "../domain/jsonValue.js";

const MAX_PROGRESS_MESSAGE_BYTES = 24 * 1024;
const POLL_INTERVAL_MS = 750;
const STATUS_INTERVAL_MS = 10_000;
const MAX_TRACKED_PROGRESS_PROCEDURES = 8_192;

const procedureSchema = z
  .object({
    address: z.string().min(1),
    value: z.string().min(1),
    procedure: z
      .object({
        external: z.boolean(),
        thunk: z.boolean(),
        thunk_target: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const snapshotSchema = z
  .object({
    status: z.enum(["analyzing", "finalizing", "complete"]),
    observed: z.number().int().nonnegative(),
    procedures: z.array(procedureSchema),
  })
  .strict();

type Snapshot = z.infer<typeof snapshotSchema>;
type SnapshotProcedure = Snapshot["procedures"][number];

interface ProgressProcedure {
  readonly address: string;
  readonly name: string;
  readonly kind: "Function" | "Thunk" | "External";
}

interface ProgressPayload {
  readonly status: Snapshot["status"];
  readonly observed: number;
  readonly procedures: readonly ProgressProcedure[];
}

function progressProcedure(procedure: SnapshotProcedure): ProgressProcedure {
  const kind = procedure.procedure.external
    ? "External"
    : procedure.procedure.thunk
      ? "Thunk"
      : "Function";
  return {
    address: procedure.address,
    name: procedure.value,
    kind,
  };
}

function changed(
  previous: SnapshotProcedure | undefined,
  next: SnapshotProcedure,
): boolean {
  return (
    previous === undefined ||
    previous.value !== next.value ||
    previous.procedure.external !== next.procedure.external ||
    previous.procedure.thunk !== next.procedure.thunk
  );
}

function encode(payload: ProgressPayload): string {
  return JSON.stringify(payload);
}

/** Coalesces raw bridge snapshots into bounded procedure updates for MCP progress. */
class GhidraAnalysisProgressTracker {
  readonly #observed = new Map<string, SnapshotProcedure>();
  readonly #pending = new Map<string, ProgressProcedure>();
  #status: Snapshot["status"] = "analyzing";
  #observedCount = 0;

  observe(value: JsonValue): boolean {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) return false;

    for (const procedure of parsed.data.procedures) {
      const previous = this.#observed.get(procedure.address);
      if (
        previous === undefined &&
        this.#observed.size >= MAX_TRACKED_PROGRESS_PROCEDURES
      )
        continue;

      if (changed(previous, procedure))
        this.#pending.set(procedure.address, progressProcedure(procedure));
      this.#observed.set(procedure.address, procedure);
    }

    this.#status = parsed.data.status;
    this.#observedCount = parsed.data.observed;
    return true;
  }

  nextMessage(forceStatus = false): string | undefined {
    if (this.#pending.size === 0 && !forceStatus) return undefined;

    const procedures: ProgressProcedure[] = [];
    for (const [address, procedure] of this.#pending) {
      const candidate = encode(this.#payload([...procedures, procedure]));
      if (Buffer.byteLength(candidate, "utf8") > MAX_PROGRESS_MESSAGE_BYTES) {
        if (procedures.length === 0) this.#pending.delete(address);
        break;
      }
      procedures.push(procedure);
      this.#pending.delete(address);
    }

    return encode(this.#payload(procedures));
  }

  #payload(procedures: readonly ProgressProcedure[]): ProgressPayload {
    return {
      status: this.#status,
      observed: this.#observedCount,
      procedures,
    };
  }
}

interface GhidraStartupProgressObserverOptions {
  readonly connected: () => boolean;
  readonly requestSnapshot: () => Promise<JsonValue | undefined>;
  readonly progress: ProgressReporter;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/** Polls connected analysis state while keeping progress failure observational. */
export class GhidraStartupProgressObserver {
  readonly #options: GhidraStartupProgressObserverOptions;
  readonly #tracker = new GhidraAnalysisProgressTracker();
  readonly #startedAt: number;
  #timer: NodeJS.Timeout | undefined;
  #lastReportedAt = Number.NEGATIVE_INFINITY;
  #active = false;

  constructor(options: GhidraStartupProgressObserverOptions) {
    this.#options = options;
    this.#startedAt = this.#now();
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#active = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay: number): void {
    if (!this.#active || this.#options.signal?.aborted === true) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#poll();
    }, delay);
  }

  async #poll(): Promise<void> {
    try {
      if (this.#options.connected()) await this.#reportAnalysisSnapshot();
      else await this.#reportWaitingStatus();
    } catch {
      // Progress delivery and snapshot polling cannot change startup truth.
    } finally {
      this.#schedule(POLL_INTERVAL_MS);
    }
  }

  async #reportAnalysisSnapshot(): Promise<void> {
    const snapshot = await this.#options.requestSnapshot();
    if (
      !this.#active ||
      this.#options.signal?.aborted === true ||
      snapshot === undefined ||
      !this.#tracker.observe(snapshot)
    )
      return;

    const now = this.#now();
    const message = this.#tracker.nextMessage(
      now - this.#lastReportedAt >= STATUS_INTERVAL_MS,
    );
    if (message === undefined) return;

    this.#lastReportedAt = now;
    await this.#options.progress.report({
      phase: "ghidra_analysis",
      completed: 0,
      total: null,
      message,
    });
  }

  async #reportWaitingStatus(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastReportedAt < STATUS_INTERVAL_MS) return;

    const elapsedSeconds = Math.floor((now - this.#startedAt) / 1000);
    this.#lastReportedAt = now;
    await this.#options.progress.report({
      phase: "ghidra_startup",
      completed: 0,
      total: null,
      message: `Waiting for Ghidra startup (${String(elapsedSeconds)}s elapsed); import and bridge preparation may still be pending`,
    });
  }

  #now(): number {
    return (this.#options.now ?? (() => performance.now()))();
  }
}
