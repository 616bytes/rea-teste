import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runUpdateCommand } from "../../../src/application/UpdateRuntime.js";
import { npmReleaseLookup } from "../../../src/application/UpdateRuntime.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

let directory: string;
beforeEach(async () => {
  directory = await createTestTempDirectory("rea-update-output-");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const script = async (source: string): Promise<readonly string[]> => {
  const path = join(directory, "package-manager.cjs");
  await writeFile(path, source);
  return [process.execPath, path, join(directory, "finished")];
};

const finish = `require('node:fs').writeFileSync(process.argv[2], 'finished')`;

it("rejects an oversized complete update reply after the child finishes", async () => {
  const result = await runUpdateCommand(
    await script(
      `process.stdout.write('x'.repeat(3 * 1024 * 1024)); ${finish}`,
    ),
    process.env,
  );
  expect(result).toMatchObject({ ok: false });
  if (!result.ok) expect(result.error).toContain("output budget");
  expect(await readFile(join(directory, "finished"), "utf8")).toBe("finished");
});

it("refuses to parse a valid version followed by oversized whitespace as complete metadata", async () => {
  const result = await runUpdateCommand(
    await script(
      `process.stdout.write('"6.7.0"' + ' '.repeat(3 * 1024 * 1024)); ${finish}`,
    ),
    process.env,
  );
  expect(npmReleaseLookup(result)).toMatchObject({
    ok: false,
    error: {
      kind: "unavailable",
      detail: expect.stringContaining("output budget"),
    },
  });
});

it("bounds stderr independently even when stdout contains a small valid version", async () => {
  const result = await runUpdateCommand(
    await script(
      `process.stdout.write('6.7.0'); process.stderr.write('x'.repeat(3 * 1024 * 1024)); ${finish}`,
    ),
    process.env,
  );
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining("output budget"),
  });
});

it.each([0, 1])(
  "counts UTF-8 bytes at the complete-output boundary, with %i excess bytes",
  async (excess) => {
    const result = await runUpdateCommand(
      await script(
        `process.stdout.write('😀'.repeat(512 * 1024) + 'x'.repeat(${String(excess)})); ${finish}`,
      ),
      process.env,
    );
    expect(result.ok).toBe(excess === 0);
    if (result.ok) expect(result.value).toBe("😀".repeat(512 * 1024));
    else expect(result.error).toContain("output budget");
  },
);

it("lets a noisy installation finish with bounded head and tail diagnostics", async () => {
  const result = await runUpdateCommand(
    await script(
      `process.stdout.write('start' + 'x'.repeat(3 * 1024 * 1024) + 'end'); process.stderr.write('y'.repeat(3 * 1024 * 1024)); ${finish}`,
    ),
    process.env,
    "structured",
    directory,
    "diagnostics",
  );
  expect(await readFile(join(directory, "finished"), "utf8")).toBe("finished");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(Buffer.byteLength(result.value)).toBeLessThan(64 * 1024 + 50);
    expect(result.value).toMatch(/^start.*\[output omitted\].*end$/su);
  }
});

it("retains the final failure and physical exit status after both streams overflow", async () => {
  const result = await runUpdateCommand(
    await script(
      `process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.stderr.write('warning'.repeat(512 * 1024) + 'final EACCES'); ${finish}; process.exitCode=37`,
    ),
    process.env,
    "structured",
    directory,
    "diagnostics",
  );
  expect(result).toMatchObject({ ok: false });
  if (!result.ok) {
    expect(result.error).toContain("final EACCES");
    expect(result.error).toContain("status 37");
    expect(result.error).toContain("diagnostics are incomplete");
    expect(Buffer.byteLength(result.error)).toBeLessThan(64 * 1024 + 200);
  }
  expect(await readFile(join(directory, "finished"), "utf8")).toBe("finished");
});

it.runIf(process.platform === "win32")(
  "preserves Windows batch launchers, selected environment, cwd and literal arguments",
  async () => {
    const command = await script(
      "process.stdout.write(JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),selected:process.env.REA_UPDATE_OUTPUT_TEST}));",
    );
    const batch = join(directory, "package manager.cmd");
    await writeFile(
      batch,
      `@echo off\r\n"${process.execPath}" "${command[1]}" %*\r\n`,
    );
    const result = await runUpdateCommand(
      [batch, command[2]!, "space and & literal"],
      { ...process.env, REA_UPDATE_OUTPUT_TEST: "selected" },
      "structured",
      directory,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(JSON.parse(result.value)).toEqual({
        args: ["space and & literal"],
        cwd: directory,
        selected: "selected",
      });
  },
);
