import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestPath = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");

const canonicalTemporaryRoot = await realpath(tmpdir());
const isolatedTemporaryRoot = await mkdtemp(
  join(canonicalTemporaryRoot, "rea-test-hygiene-"),
);

try {
  const result = spawnSync(
    process.execPath,
    [vitestPath, "run", "--coverage.enabled=false", ...process.argv.slice(2)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TEMP: isolatedTemporaryRoot,
        TMP: isolatedTemporaryRoot,
        TMPDIR: isolatedTemporaryRoot,
      },
      stdio: "inherit",
    },
  );

  const failures = [];
  if (result.error !== undefined) failures.push(result.error.message);
  if (result.status !== 0) {
    failures.push(
      result.signal === null
        ? `Vitest exited with status ${String(result.status)}`
        : `Vitest exited after signal ${result.signal}`,
    );
  }

  // This run owns the entire fresh root. Caller-selected prefixes and tool
  // caches do not change ownership; list entries without following symlinks.
  const residues = (await readdir(isolatedTemporaryRoot)).sort();
  if (residues.length > 0) {
    failures.push(`Owned temporary residues:\n${residues.join("\n")}`);
  }

  if (failures.length > 0) throw new Error(failures.join("\n\n"));
} finally {
  await rm(isolatedTemporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}
process.stdout.write(
  "Test temporary-directory hygiene verified: no owned residues remain.\n",
);
