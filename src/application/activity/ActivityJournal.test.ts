import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ActivityJournal, activityLogPath } from "./ActivityJournal.js";

describe("ActivityJournal", () => {
  it("projects started and terminal events without caller arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-"));
    const path = join(root, "activity.jsonl");
    const journal = new ActivityJournal(path);
    const startedAt = "2026-10-14T00:00:00.000Z";
    const finishedAt = "2026-10-14T00:00:01.250Z";

    const id = journal.start("binary_overview", startedAt);
    journal.finish({
      activityId: id,
      status: "completed",
      startedAt,
      at: finishedAt,
    });

    await expect(journal.read()).resolves.toMatchObject([
      {
        activity_id: id,
        tool: "binary_overview",
        status: "completed",
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: 1250,
        pid: expect.any(Number),
      },
    ]);
    await expect(readFile(path, "utf8")).resolves.not.toContain("target/path");
  });

  it("keeps an unfinished operation explicitly running", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-"));
    const journal = new ActivityJournal(join(root, "activity.jsonl"));

    journal.start("analyze_javascript_application", "2026-10-14T00:00:00.000Z");

    await expect(journal.read()).resolves.toMatchObject([
      { tool: "analyze_javascript_application", status: "running" },
    ]);
  });

  it("marks abandoned operations as unknown when process is no longer alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-dead-"));
    const journal = new ActivityJournal(join(root, "activity.jsonl"));

    // Start with a dead/nonexistent PID
    journal.start("analyze_function", "2026-10-14T00:00:00.000Z", 999_999_999);

    await expect(journal.read()).resolves.toMatchObject([
      { tool: "analyze_function", status: "unknown" },
    ]);

    // Also verify custom isAlive injection for hermetic unit testing
    const deadJournal = new ActivityJournal(join(root, "activity2.jsonl"));
    deadJournal.start("binary_overview", "2026-10-14T00:00:00.000Z", 12345);

    await expect(
      deadJournal.read(10, (pid) => pid !== 12345),
    ).resolves.toMatchObject([{ tool: "binary_overview", status: "unknown" }]);
  });

  it("falls back to default path when XDG_STATE_HOME or LOCALAPPDATA is empty or relative", () => {
    const emptyLog = activityLogPath({ XDG_STATE_HOME: "", LOCALAPPDATA: "" });
    expect(emptyLog).toMatch(/rea[/\\]activity\.jsonl$/);

    const relativeLog = activityLogPath({
      XDG_STATE_HOME: "relative/state",
      LOCALAPPDATA: "relative\\state",
    });
    expect(relativeLog).toMatch(/rea[/\\]activity\.jsonl$/);
  });

  it("safely serializes concurrent appends across journal instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-concurrent-"));
    const path = join(root, "activity.jsonl");
    const journalA = new ActivityJournal(path);
    const journalB = new ActivityJournal(path);

    const idA = journalA.start("binary_overview", "2026-10-14T00:00:00.000Z");
    const idB = journalB.start("analyze_function", "2026-10-14T00:00:01.000Z");

    journalA.finish({
      activityId: idA,
      status: "completed",
      startedAt: "2026-10-14T00:00:00.000Z",
      at: "2026-10-14T00:00:02.000Z",
    });
    journalB.finish({
      activityId: idB,
      status: "completed",
      startedAt: "2026-10-14T00:00:01.000Z",
      at: "2026-10-14T00:00:03.000Z",
    });

    await journalB.read();
    const records = await journalA.read();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.tool)).toContain("binary_overview");
    expect(records.map((r) => r.tool)).toContain("analyze_function");
  });
});
