import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const verifyStagedElectronHooks = async (runtime, stagedHook) => {
  const hashes = {};
  for (const name of [
    "electron-active-hook.cjs",
    "electron-active-hook-boundaries.cjs",
  ]) {
    const hash = (data) => createHash("sha256").update(data).digest("hex");
    const actualPath =
      name === "electron-active-hook.cjs"
        ? stagedHook
        : join(dirname(stagedHook), name);
    const [actual, expected] = await Promise.all([
      readFile(actualPath).then(hash),
      readFile(join(runtime, "scripts", name)).then(hash),
    ]);
    assert.equal(actual, expected, `Staged ${name} must match selected source`);
    hashes[name] = actual;
  }
  return hashes;
};
