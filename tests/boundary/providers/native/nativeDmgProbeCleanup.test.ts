import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  failNextClose: false,
  failedHandle: undefined as FileHandle | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== probeState.targetPath) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (probeState.failNextClose) {
          probeState.failNextClose = false;
          probeState.failedHandle = handle;
          throw new Error("injected probe close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { NativeDmgArtifactReader } from "../../../../src/artifacts/NativeDmgArtifactReader.js";

it("retains a verify-probe descriptor whose close fails until the reader closes", async () => {
  const root = await createTestTempDirectory("rea-dmg-probe-cleanup-");
  const path = join(root, "image.dmg");
  await writeFile(path, "This may or may not be a disk image.\n");
  probeState.targetPath = path;
  probeState.failNextClose = true;
  // Captured from hdiutil with AppleLanguages set to es-419.
  const run = vi.fn(async () => ({
    stdout: "",
    stderr: `hdiutil: verify: unable to recognize ${JSON.stringify(path)} as a disk image. (imagen no reconocida)\nhdiutil: verify failed - imagen no reconocida\n`,
    exitCode: 1,
  }));
  const reader = new NativeDmgArtifactReader(path, process.env, {
    run,
    delay: async () => {},
  });

  const entries = async () => {
    for await (const _entry of reader.entries()) {
      // Force lazy initialization.
    }
  };
  await expect(entries()).rejects.toMatchObject({
    reason: "unavailable",
    message: expect.stringContaining("imagen no reconocida"),
    cleanup: {
      reason: "injected probe close failure",
      resources: [`DMG verify probe descriptor ${path}`],
    },
  });
  expect(run).toHaveBeenCalledTimes(1);
  const failedHandle = probeState.failedHandle;
  expect(failedHandle?.fd).toBeGreaterThanOrEqual(0);

  await reader.close();
  expect(failedHandle?.fd).toBe(-1);
});
