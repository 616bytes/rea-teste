import { fstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalysisAccessDeniedError } from "../domain/analysisErrorCore.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { elfFuseImage } from "../../tests/fixtures/electron/fuseImage.js";
import { ElectronFuseProvider } from "./ElectronFuseProvider.js";
import { readElectronFuseImage } from "./ElectronFuseReader.js";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: mockOpen };
});

const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const openedHandles: FileHandle[] = [];
const originalCloses = new Map<FileHandle, () => Promise<void>>();

const passthroughOpen = (path: unknown, ...rest: unknown[]) =>
  (actualFs.open as (...args: unknown[]) => Promise<FileHandle>)(path, ...rest);

beforeEach(() => {
  mockOpen.mockImplementation(passthroughOpen);
});

/**
 * Route open() through the real filesystem but fault the returned handle for
 * one target path: reads can be made to fail with a primary error while the
 * final close rejects, mirroring issue #4658's controlled reproduction.
 */
const armFaults = (
  target: string,
  faults: { readonly readFailure?: unknown; readonly closeFailure: unknown },
) => {
  mockOpen.mockImplementation(
    async (path: unknown, ...rest: unknown[]): Promise<FileHandle> => {
      const handle = await passthroughOpen(path, ...rest);
      if (String(path) === target) {
        originalCloses.set(handle, handle.close.bind(handle));
        if (faults.readFailure !== undefined) {
          const readFailure = faults.readFailure;
          handle.read = (async () => {
            throw readFailure;
          }) as unknown as FileHandle["read"];
        }
        const closeFailure = faults.closeFailure;
        handle.close = (async () => {
          throw closeFailure;
        }) as unknown as FileHandle["close"];
        openedHandles.push(handle);
      }
      return handle;
    },
  );
};

afterEach(async () => {
  mockOpen.mockReset();
  for (const handle of openedHandles) {
    try {
      await originalCloses.get(handle)?.();
    } catch {
      // The handle is already closed or the faulted close left it unusable.
    }
  }
  openedHandles.length = 0;
  originalCloses.clear();
});

const writeElfImage = async (root: string, name: string): Promise<string> => {
  const path = join(root, name);
  const image = elfFuseImage([1, 1]);
  await actualFs.writeFile(path, image.bytes);
  return path;
};

describe("electron fuse final-close failures", () => {
  it("keeps the primary read error when the final close rejects", async () => {
    const root = await createTestTempDirectory("rea-fuse-close-fault-");
    const path = await writeElfImage(root, "app.elf");
    const readFailure = Object.assign(new Error("physical read failure"), {
      code: "EIO",
    });
    const closeFailure = Object.assign(
      new Error("close rejected; descriptor still live"),
      { code: "EACCES" },
    );
    armFaults(path, { readFailure, closeFailure });

    const failure = await readElectronFuseImage(path).catch(
      (error: unknown) => error,
    );

    // The close rejection must not replace the primary read error.
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a RegularFileCleanupFailure");
    expect(failure.outcome.kind).toBe("failed");
    if (failure.outcome.kind !== "failed")
      throw new Error("Expected the read outcome to be retained");
    expect(failure.outcome.cause).toBe(readFailure);
    expect(failure.cleanupCause).toBe(closeFailure);
    // Ownership of the still-live descriptor is retained, not dropped.
    expect(failure.owner.handle).toBe(openedHandles[0]);
    expect(() => fstatSync(openedHandles[0]?.fd ?? -1)).not.toThrow();
  });

  it("reports incomplete cleanup instead of a read permission failure when only the close fails", async () => {
    const root = await createTestTempDirectory("rea-fuse-cleanup-report-");
    const path = await writeElfImage(root, "app.elf");
    const closeFailure = Object.assign(
      new Error("close rejected; descriptor still live"),
      { code: "EACCES" },
    );
    armFaults(path, { closeFailure });

    const result = await new ElectronFuseProvider().inspect({ path });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected an error result");
    // A close failure with errno EACCES must not surface as a read denial.
    expect(result.error).not.toBeInstanceOf(AnalysisAccessDeniedError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain(path);
  });

  it("reads normally when the final close succeeds", async () => {
    const root = await createTestTempDirectory("rea-fuse-close-ok-");
    const path = await writeElfImage(root, "app.elf");

    const image = await readElectronFuseImage(path);

    expect(image.format).toBe("elf");
    expect(image.slices).toHaveLength(1);
  });
});
