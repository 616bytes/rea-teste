import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAppBundleExecutable } from "./AppBundleExecutable.js";

describe("app bundle Info.plist magic", () => {
  it("does not decode a high-bit fold of bplist as a binary Info.plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bplist-fold-"));
    try {
      const bundle = join(root, "Fixture.app");
      const plistPath = join(bundle, "Contents", "Info.plist");
      await mkdir(join(bundle, "Contents"), { recursive: true });
      const plist = Buffer.from("bplist00");
      plist[0] = (plist[0] ?? 0) | 0x80;
      await writeFile(plistPath, plist);
      let decoded = false;
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => plist,
        realpath: async (path) => path,
        decodeBinaryPlist: async () => {
          decoded = true;
          return "Fixture";
        },
      });
      expect(decoded).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("app bundle program directory containment", () => {
  const plist =
    "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>";

  it("rejects an escaping programs directory before resolving its executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-programs-escape-"));
    try {
      const bundle = join(root, "Selected.app");
      const programs = join(bundle, "Contents", "MacOS");
      const executable = join(programs, "Fixture");
      const plistPath = join(bundle, "Contents", "Info.plist");
      const canonicalBundle = join(root, "Canonical.app");
      const outsidePrograms = join(root, "outside");
      await mkdir(join(bundle, "Contents"), { recursive: true });
      await writeFile(plistPath, plist);
      let resolvedExecutable = false;

      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => Buffer.from(plist),
        realpath: async (path) => {
          if (path === bundle) return canonicalBundle;
          if (path === programs) return outsidePrograms;
          if (path === executable) {
            resolvedExecutable = true;
            return join(outsidePrograms, "Fixture");
          }
          return path;
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: { reason: "app program directory leaves Contents/MacOS" },
      });
      expect(resolvedExecutable).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a bundle alias when its canonical programs directory stays inside", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-programs-alias-"));
    try {
      const bundle = join(root, "Alias.app");
      const canonicalBundle = join(root, "Real.app");
      const contents = join(bundle, "Contents");
      const programs = join(contents, "MacOS");
      const executable = join(programs, "Fixture");
      const canonicalPrograms = join(canonicalBundle, "Contents", "MacOS");
      const canonicalExecutable = join(canonicalPrograms, "Fixture");
      const plistPath = join(contents, "Info.plist");
      await mkdir(contents, { recursive: true });
      await writeFile(plistPath, plist);

      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async () => Buffer.from(plist),
        realpath: async (path) => {
          if (path === bundle) return canonicalBundle;
          if (path === programs) return canonicalPrograms;
          if (path === executable) return canonicalExecutable;
          return path;
        },
      });

      expect(result).toMatchObject({
        ok: true,
        value: { executable: canonicalExecutable, infoPlist: plistPath },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
