import { writeFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactAnalysisResources } from "../../src/process/ArtifactAnalysisResources.js";
import { ArtifactFileCleanupFailure } from "../../src/artifacts/ArtifactFileOperation.js";
import { readLinuxResourceLimits } from "../../src/process/LinuxResourceLimits.js";
import { ok } from "../../src/domain/result.js";
import { readStableArtifact } from "../../src/artifacts/readStableArtifact.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const cleanup = vi.hoisted(() => ({
  path: "",
  denied: true,
  handles: [] as FileHandle[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  const { withDescriptorCloseFailure } =
    await import("../fixtures/descriptorCloseFailure.js");
  const injected = withDescriptorCloseFailure(filesystem, cleanup);
  return {
    ...injected,
    open: (...args: Parameters<typeof filesystem.open>) =>
      injected.open(
        args[0] === "/proc/self/limits" ? cleanup.path : args[0],
        args[1],
        args[2],
      ),
  };
});

const configured = {
  address_space_bytes: 1024,
  file_bytes: 2048,
  cpu_seconds: 30,
};
const report =
  "Max address space unlimited unlimited bytes\nMax file size unlimited unlimited bytes\nMax cpu time unlimited unlimited seconds\n";
let directory: string;
beforeEach(async () => {
  directory = await createTestTempDirectory("rea-kernel-limit-owner-");
  cleanup.path = join(directory, "limits");
  cleanup.denied = true;
  cleanup.handles = [];
  await writeFile(cleanup.path, report);
});
afterEach(async () => {
  cleanup.denied = false;
  for (const handle of cleanup.handles) await handle.close();
  await rm(directory, { recursive: true, force: true });
});

it("retries the exact kernel descriptor before replacement work and clears the original cleanup status", async () => {
  const resources = new ArtifactAnalysisResources(
    "kernel-test",
    "inspect_packet_capture",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  try {
    const first = await resources.run(async () =>
      ok(await resources.readLimits(configured)),
    );
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: ["/proc/self/limits"],
      },
    });
    if (first.ok) throw new Error("expected failed kernel close");
    const cause = first.error.cause;
    expect(cleanup.handles).toHaveLength(1);
    expect(cleanup.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    const blocked = await resources.run(async () =>
      ok(await resources.readLimits(configured)),
    );
    expect(blocked).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(cleanup.handles).toHaveLength(1);
    cleanup.denied = false;
    expect(
      await resources.run(async () =>
        ok(await resources.readLimits(configured)),
      ),
    ).toEqual(ok(configured));
    expect(first.error.cleanupIncomplete).toBe(false);
    expect(first.error.cause).toBe(cause);
    expect(cleanup.handles).toHaveLength(2);
    expect(cleanup.handles.every((handle) => handle.fd === -1)).toBe(true);
    await resources.close();
  } finally {
    cleanup.denied = false;
    // the failing baseline has no usable recovery capability; teardown still frees its fixture handles.
    await resources.close().catch(() => undefined);
  }
});

it.each(["completed", "failed"] as const)(
  "preserves a %s physical read and a retry capability without a resource scope",
  async (outcome) => {
    if (outcome === "failed") await writeFile(cleanup.path, "malformed report");
    let failure: unknown;
    try {
      await readLinuxResourceLimits(configured);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure)) throw failure;
    expect(failure.fileCleanupFailure.outcome.kind).toBe(outcome);
    if (outcome === "completed")
      expect(failure.fileCleanupFailure.outcome).toMatchObject({
        value: configured,
      });
    else if (failure.fileCleanupFailure.outcome.kind === "failed")
      expect(String(failure.fileCleanupFailure.outcome.cause)).toContain(
        "Cannot establish inherited Linux limit",
      );
    cleanup.denied = false;
    await failure.cleanupLease.release();
    expect(cleanup.handles.every((handle) => handle.fd === -1)).toBe(true);
  },
);
