import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
} from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-rizin-preflight-"));
  directories.push(directory);
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  return path;
};

it("preserves a typed process ownership preflight failure through Rizin attribution", async () => {
  const path = await fixture();
  const physical = new Error("ps failed to identify the current process");
  const preflight = new AnalysisCapabilityUnavailableError(
    "process-ownership",
    "prepare_owned_process",
    "procps-compatible ps could not report REA's current process",
    {
      cause: physical,
      diagnostics: { command: "ps -axo pid=,ppid=,pgid=,uid=,stat=,command=" },
      userMessage:
        "Repair the local process ownership inspection before retrying.",
    },
  );
  const service = new TestReverseEngineeringService({
    run: async () => {
      throw preflight;
    },
  });
  const result = await service.executeRizinCommand({ path, command: "iI" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBe(preflight);
  expect(result.error.cause).toBe(physical);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "capability_unavailable",
    details: {
      provider_id: "process-ownership",
      operation: "prepare_owned_process",
      diagnostics: { command: "ps -axo pid=,ppid=,pgid=,uid=,stat=,command=" },
    },
  });
});

it("retains ordinary command output and attributes a missing executable to Rizin", async () => {
  const path = await fixture();
  const working = new TestReverseEngineeringService({
    run: async () => ({ stdout: "selected-provider", stderr: "" }),
  });
  const observed = await working.executeRizinCommand({ path, command: "iI" });
  expect(observed.ok).toBe(true);
  if (observed.ok)
    expect(observed.value.raw_result).toMatchObject({
      stdout: "selected-provider",
    });

  const missing = new TestReverseEngineeringService({
    run: async () => {
      throw Object.assign(new Error("missing Rizin"), { code: "ENOENT" });
    },
  });
  const failed = await missing.executeRizinCommand({ path, command: "iI" });
  expect(failed.ok).toBe(false);
  if (!failed.ok)
    expect(projectAnalysisError(failed.error).details).toMatchObject({
      provider_id: "rizin",
      operation: "execute_rizin_command",
      reason: "Unable to run configured command (ENOENT)",
    });
});

it("keeps caller cancellation dominant when a preflight failure races abort", async () => {
  const path = await fixture();
  const controller = new AbortController();
  const preflight = new AnalysisCapabilityUnavailableError(
    "process-ownership",
    "prepare_owned_process",
    "ps unavailable",
  );
  const service = new TestReverseEngineeringService({
    run: async () => {
      controller.abort("caller stopped");
      throw preflight;
    },
  });
  const result = await service.executeRizinCommand(
    { path, command: "iI" },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(preflight);
    expect(result.error.cleanupIncomplete).toBe(false);
  }
});
