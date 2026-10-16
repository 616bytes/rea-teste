import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { ManagedStaticProvider } from "../../../../src/dotnet/ManagedStaticProvider.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each([false, true])(
  "cancels a cached managed source hash and recovers its exact owner (close denied: %s)",
  async (denyClose) => {
    const directory = await createTestTempDirectory("rea-managed-hash-cancel-");
    const path = join(directory, "fixture.exe");
    await writeFile(
      path,
      Buffer.concat([buildManagedPeFixture(), Buffer.alloc(512 * 1024)]),
    );
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    const client = new ManagedStaticProvider().createClient(parsed.value);
    const initial = await client.execute("inspect_managed_artifact", {});
    if (!initial.ok) throw initial.error;

    const admitted = await open(path, "r");
    const prototype = Object.getPrototypeOf(admitted) as FileHandle;
    await admitted.close();
    const originalRead = prototype.read;
    const controller = new AbortController();
    const reason = new Error("cancel after actual managed source bytes arrive");
    let cancelledHandle: FileHandle | undefined;
    let permitClose = !denyClose;
    const deniedHandles: FileHandle[] = [];
    let restoreClose: (() => void) | undefined;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      const result: Awaited<ReturnType<FileHandle["read"]>> =
        await Reflect.apply(originalRead, this, args);
      if (result.bytesRead > 0 && cancelledHandle === undefined) {
        cancelledHandle = this;
        if (denyClose) {
          const originalClose = this.close.bind(this);
          const close = vi.spyOn(this, "close").mockImplementation(async () => {
            if (!permitClose) {
              deniedHandles.push(this);
              throw new Error("fixture managed descriptor close denied");
            }
            await originalClose();
          });
          restoreClose = () => close.mockRestore();
        }
        controller.abort(reason);
      }
      return result;
    });
    try {
      const cancelled = await client.execute(
        "inspect_managed_members",
        {},
        { signal: controller.signal },
      );
      expect(cancelledHandle).toBeDefined();
      if (cancelled.ok) throw new Error("Cancelled managed hashing succeeded");
      if (denyClose) {
        expect(projectAnalysisError(cancelled.error)).toMatchObject({
          code: "cleanup_incomplete",
          details: { diagnostics: { primary_error: { code: "cancelled" } } },
        });
        expect(cancelledHandle?.fd).toBeGreaterThanOrEqual(0);
        expect(deniedHandles.length).toBeGreaterThan(0);
        expect(
          deniedHandles.every((handle) => handle === cancelledHandle),
        ).toBe(true);
      } else {
        expect(projectAnalysisError(cancelled.error)).toMatchObject({
          code: "cancelled",
        });
        expect(cancelled.error.cause).toBe(reason);
        expect(cancelledHandle?.fd).toBe(-1);
      }

      permitClose = true;
      read.mockRestore();
      const recovered = await client.execute("inspect_managed_members", {});
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.subject?.sha256).toBe(parsed.value.sha256);
      expect(cancelledHandle?.fd).toBe(-1);
      expect(await client.close()).toMatchObject({ ok: true });
    } finally {
      permitClose = true;
      read.mockRestore();
      await client.close();
      restoreClose?.();
    }
  },
);
