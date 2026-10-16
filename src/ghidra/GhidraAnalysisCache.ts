import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type {
  GhidraHeadlessLauncherOptions,
  GhidraLaunchSession,
} from "./GhidraLauncher.js";

const manifestSchema = z.object({
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  archive: z.string().regex(/^[a-f0-9-]{36}\.gzf$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export interface GhidraAnalysisCache {
  readonly descriptorPath: string;
  readonly archivePath?: string;
}

/** Hash source scripts as well as the provider/profile, so bridge repairs invalidate old snapshots. */
async function cacheIdentity(
  session: GhidraLaunchSession,
  bridgeScriptPath: string,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      schema: 1,
      target: session.targetSha256,
      provider: session.providerVersion,
      profile: session.profileDigest,
    }),
  );
  const directory = dirname(bridgeScriptPath);
  const scripts = (await readdir(directory))
    .filter((name) => name.endsWith(".java"))
    .sort();
  for (const script of scripts) {
    hash.update(script);
    hash.update(await readFile(join(directory, script)));
  }
  return hash.digest("hex");
}

async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(
    path,
    signal === undefined ? {} : { signal },
  ))
    hash.update(chunk);
  return hash.digest("hex");
}

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Copy before validating: cache clearing or another writer cannot change the admitted snapshot. */
async function restoreSnapshot(
  directory: string,
  identity: string,
  destination: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let metadata: string;
  try {
    const path = join(directory, "ready.json");
    if ((await stat(path)).size > 4096) return false;
    metadata = await readFile(path, "utf8");
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return false;
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success || result.data.identity !== identity) return false;
  const manifest = result.data;
  try {
    await copyFile(
      join(directory, manifest.archive),
      destination,
      constants.COPYFILE_FICLONE,
    );
    if (
      (await stat(destination)).size === manifest.size &&
      (await fileDigest(destination, signal)) === manifest.sha256
    ) {
      return true;
    }
  } catch (error) {
    if (!absent(error)) throw error;
  }
  await rm(destination, { force: true });
  return false;
}

/** Opt-in immutable analysis snapshots; live session edits never write back into this cache. */
async function prepareCache(
  session: GhidraLaunchSession,
  options: GhidraHeadlessLauncherOptions,
  signal?: AbortSignal,
): Promise<GhidraAnalysisCache | undefined> {
  const root = options.environment.REA_GHIDRA_CACHE_DIR;
  if (!root || (options.platform ?? process.platform) === "win32")
    return undefined;

  signal?.throwIfAborted();
  const identity = await cacheIdentity(session, options.bridgeScriptPath);
  const directory = join(root, identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const archivePath = join(session.runtimeRoot, "cached-analysis.gzf");
  const reused = await restoreSnapshot(
    directory,
    identity,
    archivePath,
    signal,
  );
  const descriptorPath = join(session.runtimeRoot, "analysis-cache.json");
  await writeFile(
    descriptorPath,
    JSON.stringify({
      directory,
      identity,
      target_sha256: session.targetSha256,
      reused,
    }),
    { mode: 0o600, flag: "wx" },
  );
  return { descriptorPath, ...(reused ? { archivePath } : {}) };
}

/** Cache storage is an optimization: a failure is reported, then ordinary analysis remains available. */
export async function prepareGhidraAnalysisCache(
  session: GhidraLaunchSession,
  options: GhidraHeadlessLauncherOptions,
  signal?: AbortSignal,
): Promise<GhidraAnalysisCache | undefined> {
  try {
    return await prepareCache(session, options, signal);
  } catch (failure) {
    const failures: unknown[] = [failure];
    for (const name of ["cached-analysis.gzf", "analysis-cache.json"]) {
      try {
        await rm(join(session.runtimeRoot, name), { force: true });
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (signal?.aborted)
      throw new AggregateError(
        failures,
        "Analysis cache preparation was cancelled",
      );
    console.error(
      "REA analysis cache unavailable; running normal analysis:",
      new AggregateError(failures),
    );
    return undefined;
  }
}
