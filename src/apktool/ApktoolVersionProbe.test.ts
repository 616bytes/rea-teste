import { afterEach, expect, it, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { inspectApktoolClient } from "./ApktoolConfiguration.js";

vi.mock("../process/OwnedCommand.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/OwnedCommand.js")>()),
  runOwnedCommand: vi.fn(),
}));
afterEach(() => vi.mocked(runOwnedCommand).mockReset());

const selection = {
  command: "/opt/apktool/apktool",
  commandSource: "environment",
} as const;
const owner = {} as ProviderProcessSupervisor;

it("runs the version probe as an owned interpreter-script process group", async () => {
  vi.mocked(runOwnedCommand).mockResolvedValueOnce({
    stdout: { text: "2.9.3\n" },
    stderr: { text: "" },
  } as Awaited<ReturnType<typeof runOwnedCommand>>);
  await expect(
    inspectApktoolClient(selection, undefined, {}, "linux"),
  ).resolves.toEqual({ version: "2.9.3" });
  expect(vi.mocked(runOwnedCommand).mock.lastCall?.[0]).toMatchObject({
    command: "/opt/apktool/apktool",
    arguments: ["--version"],
    expectedCommand: null,
  });
  expect(vi.mocked(runOwnedCommand).mock.lastCall?.[1]).toEqual({
    timeoutMs: 20_000,
    diagnosticBytes: 64 * 1024,
  });
});

it("reports an expired version probe as a typed timeout", async () => {
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure("timeout", "Command deadline elapsed."),
  );
  const failure = await inspectApktoolClient(
    selection,
    undefined,
    {},
    "linux",
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  expect(projectAnalysisError(failure as AnalysisTimeoutError)).toMatchObject({
    code: "provider_timeout",
    category: "timeout",
    details: { timeout_ms: 20_000 },
  });
});

it("retains an unresolved probe cleanup owner and reports the cleanup", async () => {
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure(
      "timeout",
      "Command deadline elapsed.",
      null,
      "cleanup incomplete",
      undefined,
      ["pid:1"],
      owner,
    ),
  );
  const retained: ProviderProcessSupervisor[] = [];
  const failure = await inspectApktoolClient(
    selection,
    undefined,
    {},
    "linux",
    (cleanupOwner) => retained.push(cleanupOwner),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  expect(projectAnalysisError(failure as AnalysisTimeoutError)).toMatchObject({
    code: "cleanup_incomplete",
  });
  expect(retained).toEqual([owner]);
});

it("reports a cancelled version probe as cancelled", async () => {
  vi.mocked(runOwnedCommand).mockRejectedValueOnce(
    new OwnedCommandFailure("cancelled", "Command cancelled."),
  );
  await expect(
    inspectApktoolClient(selection, undefined, {}, "linux"),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
});
