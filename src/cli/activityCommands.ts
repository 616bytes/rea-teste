import { z } from "incur";

import {
  createActivityJournal,
  type ActivityRecord,
} from "../application/activity/ActivityJournal.js";
import {
  estimateActivity,
  formatDuration,
} from "../application/activity/activityEstimates.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";

const activityOptions = z.object({
  watch: z.boolean().default(false).describe("Refresh until interrupted"),
  intervalMs: z
    .number()
    .int()
    .min(50)
    .max(2_147_483_647)
    .default(1000)
    .describe("Refresh interval in milliseconds"),
  limit: z
    .number()
    .int()
    .min(1)
    .safe()
    .default(25)
    .describe("Maximum activity records to display"),
});

const activityView = (
  path: string,
  records: readonly ActivityRecord[],
  allRecords: readonly ActivityRecord[] = records,
) => ({
  activity_log_path: path,
  records: records.map((record) => estimateActivity(record, allRecords)),
});

const DEFAULT_ESTIMATE_MS = 30_000;

const ANSI_ESCAPE_SEQUENCE =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;

export const sanitizeActivityText = (value: string): string =>
  value
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");

type ActivityLocale = "en" | "ko" | "ja";

const activityLocale = (
  environment: Readonly<Record<string, string | undefined>>,
): ActivityLocale => {
  const requested =
    environment.REA_ACTIVITY_LOCALE ??
    environment.LC_ALL ??
    environment.LC_MESSAGES ??
    environment.LANG ??
    Intl.DateTimeFormat().resolvedOptions().locale;
  const normalized = requested.toLowerCase();
  if (normalized.startsWith("ko")) return "ko";
  if (normalized.startsWith("ja") || normalized.startsWith("jp")) return "ja";
  return "en";
};

const activityLabels = {
  en: {
    title: "REA Activity Dashboard",
    status: "STATUS",
    elapsed: "ELAPSED",
    phase: "PHASE / TOOL",
    progress: "PROGRESS",
    eta: "ETA",
    estimate:
      "Progress and ETA are estimates based on previous runs or a 30-second default.",
  },
  ko: {
    title: "REA 활동 대시보드",
    status: "상태",
    elapsed: "경과",
    phase: "분석 단계 / 도구",
    progress: "진행",
    eta: "예상 잔여",
    estimate:
      "진행률과 ETA는 과거 실행시간 또는 기본 30초를 기준으로 한 추정치입니다.",
  },
  ja: {
    title: "REA アクティビティダッシュボード",
    status: "状態",
    elapsed: "経過",
    phase: "分析フェーズ / ツール",
    progress: "進捗",
    eta: "残り時間",
    estimate: "進捗率とETAは過去の実行時間、または30秒の既定値による推定です。",
  },
} as const;

const activityLine = (
  record: ActivityRecord,
  records: readonly ActivityRecord[],
): string => {
  const estimated = estimateActivity(record, records);
  const tool = sanitizeActivityText(estimated.tool);
  if (estimated.status !== "running")
    return `${estimated.status.padEnd(9)} ${estimated.elapsed_formatted.padStart(8)}  ${tool}`;
  return `${"RUNNING".padEnd(9)} ${estimated.elapsed_formatted.padStart(8)}  ${tool}  ${String(estimated.progress_percent).padStart(3)}%  ETA ${estimated.eta_formatted}`;
};

const watchActivity = async (
  path: string,
  journal: ReturnType<typeof createActivityJournal>,
  intervalMs: number,
  limit: number,
  locale: ActivityLocale,
): Promise<{ readonly stopped: true; readonly activity_log_path: string }> =>
  await new Promise((resolve) => {
    let stopped = false;
    let activeRender: Promise<void> | null = null;
    process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H");

    const render = async (): Promise<void> => {
      if (stopped) return;
      try {
        const allRecords = await journal.read();
        if (stopped) return;
        const records = allRecords.slice(0, limit);
        const labels = activityLabels[locale];
        process.stdout.write("\u001b[2J\u001b[H");
        process.stdout.write(`${labels.title}\n${path}\n\n`);
        process.stdout.write(
          records.length === 0
            ? "No activity recorded.\n"
            : [
                `${labels.status.padEnd(9)} ${labels.elapsed.padEnd(8)} ${labels.phase.padEnd(38)} ${labels.progress.padEnd(7)} ${labels.eta}`,
                "────────────────────────────────────────────────────────────────────",
                ...records.map((record) => activityLine(record, allRecords)),
                "",
                labels.estimate,
              ].join("\n") + "\n",
        );
      } catch {
        // Best-effort terminal view
      }
    };

    const triggerRender = (): void => {
      if (stopped || activeRender !== null) return;
      activeRender = render().finally(() => {
        activeRender = null;
      });
    };

    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (activeRender !== null) {
        await activeRender.catch(() => undefined);
      }
      process.stdout.write("\u001b[?1049l");
      resolve({ stopped: true as const, activity_log_path: path });
    };

    const timer = setInterval(() => triggerRender(), intervalMs);
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    triggerRender();
  });

export const registerActivityCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.activity, {
    description: "Inspect or watch agent-driven MCP activity",
    options: activityOptions,
    run: async ({ options }) => {
      const journal = createActivityJournal(environment);
      if (options.watch)
        return watchActivity(
          journal.path(),
          journal,
          options.intervalMs,
          options.limit,
          activityLocale(environment),
        );
      logger.debug({ activity_log_path: journal.path() }, "Read REA activity");
      const allRecords = await journal.read();
      return activityView(
        journal.path(),
        allRecords.slice(0, options.limit),
        allRecords,
      );
    },
  });
};
