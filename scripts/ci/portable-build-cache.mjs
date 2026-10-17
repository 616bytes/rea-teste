import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const output = ".cache/ci-build-cache";

function readTasks() {
  const { tasks } = z
    .object({
      tasks: z
        .array(
          z.object({
            taskId: z.string().min(1),
            // The pinned Turbo version uses eager 64-bit hexadecimal hashes.
            hash: z.string().regex(/^[0-9a-f]{16}$/u),
          }),
        )
        .min(1),
    })
    .parse(JSON.parse(readFileSync(0, "utf8")));
  const identities = new Set();
  for (const { taskId } of tasks) {
    if (identities.has(taskId))
      throw new Error(`Duplicate portable build task: ${taskId}`);
    identities.add(taskId);
  }
  return tasks;
}

// Cache retention is owned by Turbo and may evict companions at any time.
// Publish only complete task entries; missing entries are ordinary cache misses.
async function copyTaskCache(hash) {
  const copied = [];
  let bytes = 0;
  try {
    for (const suffix of [".tar.zst", "-meta.json", "-manifest.json"]) {
      const name = `${hash}${suffix}`;
      const source = join(".turbo/cache", name);
      const entry = await lstat(source).catch((error) => {
        if (suffix === "-manifest.json" && error.code === "ENOENT")
          return undefined;
        throw error;
      });
      if (entry === undefined) continue;
      if (!entry.isFile())
        throw new Error(
          `Portable build cache entry must be a regular file: ${source}`,
        );
      copied.push(name);
      await copyFile(source, join(output, name));
      bytes += entry.size;
    }
    return { files: copied.length, bytes };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A vanished companion must not leave an orphan archive eligible for reuse.
    for (const name of copied) await rm(join(output, name), { force: true });
    return undefined;
  }
}

async function snapshot(tasks) {
  await mkdir(output, { recursive: true });
  let files = 0;
  let bytes = 0;
  const cached = new Set();
  try {
    for (const hash of new Set(tasks.map((task) => task.hash))) {
      const entry = await copyTaskCache(hash);
      if (entry === undefined) continue;
      cached.add(hash);
      files += entry.files;
      bytes += entry.bytes;
    }
    const report = {
      tasks: tasks.length,
      cachedTasks: tasks.filter(({ hash }) => cached.has(hash)).length,
      missingTasks: tasks
        .filter(({ hash }) => !cached.has(hash))
        .map(({ taskId }) => taskId),
      files,
      bytes,
      path: output,
    };
    // Keep an uploadable report even when every optional entry was evicted.
    // Consumers still run their required preparation and rebuild on cache misses.
    await writeFile(
      join(output, "snapshot-report.json"),
      JSON.stringify(report) + "\n",
    );
    console.log(JSON.stringify(report));
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !["key", "snapshot"].includes(mode))
  throw new Error(
    "Usage: portable-build-cache.mjs key|snapshot < turbo-dry-plan.json",
  );
// Remove any earlier snapshot before parsing: a failed second invocation must
// never leave an old successful artifact eligible for upload.
if (mode === "snapshot") await rm(output, { recursive: true, force: true });
const tasks = readTasks();
if (mode === "key") {
  const prefix = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/u)
    .parse(process.env.BUILD_CACHE_PREFIX);
  const hashes = tasks.map(({ taskId, hash }) => `${taskId}:${hash}`).sort();
  const digest = createHash("sha256").update(hashes.join("\n")).digest("hex");
  console.log(`key=${prefix}-${digest}\nprefix=${prefix}-`);
} else {
  await snapshot(tasks);
}
