import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ELECTRON_FUSE_STATE_BYTES } from "../domain/electron/electronFuses.js";
import {
  elfFuseImage,
  OBSIDIAN_FUSE_BYTES,
  peFuseImage,
  thinFuseImage,
  thinMacho,
  universalFuseImage,
} from "../../tests/fixtures/electron/fuseImage.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import { assertNodeCliInspectArgumentsSupported } from "./PlaywrightElectronActiveFuses.js";

describe("assertNodeCliInspectArgumentsSupported", () => {
  it("rejects thin Mach-O binary when EnableNodeCliInspectArguments fuse is disabled", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "disabled-app");
    const image = thinFuseImage(OBSIDIAN_FUSE_BYTES); // index 3 is disabled
    await writeFile(binaryPath, image.bytes);

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath),
    ).rejects.toThrow(AnalysisUnsupportedTargetError);

    try {
      await assertNodeCliInspectArgumentsSupported(binaryPath);
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisUnsupportedTargetError);
      const targetError = error as AnalysisUnsupportedTargetError;
      expect(targetError.operation).toBe("capture_electron_scenario");
      expect(targetError.path).toBe(binaryPath);
      expect(targetError.message).toContain("EnableNodeCliInspectArguments");
      expect(targetError.remediationAction).toContain("inspect_electron_page");
    }
  });

  it("passes when EnableNodeCliInspectArguments fuse is enabled", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "enabled-app");
    const enabledFuses = [...OBSIDIAN_FUSE_BYTES];
    enabledFuses[3] = ELECTRON_FUSE_STATE_BYTES.enabled;
    const image = thinFuseImage(enabledFuses);
    await writeFile(binaryPath, image.bytes);

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath),
    ).resolves.toBeUndefined();
  });

  it("passes when binary contains no fuse sentinel (fuse state unknown)", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "stock-node");
    const image = thinMacho(0x0100000c, Buffer.from("no-sentinel-bytes-here"));
    await writeFile(binaryPath, image);

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath),
    ).resolves.toBeUndefined();
  });

  it("passes gracefully when fuse reader throws a format or reading failure", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const nonMachoPath = join(root, "script.sh");
    await writeFile(nonMachoPath, "#!/bin/sh\necho hello");

    await expect(
      assertNodeCliInspectArgumentsSupported(nonMachoPath),
    ).resolves.toBeUndefined();
  });

  it("rejects Windows PE binary when EnableNodeCliInspectArguments fuse is disabled", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "disabled-pe.exe");
    const image = peFuseImage(OBSIDIAN_FUSE_BYTES);
    await writeFile(binaryPath, image.bytes);

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath),
    ).rejects.toThrow(AnalysisUnsupportedTargetError);
  });

  it("rejects Linux ELF binary when EnableNodeCliInspectArguments fuse is disabled", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "disabled-elf");
    const image = elfFuseImage(OBSIDIAN_FUSE_BYTES);
    await writeFile(binaryPath, image.bytes);

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath),
    ).rejects.toThrow(AnalysisUnsupportedTargetError);
  });

  it("rethrows when signal is aborted during reading", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "test-binary");
    const image = thinFuseImage(OBSIDIAN_FUSE_BYTES);
    await writeFile(binaryPath, image.bytes);

    const controller = new AbortController();
    controller.abort();

    await expect(
      assertNodeCliInspectArgumentsSupported(binaryPath, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("evaluates matching architecture slice in universal Mach-O binary", async () => {
    const root = await createTestTempDirectory("rea-fuse-preflight-");
    const binaryPath = join(root, "universal-app");
    // universalFuseImage has left (x86_64) disabled, right (arm64) enabled
    const image = universalFuseImage();
    await writeFile(binaryPath, image.bytes);

    if (process.arch === "arm64") {
      await expect(
        assertNodeCliInspectArgumentsSupported(binaryPath),
      ).resolves.toBeUndefined();
    } else {
      await expect(
        assertNodeCliInspectArgumentsSupported(binaryPath),
      ).rejects.toThrow(AnalysisUnsupportedTargetError);
    }
  });
});
