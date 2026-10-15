import { describe, expect, it } from "vitest";
import type { ActivityRecord } from "./ActivityJournal.js";
import {
  calculateProgress,
  DEFAULT_ESTIMATE_MS,
  elapsedMs,
  estimateActivity,
  estimateFor,
  formatDuration,
  median,
} from "./activityEstimates.js";

describe("activityEstimates", () => {
  it("calculates median duration correctly", () => {
    expect(median([])).toBe(DEFAULT_ESTIMATE_MS);
    expect(median([1000])).toBe(1000);
    expect(median([1000, 3000, 2000])).toBe(2000);
    expect(median([1000, 4000, 2000, 3000])).toBe(3000);
  });

  it("formats duration readable in seconds and minutes", () => {
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(15_000)).toBe("15s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(125_000)).toBe("2m05s");
  });

  it("calculates progress and ETA accurately", () => {
    const { progressPercent, remainingMs, elapsedFormatted, etaFormatted } =
      calculateProgress(10_000, 40_000);
    expect(progressPercent).toBe(25);
    expect(remainingMs).toBe(30_000);
    expect(elapsedFormatted).toBe("10s");
    expect(etaFormatted).toBe("30s");
  });

  it("caps running progress percent at 95%", () => {
    const { progressPercent, remainingMs } = calculateProgress(50_000, 30_000);
    expect(progressPercent).toBe(95);
    expect(remainingMs).toBe(0);
  });

  it("estimates tool runtime from previous completed records", () => {
    const records: ActivityRecord[] = [
      {
        activity_id: "1",
        tool: "analyze_function",
        status: "completed",
        started_at: "2026-10-15T00:00:00Z",
        duration_ms: 10_000,
      },
      {
        activity_id: "2",
        tool: "analyze_function",
        status: "completed",
        started_at: "2026-10-15T00:01:00Z",
        duration_ms: 20_000,
      },
      {
        activity_id: "3",
        tool: "other_tool",
        status: "completed",
        started_at: "2026-10-15T00:02:00Z",
        duration_ms: 5_000,
      },
    ];

    expect(estimateFor("analyze_function", records)).toBe(20_000);
    expect(estimateFor("unknown_tool", records)).toBe(10_000); // fallback to median of completed
  });

  it("produces a comprehensive ActivityProgressEstimate", () => {
    const now = 1_000_000;
    const runningRecord: ActivityRecord = {
      activity_id: "act-1",
      tool: "binary_overview",
      status: "running",
      started_at: new Date(now - 10_000).toISOString(),
    };
    const completedRecords: ActivityRecord[] = [
      {
        activity_id: "act-0",
        tool: "binary_overview",
        status: "completed",
        started_at: new Date(now - 60_000).toISOString(),
        duration_ms: 20_000,
      },
    ];

    const estimate = estimateActivity(runningRecord, completedRecords, now);
    expect(estimate.tool).toBe("binary_overview");
    expect(estimate.status).toBe("running");
    expect(estimate.elapsed_ms).toBe(10_000);
    expect(estimate.estimate_ms).toBe(20_000);
    expect(estimate.progress_percent).toBe(50);
    expect(estimate.elapsed_formatted).toBe("10s");
    expect(estimate.eta_formatted).toBe("10s");
  });

  it("preserves unknown duration and elapsed format for abandoned activities", () => {
    const record: ActivityRecord = {
      activity_id: "act-orphan",
      tool: "binary_overview",
      status: "unknown",
      started_at: new Date(Date.now() - 50_000).toISOString(),
    };

    expect(elapsedMs(record)).toBeUndefined();

    const estimate = estimateActivity(record, []);
    expect(estimate.status).toBe("unknown");
    expect(estimate.elapsed_ms).toBeUndefined();
    expect(estimate.elapsed_formatted).toBe("-");
    expect(estimate.eta_formatted).toBe("0s");
    expect(estimate.progress_percent).toBe(0);
  });
});
