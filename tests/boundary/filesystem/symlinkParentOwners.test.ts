import { createHash } from "node:crypto";
import { mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { snapshotFirmware } from "../../../src/firmware/FirmwareFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// POSIX follows `link` before `..`, so `link/../x` names target/x, not ./x.
const layout = async (prefix: string) => {
  const root = await realpath(await createTestTempDirectory(prefix));
  await mkdir(join(root, "target/child"), { recursive: true });
  await symlink("target/child", join(root, "link"));
  return root;
};

describe.skipIf(process.platform === "win32")(
  "file owners given a directory symlink followed by ..",
  () => {
    it("snapshots the firmware image the filesystem selects", async () => {
      const root = await layout("rea-symlink-parent-firmware-");
      const selected = Buffer.from("selected firmware");
      await writeFile(join(root, "target/image.bin"), selected);
      await writeFile(join(root, "image.bin"), "sibling firmware");
      const work = await createTestTempDirectory("rea-firmware-snapshot-");
      // Concatenate: path.join would collapse `link/..` itself.
      const path = `${root}/link/../image.bin`;
      const snapshot = await snapshotFirmware(
        { operation: "inspect_firmware_regions", input: { path } },
        work,
        new AbortController().signal,
      );
      expect(snapshot.subject).toMatchObject({
        path,
        sha256: createHash("sha256").update(selected).digest("hex"),
      });
    });

    it("creates the output directory the filesystem selects", async () => {
      const root = await layout("rea-symlink-parent-output-");
      const tree = await SafeOutputTree.create(`${root}/link/../out`);
      try {
        expect(tree.outputRoot).toBe(join(root, "target/out"));
        expect((await stat(join(root, "target/out"))).isDirectory()).toBe(true);
        await expect(stat(join(root, "out"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await tree.rollback();
      }
    });
  },
);
