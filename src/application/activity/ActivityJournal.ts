import {
  appendFile,
  mkdir,
  readFile,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ActivityRecord {
  readonly activity_id: string;
  readonly tool: string;
  readonly status: ActivityStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
  readonly evidence_id?: string;
  readonly pid?: number;
}

interface ActivityCompletion {
  readonly activityId: string;
  readonly status: Exclude<ActivityStatus, "running">;
  readonly startedAt: string;
  readonly at?: string;
  readonly evidenceId?: string;
}

type ActivityEvent =
  | {
      readonly kind: "started";
      readonly activity_id: string;
      readonly tool: string;
      readonly at: string;
      readonly pid?: number;
    }
  | {
      readonly kind: "finished";
      readonly activity_id: string;
      readonly status: Exclude<ActivityStatus, "running">;
      readonly at: string;
      readonly duration_ms: number;
      readonly evidence_id?: string;
    };

const MAX_EVENTS = 200;
const MAX_BYTES = 1024 * 1024;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_MAX_ATTEMPTS = 20;

export const activityLogPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configured = environment.REA_ACTIVITY_LOG_PATH;
  if (configured !== undefined && configured.trim().length > 0)
    return configured;
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    const base =
      localAppData !== undefined &&
      localAppData.trim().length > 0 &&
      isAbsolute(localAppData)
        ? localAppData
        : join(homedir(), "AppData", "Local");
    return join(base, "rea", "activity.jsonl");
  }
  const xdg = environment.XDG_STATE_HOME;
  const base =
    xdg !== undefined && xdg.trim().length > 0 && isAbsolute(xdg)
      ? xdg
      : join(homedir(), ".local", "state");
  return join(base, "rea", "activity.jsonl");
};

const acquireDirectoryLock = async (lockPath: string): Promise<boolean> => {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_TIMEOUT_MS) {
            await rmdir(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_RETRY_INTERVAL_MS),
        );
        continue;
      }
      return false;
    }
  }
  return false;
};

const withJournalLock = async <T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> => {
  const acquired = await acquireDirectoryLock(lockPath);
  try {
    return await action();
  } finally {
    if (acquired) {
      await rmdir(lockPath).catch(() => undefined);
    }
  }
};

export const isProcessAlive = (pid: number | undefined): boolean => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const parseEvents = (text: string): ActivityEvent[] =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== "object" ||
          value === null ||
          typeof Reflect.get(value, "kind") !== "string" ||
          typeof Reflect.get(value, "activity_id") !== "string"
        )
          return [];
        return [value as ActivityEvent];
      } catch {
        return [];
      }
    });

export const projectRecords = (
  events: readonly ActivityEvent[],
  isAlive: (pid: number | undefined) => boolean = isProcessAlive,
): ActivityRecord[] => {
  const records = new Map<string, ActivityRecord>();
  for (const event of events) {
    if (event.kind === "started") {
      const active = isAlive(event.pid);
      records.set(event.activity_id, {
        activity_id: event.activity_id,
        tool: event.tool,
        status: active ? "running" : "unknown",
        started_at: event.at,
        ...(event.pid !== undefined ? { pid: event.pid } : {}),
      });
      continue;
    }
    const current = records.get(event.activity_id);
    if (current === undefined) continue;
    records.set(event.activity_id, {
      ...current,
      status: event.status,
      finished_at: event.at,
      duration_ms: event.duration_ms,
      ...(event.evidence_id === undefined
        ? {}
        : { evidence_id: event.evidence_id }),
    });
  }
  return [...records.values()].sort((left, right) =>
    right.started_at.localeCompare(left.started_at),
  );
};

/** Best-effort, bounded local activity journal; activity must not affect tool truth. */
export class ActivityJournal {
  #write: Promise<void> = Promise.resolve();
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  path(): string {
    return this.#path;
  }

  start(
    tool: string,
    at = new Date().toISOString(),
    pid: number = process.pid,
  ): string {
    const activityId = randomUUID();
    void this.#append({
      kind: "started",
      activity_id: activityId,
      tool,
      at,
      pid,
    });
    return activityId;
  }

  finish({
    activityId,
    status,
    startedAt,
    at = new Date().toISOString(),
    evidenceId,
  }: ActivityCompletion): void {
    const duration = Math.max(
      0,
      new Date(at).getTime() - new Date(startedAt).getTime(),
    );
    void this.#append({
      kind: "finished",
      activity_id: activityId,
      status,
      at,
      duration_ms: duration,
      ...(evidenceId === undefined ? {} : { evidence_id: evidenceId }),
    });
  }

  async read(
    limit = MAX_EVENTS,
    isAlive: (pid: number | undefined) => boolean = isProcessAlive,
  ): Promise<ActivityRecord[]> {
    await this.#write;
    try {
      const text = await readFile(this.#path, "utf8");
      const records = projectRecords(parseEvents(text), isAlive);
      if (records.length <= limit) return records;
      const active = records.filter((record) => record.status === "running");
      const recent = records
        .filter((record) => record.status !== "running")
        .slice(0, Math.max(0, limit - active.length));
      return [...active, ...recent];
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  async #append(event: ActivityEvent): Promise<void> {
    this.#write = this.#write
      .then(async () => {
        try {
          await mkdir(dirname(this.#path), { recursive: true });
          await withJournalLock(`${this.#path}.lock`, async () => {
            await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
            const current = await stat(this.#path);
            if (current.size <= MAX_BYTES) return;
            const text = await readFile(this.#path, "utf8");
            const lines = text
              .split(/\r?\n/u)
              .filter((line) => line.length > 0);
            const retainedLines = lines.slice(-MAX_EVENTS * 2);
            const retainedIds = new Set(
              parseEvents(retainedLines.join("\n")).map(
                (event) => event.activity_id,
              ),
            );
            const finishedIds = new Set(
              parseEvents(lines.join("\n"))
                .filter((event) => event.kind === "finished")
                .map((event) => event.activity_id),
            );
            const activeStarts = parseEvents(lines.join("\n")).filter(
              (event) =>
                event.kind === "started" &&
                !finishedIds.has(event.activity_id) &&
                !retainedIds.has(event.activity_id),
            );
            const activeLines = activeStarts.map((event) =>
              JSON.stringify(event),
            );
            await writeFile(
              this.#path,
              `${[...activeLines, ...retainedLines].join("\n")}\n`,
              "utf8",
            );
          });
        } catch {
          // Observability is deliberately best-effort and cannot change analysis truth.
        }
      })
      .catch(() => undefined);
    await this.#write;
  }
}

export const createActivityJournal = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ActivityJournal => new ActivityJournal(activityLogPath(environment));
