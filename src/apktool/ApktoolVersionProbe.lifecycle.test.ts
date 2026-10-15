import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { inspectApktoolClient } from "./ApktoolConfiguration.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return false;
};

// The interpreter is the test runtime itself, so its environment (and the
// ownership run token) is readable on both Linux and macOS.
it.skipIf(process.platform === "win32")(
  "stops an interpreter launcher and its pipe-holding child when the probe is cancelled",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-probe-");
    const pids = join(root, "pids.json");
    const launcher = join(root, "apktool");
    await writeFile(
      launcher,
      [
        `#!${process.execPath}`,
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
        `require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await chmod(launcher, 0o755);
    const controller = new AbortController();
    const started = performance.now();
    const probe = inspectApktoolClient(
      { command: launcher, commandSource: "environment" },
      controller.signal,
      process.env,
    ).catch((cause: unknown) => cause);
    expect(
      await waitFor(
        async () =>
          (await readFile(pids, "utf8").catch(() => "")).startsWith("["),
        10_000,
      ),
    ).toBe(true);
    const launched = JSON.parse(await readFile(pids, "utf8")) as number[];
    controller.abort();
    expect(await probe).toBeInstanceOf(AnalysisCancelledError);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(await waitFor(async () => !launched.some(alive), 5_000)).toBe(true);
  },
  30_000,
);
