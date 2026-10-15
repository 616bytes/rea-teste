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

describe("app bundle program containment", () => {
  it("rejects an app bundle whose Contents/MacOS resolves outside the bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bundle-outside-"));
    try {
      const bundle = join(root, "Evil.app");
      const contents = join(bundle, "Contents");
      const plistPath = join(contents, "Info.plist");
      const programs = join(contents, "MacOS");
      const outsideDir = join(root, "outside-bin");
      const outsideExecutable = join(outsideDir, "true");
      await mkdir(contents, { recursive: true });
      const plistContent =
        "<plist><dict><key>CFBundleExecutable</key><string>true</string></dict></plist>";
      await writeFile(plistPath, plistContent);
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async (p) =>
          p === plistPath ? Buffer.from(plistContent) : Buffer.alloc(0),
        realpath: async (p) => {
          if (p === bundle) return bundle;
          if (p === programs) return outsideDir;
          if (p === join(programs, "true")) return outsideExecutable;
          return p;
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected resolution to fail");
      expect(result.error.message).toContain(
        "app program file leaves Contents/MacOS",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a flat app bundle whose program file resolves outside the bundle root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-flat-outside-"));
    try {
      const bundle = join(root, "FlatEvil.app");
      const plistPath = join(bundle, "Info.plist");
      const outsideExecutable = join(root, "outside-true");
      await mkdir(bundle, { recursive: true });
      const plistContent =
        "<plist><dict><key>CFBundleExecutable</key><string>true</string></dict></plist>";
      await writeFile(plistPath, plistContent);
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async (p) =>
          p === plistPath ? Buffer.from(plistContent) : Buffer.alloc(0),
        realpath: async (p) => {
          if (p === bundle) return bundle;
          if (p === join(bundle, "true")) return outsideExecutable;
          return p;
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected resolution to fail");
      expect(result.error.message).toContain(
        "app program file leaves the bundle root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a symlinked app bundle whose executable stays within the canonical bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bundle-symlink-"));
    try {
      const canonicalBundle = join(root, "Real.app");
      const symlinkBundle = join(root, "Alias.app");
      const contents = join(canonicalBundle, "Contents");
      const plistPath = join(contents, "Info.plist");
      const programs = join(contents, "MacOS");
      const realExecutable = join(programs, "RealApp");
      await mkdir(programs, { recursive: true });
      await mkdir(join(symlinkBundle, "Contents"), { recursive: true });
      const plistContent =
        "<plist><dict><key>CFBundleExecutable</key><string>RealApp</string></dict></plist>";
      await writeFile(plistPath, plistContent);
      await writeFile(
        join(symlinkBundle, "Contents", "Info.plist"),
        plistContent,
      );
      const result = await resolveAppBundleExecutable(symlinkBundle, {
        readFile: async () => Buffer.from(plistContent),
        realpath: async (p) => {
          if (p === symlinkBundle) return canonicalBundle;
          if (p === join(symlinkBundle, "Contents", "MacOS")) return programs;
          if (p === join(symlinkBundle, "Contents", "MacOS", "RealApp"))
            return realExecutable;
          return p;
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected resolution to succeed");
      expect(result.value.executable).toBe(realExecutable);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an app bundle whose Contents/MacOS leaves the bundle even when the executable does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bundle-outside-missing-"));
    try {
      const bundle = join(root, "Evil.app");
      const contents = join(bundle, "Contents");
      const plistPath = join(contents, "Info.plist");
      const programs = join(contents, "MacOS");
      const outsideDir = join(root, "outside-bin");
      await mkdir(contents, { recursive: true });
      const plistContent =
        "<plist><dict><key>CFBundleExecutable</key><string>nonexistent</string></dict></plist>";
      await writeFile(plistPath, plistContent);
      const result = await resolveAppBundleExecutable(bundle, {
        readFile: async (p) =>
          p === plistPath ? Buffer.from(plistContent) : Buffer.alloc(0),
        realpath: async (p) => {
          if (p === bundle) return bundle;
          if (p === programs) return outsideDir;
          if (p === join(programs, "nonexistent")) {
            const error = new Error("file missing");
            Reflect.set(error, "code", "ENOENT");
            throw error;
          }
          return p;
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected resolution to fail");
      expect(result.error.message).toContain(
        "app program file leaves Contents/MacOS",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
