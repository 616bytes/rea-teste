import { expect, it, vi } from "vitest";

import { cleanupElectronProcesses } from "../../../src/browser/PlaywrightElectronActiveProvider.js";
import type {
  OwnedProcessGroup,
  ProcessLineageObservation,
} from "../../../src/process/ProcessOwnership.js";

const ownership: OwnedProcessGroup = {
  runId: "fixture-run",
  leaderPid: 42,
  processGroupId: 42,
};

it.each(["process table permission denied", "process ownership did not match"])(
  "retains the observer's unavailable reason without authorizing termination: %s",
  async (reason) => {
    const terminateTree = vi.fn();
    const result = await cleanupElectronProcesses(
      ownership,
      {
        status: "unavailable",
        observedAt: "2026-10-16T00:00:00.000Z",
        runId: ownership.runId,
        launcherPid: ownership.leaderPid,
        processGroupId: ownership.processGroupId,
        reason,
      },
      { platform: "win32", terminateTree },
    );
    expect(result).toEqual({
      cleaned: false,
      reason: `${reason}; helper cleanup was not proven`,
    });
    expect(terminateTree).not.toHaveBeenCalled();
  },
);

it("distinguishes an unobserved lineage from an unavailable observation", async () => {
  const terminateTree = vi.fn();
  expect(
    await cleanupElectronProcesses(ownership, undefined, {
      platform: "win32",
      terminateTree,
    }),
  ).toEqual({
    cleaned: false,
    reason:
      "owned Electron lineage was not observed; helper cleanup was not proven",
  });
  expect(terminateTree).not.toHaveBeenCalled();
});

it("preserves verified cleanup and termination failure outcomes", async () => {
  const lineage: ProcessLineageObservation = {
    status: "verified",
    observedAt: "2026-10-16T00:00:00.000Z",
    lineage: {
      runId: ownership.runId,
      launcherPid: 42,
      launcherParentPid: 1,
      processGroupId: 42,
      descendants: [],
    },
  };
  for (const outcome of [
    { cleaned: true, signaled: true } as const,
    { cleaned: false, reason: "termination denied" } as const,
  ]) {
    const terminateTree = vi.fn().mockResolvedValue(outcome);
    expect(
      await cleanupElectronProcesses(ownership, lineage, {
        platform: "win32",
        terminateTree,
      }),
    ).toBe(outcome);
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(42);
  }
});
