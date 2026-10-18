import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { workspaceCliTest } from "../support/cli/workspaceCliFixture.js";

// A damaged entry leased by a recent hit cannot be repaired. The command must
// report that failure and exit unsuccessfully instead of looking repaired.
workspaceCliTest(
  "cache-verify --repair reports a corrupt entry it could not remove",
  async ({ cli, workspace }) => {
    const directory = await workspace.mkdir("cache");
    const key = "a".repeat(64);
    await mkdir(join(directory, key), { recursive: true });
    await writeFile(join(directory, key, "manifest.json"), "{");
    await mkdir(join(directory, "leases"), { recursive: true });
    await writeFile(
      join(directory, "leases", `${key}.lease`),
      new Date().toISOString(),
    );

    const result = await cli.run({
      arguments: ["cache-verify", "--repair", "--format", "json"],
      cwd: workspace.root,
      environment: {
        ...workspace.environment,
        REA_GHIDRA_PROJECT_CACHE: "read",
        REA_GHIDRA_PROJECT_CACHE_DIR: directory,
      },
    });

    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      cache_directory: directory,
      invalid: [{ key }],
      repaired: [],
      failed_repairs: [{ key, reason: "busy" }],
    });
    await expect(stat(join(directory, key))).resolves.toBeDefined();
  },
);
