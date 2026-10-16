import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

// Descriptor admission and close ownership are exercised through a synthetic
// filesystem seam; the real POSIX FIFO/close-failure behavior is covered by the
// process-global and Cutter lifetime suites.

let root: string | undefined;

const installation = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-psp-ownership-"));
  root = join(directory, "Ghidra", "Extensions", "ghidra-allegrex");
  const contents = {
    "Module.manifest": "",
    "extension.properties": "name=ghidra-allegrex\nversion=12.1.3\n",
    "data/languages/allegrex.ldefs": "synthetic language definition",
    "data/languages/allegrex.sla": "synthetic compiled processor",
    "data/languages/allegrex.pspec": "synthetic processor specification",
    "data/languages/allegrex.cspec": "synthetic compiler specification",
    "lib/extension.jar": "synthetic loader artifact",
  };
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

const installationInspection = (directory: string) =>
  ({
    status: "available",
    platform: "linux",
    architecture: "x64",
    installDir: dirname(dirname(dirname(directory))),
    providerVersion: "12.1.3",
  }) as never;

afterEach(async () => {
  if (root !== undefined)
    await rm(dirname(dirname(dirname(root))), { recursive: true, force: true });
  root = undefined;
  vi.doUnmock("node:fs/promises");
  await vi.resetModules();
});

/**
 * Mock `open` to report a synthetic read failure and a close that fails the
 * first `closeFailures` attempts, then succeeds. Real handles are tracked so
 * the test can release any the injected failure left open.
 */
const mockComponentOpen = async (closeFailures: number) => {
  const real =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const opened: FileHandle[] = [];
  let closes = 0;
  vi.doMock("node:fs/promises", () => ({
    ...real,
    open: async (path: Parameters<typeof real.open>[0]) => {
      const handle = await real.open(path);
      opened.push(handle);
      return {
        fd: handle.fd,
        stat: async () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 8,
          uid: process.getuid?.() ?? 0,
          mode: 0o100600,
        }),
        read: async () => ({ bytesRead: 0 }),
        close: async () => {
          closes += 1;
          if (closes <= closeFailures)
            throw new Error("synthetic close failure");
          await handle.close();
        },
      };
    },
  }));
  return {
    release: async () => {
      await Promise.allSettled(opened.map((handle) => handle.close()));
    },
  };
};

describe("PSP extension descriptor ownership", () => {
  it("preserves the physical read failure and retains the unconfirmed close owner", async () => {
    const directory = await installation();
    await vi.resetModules();
    const opened = await mockComponentOpen(Number.POSITIVE_INFINITY);
    try {
      const { inspectGhidraPspExtension } =
        await import("../../../src/ghidra/GhidraPspExtension.js");
      const { ArtifactReaderFailure } =
        await import("../../../src/artifacts/ArtifactReader.js");
      const failure = await inspectGhidraPspExtension(
        directory,
        "12.1.3",
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected an artifact failure");
      // The earlier physical failure stays primary; the close failure is cleanup.
      expect(failure.message).not.toContain("synthetic close failure");
      expect(
        failure.cleanup?.resources.some((resource) =>
          resource.startsWith(directory),
        ),
      ).toBe(true);
    } finally {
      await opened.release();
    }
  });

  it("clears the reported cleanup once the retry confirms the descriptor release", async () => {
    const directory = await installation();
    await vi.resetModules();
    // The first close fails and is retained; the scope retry then succeeds.
    const opened = await mockComponentOpen(1);
    try {
      const { resolveGhidraPspExtension } =
        await import("../../../src/ghidra/GhidraPspExtension.js");
      const result = await resolveGhidraPspExtension(
        installationInspection(directory),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an unavailable resolution");
      // The retry confirmed the close, so no descriptor remains owned and the
      // reported error must not claim incomplete cleanup.
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      await opened.release();
    }
  });

  it("keeps the cleanup owner linked while the close stays unconfirmed", async () => {
    const directory = await installation();
    await vi.resetModules();
    const opened = await mockComponentOpen(Number.POSITIVE_INFINITY);
    try {
      const { inspectGhidraPspExtension } =
        await import("../../../src/ghidra/GhidraPspExtension.js");
      const { ArtifactReaderFailure } =
        await import("../../../src/artifacts/ArtifactReader.js");
      const failure = await inspectGhidraPspExtension(
        directory,
        "12.1.3",
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected an artifact failure");
      // The unresolved close keeps the exact descriptor owner as cleanup, and
      // the owner-carrying type survives so a later release can clear it.
      expect(
        failure.cleanup?.resources.some((resource) =>
          resource.startsWith(directory),
        ),
      ).toBe(true);
      const leases = (failure as { cleanupLeases?: readonly unknown[] })
        .cleanupLeases;
      expect(Array.isArray(leases)).toBe(true);
      expect(leases?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await opened.release();
    }
  });

  it("keeps a physical inspection failure when the caller aborts afterwards", async () => {
    const directory = await installation();
    const controller = new AbortController();
    await vi.resetModules();
    const real =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const opened: FileHandle[] = [];
    vi.doMock("node:fs/promises", () => ({
      ...real,
      open: async (path: Parameters<typeof real.open>[0]) => {
        const handle = await real.open(path);
        opened.push(handle);
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          read: async () => {
            // A physical read failure is produced first; the caller signal
            // aborts only afterwards, during the same failed operation.
            controller.abort(new Error("caller cancelled after the failure"));
            return { bytesRead: 0 };
          },
          close: () => handle.close(),
        };
      },
    }));
    try {
      const { resolveGhidraPspExtension } =
        await import("../../../src/ghidra/GhidraPspExtension.js");
      const result = await resolveGhidraPspExtension(
        installationInspection(directory),
        controller.signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an unavailable resolution");
      // The physical failure is primary; a later cancellation must not replace it.
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    } finally {
      await Promise.allSettled(opened.map((handle) => handle.close()));
    }
  });
});
