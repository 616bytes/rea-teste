import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const script = fileURLToPath(
  new URL("../../../scripts/ci/portable-build-cache.mjs", import.meta.url),
);
const first = { taskId: "compile", hash: "0123456789abcdef" };
const second = { taskId: "artifacts:skills", hash: "fedcba9876543210" };
const plan = { tasks: [first, second] };
const prefix = "rea-portable-build-v2-Linux-X64-toolchain";
const output = ".cache/ci-build-cache";
const reportName = "snapshot-report.json";

function run(root: string, mode: "key" | "snapshot", input: unknown = plan) {
  const result = spawnSync(process.execPath, [script, mode], {
    cwd: root,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, BUILD_CACHE_PREFIX: prefix },
  });
  expect(result.error).toBeUndefined();
  return result;
}

async function fixture() {
  const root = await createTestTempDirectory("rea-ci-portable-cache-");
  await mkdir(join(root, ".turbo/cache"), { recursive: true });
  return root;
}

async function entry(root: string, hash: string, manifest = true) {
  for (const suffix of [
    ".tar.zst",
    "-meta.json",
    ...(manifest ? ["-manifest.json"] : []),
  ])
    await writeFile(
      join(root, ".turbo/cache", `${hash}${suffix}`),
      `${hash}${suffix}\n`,
    );
}

async function inventory(root: string, path: string) {
  const files = (await readdir(join(root, path)))
    .filter((name) => name !== reportName)
    .sort();
  return Promise.all(
    files.map(async (name) => [
      name,
      await readFile(join(root, path, name), "hex"),
    ]),
  );
}

it("publishes only current task companions without changing the source cache or retaining old snapshots", async () => {
  const root = await fixture();
  await entry(root, first.hash);
  await entry(root, second.hash, false);
  await entry(root, "aaaaaaaaaaaaaaaa");
  const before = await inventory(root, ".turbo/cache");
  const result = run(root, "snapshot");
  expect(result.status, result.stderr).toBe(0);
  const current = before.filter(
    ([name]) => name?.startsWith(first.hash) || name?.startsWith(second.hash),
  );
  expect(await inventory(root, output)).toEqual(current);
  expect(JSON.parse(result.stdout)).toMatchObject({
    tasks: 2,
    files: 5,
    path: output,
  });
  expect(run(root, "snapshot", { tasks: [second] }).status).toBe(0);
  expect(await inventory(root, output)).toEqual(
    before.filter(([name]) => name?.startsWith(second.hash)),
  );
  expect(await inventory(root, ".turbo/cache")).toEqual(before);
});

it("retains existing cross-run keys independent of plan order and invalidates changed task hashes", async () => {
  const root = await fixture();
  const digest = createHash("sha256")
    .update(
      plan.tasks
        .map(({ taskId, hash }) => `${taskId}:${hash}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  const expected = `key=${prefix}-${digest}\nprefix=${prefix}-\n`;
  const result = run(root, "key");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(expected);
  expect(run(root, "key", { tasks: [second, first] }).stdout).toBe(expected);
  const changed = run(root, "key", {
    tasks: [first, { ...second, hash: "aaaaaaaaaaaaaaaa" }],
  });
  expect(changed.status, changed.stderr).toBe(0);
  expect(changed.stdout).not.toBe(expected);
});

it("rejects malformed or ambiguous plans in both commands and removes stale publication output", async () => {
  const root = await fixture();
  for (const invalid of [
    "not JSON",
    {},
    { tasks: [] },
    { tasks: [{ taskId: "compile" }] },
    { tasks: [{ ...first, hash: null }] },
    { tasks: [{ ...first, hash: "../outside" }] },
    { tasks: [first, { ...first, hash: second.hash }] },
  ]) {
    await mkdir(join(root, output), { recursive: true });
    await writeFile(join(root, output, "old-success"), "stale");
    for (const mode of ["key", "snapshot"] as const) {
      const result = run(root, mode, invalid);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    await expect(readdir(join(root, output))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("reports cold or evicted task entries without publishing incomplete companions", async () => {
  const root = await fixture();
  const cold = run(root, "snapshot");
  expect(cold.status, cold.stderr).toBe(0);
  expect(await inventory(root, output)).toEqual([]);
  expect(
    JSON.parse(await readFile(join(root, output, reportName), "utf8")),
  ).toMatchObject({
    missingTasks: [first.taskId, second.taskId],
  });
  await entry(root, first.hash);
  for (const suffix of [".tar.zst", "-meta.json"]) {
    await entry(root, second.hash);
    await rm(join(root, ".turbo/cache", `${second.hash}${suffix}`));
    const result = run(root, "snapshot");
    expect(result.status, result.stderr).toBe(0);
    expect(await inventory(root, output)).toEqual(
      (await inventory(root, ".turbo/cache")).filter(([name]) =>
        name?.startsWith(first.hash),
      ),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      tasks: 2,
      cachedTasks: 1,
      missingTasks: [second.taskId],
    });
    expect(
      JSON.parse(await readFile(join(root, output, reportName), "utf8")),
    ).toMatchObject({
      missingTasks: [second.taskId],
    });
  }
});

it("fails publication on non-file entries and removes any earlier partial snapshot", async () => {
  const root = await fixture();
  await entry(root, first.hash);
  for (const suffix of [".tar.zst", "-meta.json", "-manifest.json"]) {
    await entry(root, second.hash);
    const path = join(root, ".turbo/cache", `${second.hash}${suffix}`);
    await rm(path);
    await mkdir(path);
    const result = run(root, "snapshot");
    expect(result.status, result.stderr).not.toBe(0);
    await expect(readdir(join(root, output))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(path, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "rejects symlinked archives and optional manifests without copying their targets",
  async () => {
    const root = await fixture();
    const outside = join(root, "outside");
    await writeFile(outside, "must not publish");
    for (const suffix of [".tar.zst", "-manifest.json"]) {
      await entry(root, first.hash);
      const path = join(root, ".turbo/cache", `${first.hash}${suffix}`);
      await rm(path);
      await symlink(outside, path);
      const result = run(root, "snapshot", { tasks: [first] });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("must be a regular file");
      await expect(readdir(join(root, output))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(outside, "utf8")).toBe("must not publish");
      await rm(path);
    }
  },
);

it("rebuilds actual Turbo outputs after restoring a report-only cache artifact", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".gitignore"),
    ".turbo/\nout/\n.build-count\n.cache/\n",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "portable-cache-consumer",
      private: true,
      packageManager: "npm@11.16.0",
      scripts: { build: "node build.mjs" },
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "portable-cache-consumer",
      lockfileVersion: 3,
      packages: {},
    }),
  );
  await writeFile(
    join(root, "turbo.json"),
    JSON.stringify({ tasks: { build: { outputs: ["out/**"] } } }),
  );
  await writeFile(
    join(root, "build.mjs"),
    `
    import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
    mkdirSync("out", { recursive: true });
    writeFileSync("out/result.json", JSON.stringify({ value: 42 }));
    writeFileSync(".build-count", String(existsSync(".build-count") ? Number(readFileSync(".build-count", "utf8")) + 1 : 1));
  `,
  );
  const turbo = fileURLToPath(
    new URL("../../../node_modules/turbo/bin/turbo", import.meta.url),
  );
  const build = (...extra: string[]) => {
    const result = spawnSync(
      process.execPath,
      [turbo, "run", "build", "--cache-dir=.turbo/cache", ...extra],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  const tasks = JSON.parse(build("--dry=json").stdout);
  expect(tasks.tasks).toHaveLength(1);
  build();
  await rm(join(root, ".turbo/cache"), { recursive: true });
  await rm(join(root, "out"), { recursive: true });
  expect(run(root, "snapshot", tasks).status).toBe(0);
  expect(await readdir(join(root, output))).toEqual([reportName]);
  await cp(join(root, output), join(root, ".turbo/cache"), { recursive: true });
  expect(JSON.parse(build("--dry=json").stdout).tasks[0].hash).toBe(
    tasks.tasks[0].hash,
  );
  build();
  expect(
    JSON.parse(await readFile(join(root, "out/result.json"), "utf8")),
  ).toEqual({ value: 42 });
  expect(await readFile(join(root, ".build-count"), "utf8")).toBe("2");
});
