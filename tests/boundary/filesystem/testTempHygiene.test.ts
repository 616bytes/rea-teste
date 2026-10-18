import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["clean", "file", "directory", "symlink", "failed-test"])(
  "verifies private temporary-root ownership with a %s producer",
  async (scenario) => {
    const root = await createTestTempDirectory("rea-test-hygiene-boundary-");
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "node_modules/vitest"), { recursive: true });
    await copyFile(
      join(process.cwd(), "scripts/verify-test-temp-hygiene.mjs"),
      join(root, "scripts/verify-test-temp-hygiene.mjs"),
    );
    await mkdir(join(root, "external"));
    await writeFile(join(root, "external", "evidence"), "preserved");
    // Exercise the real verifier's child-process and cleanup boundaries. The
    // stand-in runner leaves a caller-named residue outside the old prefixes.
    await writeFile(
      join(root, "node_modules/vitest/vitest.mjs"),
      `import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
await writeFile("temporary-root.txt", tmpdir());
const scenario = ${JSON.stringify(scenario)};
if (scenario === "file" || scenario === "failed-test")
  await writeFile(join(tmpdir(), "reference-unicode-leak"), "retained");
if (scenario === "directory") {
  await mkdir(join(tmpdir(), "reference-unicode-leak", "nested"), { recursive: true });
  await writeFile(join(tmpdir(), "reference-unicode-leak", "nested", "evidence"), "retained");
}
if (scenario === "symlink")
  await symlink(join(process.cwd(), "external"), join(tmpdir(), "reference-unicode-leak"), process.platform === "win32" ? "junction" : "dir");
if (scenario === "failed-test") process.exitCode = 7;
`,
    );
    const result = execFileOutput(
      process.execPath,
      ["scripts/verify-test-temp-hygiene.mjs"],
      {
        cwd: root,
        stopSignal: "SIGTERM",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (scenario === "clean")
      await expect(result).resolves.toMatchObject({
        stdout: expect.stringContaining("no owned residues remain"),
      });
    else
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr:
          scenario === "failed-test"
            ? expect.stringMatching(/status 7[\s\S]*reference-unicode-leak/u)
            : expect.stringContaining("reference-unicode-leak"),
      });
    const temporaryRoot = await readFile(
      join(root, "temporary-root.txt"),
      "utf8",
    );
    await expect(stat(temporaryRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "external", "evidence"), "utf8")).toBe(
      "preserved",
    );
  },
);
