import { accessSync, constants, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { MAC_HOPPER_SYSTEM_LAUNCHER } from "../../../src/application/MacHopperPaths.js";
import { defaultHopperLauncherPath } from "../../../src/config/parseConfig.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A real system installation legitimately precedes this isolated user fixture.
const installedSystemHopper = (): boolean => {
  try {
    accessSync(MAC_HOPPER_SYSTEM_LAUNCHER, constants.X_OK);
    return statSync(MAC_HOPPER_SYSTEM_LAUNCHER).isFile();
  } catch {
    return false;
  }
};

it
  .skipIf(installedSystemHopper())
  .each(["Hopper Disassembler.app", "Hopper A.app"])(
  "skips a directory launcher in %s and selects a real file",
  async (name) => {
    const home = await createTestTempDirectory("rea-hopper-selection-");
    const invalid = join(home, "Applications", name, "Contents/MacOS/hopper");
    const valid = join(home, "Applications/Hopper Z.app/Contents/MacOS/hopper");
    await mkdir(invalid, { recursive: true });
    await mkdir(dirname(valid), { recursive: true });
    await writeFile(valid, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(defaultHopperLauncherPath("darwin", home)).toBe(valid);
  },
);
