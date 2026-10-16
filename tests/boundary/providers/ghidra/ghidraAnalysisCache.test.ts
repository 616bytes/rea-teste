import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { prepareGhidraAnalysisCache } from "../../../../src/ghidra/GhidraAnalysisCache.js";
import {
  ghidraHeadlessArguments,
  type GhidraHeadlessLauncherOptions,
  type GhidraLaunchSession,
} from "../../../../src/ghidra/GhidraLauncher.js";
import { z } from "zod";

const descriptorSchema = z.object({
  directory: z.string(),
  identity: z.string(),
  reused: z.boolean(),
});

async function fixture(): Promise<{
  readonly root: string;
  readonly session: GhidraLaunchSession;
  readonly options: GhidraHeadlessLauncherOptions;
}> {
  const root = await createTestTempDirectory("rea-analysis-cache-");
  const bridge = join(root, "bridge");
  const runtimeRoot = join(root, "runtime");
  await mkdir(bridge);
  await mkdir(runtimeRoot);
  const bridgeScriptPath = join(bridge, "ReaGhidraBridge.java");
  await writeFile(bridgeScriptPath, "fixture bridge source");
  return {
    root,
    session: {
      runtimeRoot,
      transport: "unix-socket",
      endpointPath: join(runtimeRoot, "socket"),
      token: "fixture",
      runId: randomUUID(),
      targetPath: join(root, "target"),
      targetSha256: "a".repeat(64),
      providerVersion: "12.1.3",
      profileDigest: "profile-one",
    },
    options: {
      environment: { REA_GHIDRA_CACHE_DIR: join(root, "cache") },
      analyzeHeadlessPath: join(root, "analyzeHeadless"),
      bridgeScriptPath,
      platform: "darwin",
    },
  };
}

async function publish(
  session: GhidraLaunchSession,
  options: GhidraHeadlessLauncherOptions,
): Promise<{
  readonly directory: string;
  readonly archive: string;
  readonly bytes: Buffer;
}> {
  const cold = await prepareGhidraAnalysisCache(session, options);
  if (!cold) throw new Error("Expected opt-in cache plan");
  expect(cold.archivePath).toBeUndefined();
  const descriptor = descriptorSchema.parse(
    JSON.parse(await readFile(cold.descriptorPath, "utf8")),
  );
  const archive = randomUUID() + ".gzf";
  const bytes = Buffer.from("complete immutable database fixture");
  await writeFile(join(descriptor.directory, archive), bytes);
  await writeFile(
    join(descriptor.directory, "ready.json"),
    JSON.stringify({
      identity: descriptor.identity,
      archive,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  return { directory: descriptor.directory, archive, bytes };
}

async function nextSession(
  session: GhidraLaunchSession,
): Promise<GhidraLaunchSession> {
  const runtimeRoot = session.runtimeRoot + "-" + randomUUID();
  await mkdir(runtimeRoot);
  return { ...session, runtimeRoot };
}

describe("immutable Ghidra analysis reuse", () => {
  it("uses only a verified private copy and skips analysis on a valid hit", async () => {
    const { session, options } = await fixture();
    const saved = await publish(session, options);
    const next = await nextSession(session);
    const cache = await prepareGhidraAnalysisCache(next, options);
    if (!cache?.archivePath) throw new Error("Expected a valid cache hit");
    await rm(join(saved.directory, saved.archive));
    expect(await readFile(cache.archivePath)).toEqual(saved.bytes);
    const args = ghidraHeadlessArguments({
      projectRoot: next.runtimeRoot,
      targetPath: next.targetPath,
      bridgeScriptPath: options.bridgeScriptPath,
      descriptorPath: join(next.runtimeRoot, "session.json"),
      ghidraLogPath: join(next.runtimeRoot, "ghidra.log"),
      scriptLogPath: join(next.runtimeRoot, "script.log"),
      analysisCache: cache,
    });
    expect(args).toContain("-noanalysis");
    expect(args).toContain(cache.archivePath);
    expect(args.indexOf(cache.descriptorPath)).toBeLessThan(
      args.indexOf(options.bridgeScriptPath),
    );
  });

  it("rejects corrupt archives and interrupted publication while retaining the prior manifest", async () => {
    const { session, options } = await fixture();
    const saved = await publish(session, options);
    const before = await readFile(join(saved.directory, "ready.json"));
    await writeFile(
      join(saved.directory, "incomplete.gzf.pending"),
      "unfinished",
    );
    expect(
      (await prepareGhidraAnalysisCache(await nextSession(session), options))
        ?.archivePath,
    ).toBeDefined();
    await writeFile(
      join(saved.directory, saved.archive),
      Buffer.alloc(saved.bytes.length, 0),
    );
    expect(
      (await prepareGhidraAnalysisCache(await nextSession(session), options))
        ?.archivePath,
    ).toBeUndefined();
    expect(await readFile(join(saved.directory, "ready.json"))).toEqual(before);
  });

  it("invalidates on target bytes, Ghidra version, analysis profile, and bridge source changes", async () => {
    const { session, options } = await fixture();
    await publish(session, options);
    for (const changed of [
      { targetSha256: "b".repeat(64) },
      { providerVersion: "12.2" },
      { profileDigest: "profile-two" },
    ]) {
      const next = await nextSession({ ...session, ...changed });
      expect(
        (await prepareGhidraAnalysisCache(next, options))?.archivePath,
      ).toBeUndefined();
    }
    await writeFile(options.bridgeScriptPath, "updated bridge repair");
    expect(
      (await prepareGhidraAnalysisCache(await nextSession(session), options))
        ?.archivePath,
    ).toBeUndefined();
  });

  it("does not trust path traversal or oversized metadata", async () => {
    const { session, options } = await fixture();
    const saved = await publish(session, options);
    const manifest = join(saved.directory, "ready.json");
    const valid: unknown = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({
        ...z.record(z.string(), z.unknown()).parse(valid),
        archive: "../outside.gzf",
      }),
    );
    expect(
      (await prepareGhidraAnalysisCache(await nextSession(session), options))
        ?.archivePath,
    ).toBeUndefined();
    await writeFile(manifest, " ".repeat(4097));
    expect(
      (await prepareGhidraAnalysisCache(await nextSession(session), options))
        ?.archivePath,
    ).toBeUndefined();
  });

  it("reports unavailable cache storage and allows an ordinary analysis launch", async () => {
    const { root, session, options } = await fixture();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "preserve this file");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await prepareGhidraAnalysisCache(session, {
          ...options,
          environment: { REA_GHIDRA_CACHE_DIR: blocked },
        }),
      ).toBeUndefined();
      expect(report).toHaveBeenCalledOnce();
      expect(await readFile(blocked, "utf8")).toBe("preserve this file");
    } finally {
      report.mockRestore();
    }
  });

  it("keeps persistence opt-in and preserves the Windows read-only boundary", async () => {
    const { session, options } = await fixture();
    expect(
      await prepareGhidraAnalysisCache(session, {
        ...options,
        environment: {},
      }),
    ).toBeUndefined();
    expect(
      await prepareGhidraAnalysisCache(session, {
        ...options,
        platform: "win32",
      }),
    ).toBeUndefined();
  });
});
