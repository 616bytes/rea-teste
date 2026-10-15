import { expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

import { snapshotRoots } from "../../../src/process/capture/FilesystemSnapshot.js";
import { makeProcessCaptureEnvironment } from "../../../src/process/capture/ProcessCaptureEnvironment.js";
import { prepareProcessCapture } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { parseProcessScenario } from "../../../src/domain/process/processScenario.js";
import { emptyProcessCapture } from "../../../src/domain/process/processCapture.fixture.js";

const emptyFilesystemCoverage =
  emptyProcessCapture().truncation_details.filesystem_before;

it("passes a literal __proto__ environment override to the child", () => {
  const scenario = parseProcessScenario(
    JSON.parse(
      `{"executable":${JSON.stringify(process.execPath)},"environment":{"__proto__":"literal"}}`,
    ) as unknown,
  );
  const environment = makeProcessCaptureEnvironment({
    scenario,
    runId: "test-run",
    hostEnvironment: process.env,
  });
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.env['__proto__'] ?? 'missing')"],
    { env: environment, encoding: "utf8" },
  );

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("literal");
});

it("prepares ownership inspection before snapshotting or allocating a target run", async () => {
  const failure = new Error("native process identity inspection unavailable");
  const createTemporaryRoot = vi.fn(async () => "/unused");
  const cleanup = vi.fn(async () => undefined);
  const prepareOwnershipInspector = vi.fn(async () => {
    throw failure;
  });
  const captureSnapshot: typeof snapshotRoots = async () => {
    throw new Error("snapshot must not run after failed ownership preflight");
  };

  await expect(
    prepareProcessCapture(
      parseProcessScenario({
        executable: "/bin/true",
        working_directory: "/tmp",
      }),
      undefined,
      captureSnapshot,
      { prepareOwnershipInspector, createTemporaryRoot, cleanup },
    ),
  ).rejects.toBe(failure);

  expect(prepareOwnershipInspector).toHaveBeenCalledOnce();
  expect(createTemporaryRoot).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

it("cleans the temporary root when cancellation arrives during identity capture", async () => {
  const controller = new AbortController();
  const temporaryRoot = "/temporary-capture-root";
  const cleanup = vi.fn(async () => undefined);
  const host = {
    createTemporaryRoot: vi.fn(async () => temporaryRoot),
    captureOwnershipBaseline: vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return [];
    }),
    cleanup,
  };

  await expect(
    prepareProcessCapture(
      parseProcessScenario({
        executable: "/bin/true",
        working_directory: "/tmp",
      }),
      controller.signal,
      async () => ({
        files: [],
        truncated: false,
        completeRoots: [],
        coverage: emptyFilesystemCoverage,
      }),
      host,
    ),
  ).rejects.toThrow(/cancelled/u);
  expect(host.captureOwnershipBaseline).toHaveBeenCalledWith(controller.signal);
  expect(cleanup).toHaveBeenCalledWith(temporaryRoot);
});
