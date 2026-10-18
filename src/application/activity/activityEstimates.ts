import type { ActivityRecord, ActivityStatus } from "./ActivityJournal.js";

export const DEFAULT_ESTIMATE_MS = 30_000;

export interface ActivityProgressEstimate {
  readonly activity_id: string;
  readonly tool: string;
  readonly status: ActivityStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
  readonly elapsed_ms?: number;
  readonly estimate_ms: number;
  readonly progress_percent: number;
  readonly remaining_ms: number;
  readonly elapsed_formatted: string;
  readonly eta_formatted: string;
  readonly evidence_id?: string;
}

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return DEFAULT_ESTIMATE_MS;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? DEFAULT_ESTIMATE_MS;
};

export const estimateFor = (
  tool: string,
  records: readonly ActivityRecord[],
  fallbackMs = DEFAULT_ESTIMATE_MS,
): number => {
  const sameTool = records
    .filter(
      (record) =>
        record.tool === tool &&
        record.status === "completed" &&
        record.duration_ms !== undefined,
    )
    .map((record) => record.duration_ms as number);
  if (sameTool.length > 0) return median(sameTool);

  const completed = records
    .filter(
      (record) =>
        record.status === "completed" && record.duration_ms !== undefined,
    )
    .map((record) => record.duration_ms as number);
  return completed.length > 0 ? median(completed) : fallbackMs;
};

export const elapsedMs = (
  record: Pick<ActivityRecord, "started_at" | "status"> &
    Partial<Pick<ActivityRecord, "duration_ms">>,
  now = Date.now(),
): number | undefined => {
  if (record.duration_ms !== undefined) return record.duration_ms;
  if (record.status === "running")
    return Math.max(0, now - Date.parse(record.started_at));
  return undefined;
};

export const formatDuration = (durationMs: number): string => {
  const seconds = Math.floor(Math.max(0, durationMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

export const calculateProgress = (
  elapsed: number,
  estimate: number,
): {
  readonly progressPercent: number;
  readonly remainingMs: number;
  readonly elapsedFormatted: string;
  readonly etaFormatted: string;
} => {
  const safeEstimate = Math.max(1, estimate);
  const progressPercent = Math.min(
    95,
    Math.floor((elapsed / safeEstimate) * 100),
  );
  const remainingMs = Math.max(0, safeEstimate - elapsed);
  return {
    progressPercent,
    remainingMs,
    elapsedFormatted: formatDuration(elapsed),
    etaFormatted: formatDuration(remainingMs),
  };
};

export const estimateActivity = (
  record: ActivityRecord,
  records: readonly ActivityRecord[],
  now = Date.now(),
): ActivityProgressEstimate => {
  const elapsed = elapsedMs(record, now);
  const estimate = estimateFor(record.tool, records);
  const isRunning = record.status === "running";
  const progress =
    isRunning && elapsed !== undefined
      ? calculateProgress(elapsed, estimate)
      : {
          progressPercent: record.status === "completed" ? 100 : 0,
          remainingMs: 0,
          elapsedFormatted:
            elapsed !== undefined ? formatDuration(elapsed) : "-",
          etaFormatted: isRunning ? formatDuration(estimate) : "0s",
        };

  return {
    activity_id: record.activity_id,
    tool: record.tool,
    status: record.status,
    started_at: record.started_at,
    ...(record.finished_at ? { finished_at: record.finished_at } : {}),
    ...(record.duration_ms !== undefined
      ? { duration_ms: record.duration_ms }
      : {}),
    ...(elapsed !== undefined ? { elapsed_ms: elapsed } : {}),
    estimate_ms: estimate,
    progress_percent: progress.progressPercent,
    remaining_ms: progress.remainingMs,
    elapsed_formatted: progress.elapsedFormatted,
    eta_formatted: progress.etaFormatted,
    ...(record.evidence_id ? { evidence_id: record.evidence_id } : {}),
  };
};
