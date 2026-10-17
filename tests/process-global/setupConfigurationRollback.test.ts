import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, expect, it, onTestFinished, vi } from "vitest";

const state = vi.hoisted(() => ({
  readbackFailed: false,
  rejectRestore: false,
  rejectRemove: false,
  removeCopiedRecovery: false,
  initialCleanupFailure: undefined as unknown,
  readbackCleanupFailure: undefined as unknown,
  rollbackCleanupFailure: undefined as unknown,
  readbackAttempted: false,
  beforeReadbackFailure: undefined as
    | undefined
    | ((path: string) => Promise<void>),
}));

afterEach(() => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.removeCopiedRecovery = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  state.rollbackCleanupFailure = undefined;
  state.readbackAttempted = false;
  state.beforeReadbackFailure = undefined;
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: (
      ...arguments_: Parameters<typeof original.rm>
    ): ReturnType<typeof original.rm> => {
      if (state.rejectRemove && state.readbackFailed)
        return Promise.reject(new Error("injected restore remove failure"));
      return original.rm(...arguments_);
    },
    writeFile: (
      ...arguments_: Parameters<typeof original.writeFile>
    ): ReturnType<typeof original.writeFile> => {
      if (state.rejectRestore && state.readbackFailed)
        return Promise.reject(new Error("injected restore write failure"));
      return original.writeFile(...arguments_);
    },
    copyFile: async (
      ...arguments_: Parameters<typeof original.copyFile>
    ): Promise<void> => {
      await original.copyFile(...arguments_);
      const destination = arguments_[1];
      if (
        state.removeCopiedRecovery &&
        typeof destination === "string" &&
        destination.endsWith(".recovery")
      )
        await original.rm(destination);
    },
  };
});

vi.mock("write-file-atomic", async (importOriginal) => {
  const original = await importOriginal<{
    default: typeof import("write-file-atomic");
  }>();
  return {
    ...original,
    default: async (...arguments_: Parameters<typeof original.default>) => {
      if (state.initialCleanupFailure !== undefined)
        throw new Error("unexpected config write before initial read");
      const result = await original.default(...arguments_);
      state.readbackFailed = true;
      return result;
    },
  };
});

vi.mock("../../src/application/RegularFileRead.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/application/RegularFileRead.js")
    >();
  return {
    ...original,
    readRegularFileText: (
      ...arguments_: Parameters<typeof original.readRegularFileText>
    ) =>
      state.initialCleanupFailure !== undefined
        ? Promise.reject(state.initialCleanupFailure)
        : original.readRegularFileText(...arguments_),
    readRegularFileTextSnapshot: async (
      ...arguments_: Parameters<typeof original.readRegularFileTextSnapshot>
    ) => {
      if (state.readbackFailed && !state.readbackAttempted) {
        state.readbackAttempted = true;
        await state.beforeReadbackFailure?.(arguments_[0]);
        throw (
          state.readbackCleanupFailure ?? new Error("injected readback failure")
        );
      }
      if (state.readbackFailed && state.rollbackCleanupFailure !== undefined)
        throw state.rollbackCleanupFailure;
      return original.readRegularFileTextSnapshot(...arguments_);
    },
  };
});

import { configureClientConfiguration } from "../../src/application/SetupClientConfiguration.js";
import { RegularFileCleanupFailure } from "../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import type { DoctorHost } from "../../src/application/Doctor.js";
import { systemSetupHost } from "../../src/application/SetupHost.js";
import { ConfigurationError } from "../../src/domain/configurationErrors.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const ownReadHandle = async (path: string) => {
  const owner = new OwnedFileHandle(await open(path, "r"));
  onTestFinished(() => owner.close());
  return owner;
};

it("reports a failed config rollback and retains its backup path", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-rollback-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  state.rejectRestore = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );

  expect(result).toEqual({
    status: "failed",
    reason: "rollback",
    backupPath: `${path}.rea.backup`,
    failure: {
      kind: "restore",
      path,
      detail: "injected restore write failure",
    },
  });
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    mcpServers: { rea: { command: "rea", args: ["mcp"] } },
  });
});

it("preserves the first backup and reports a verified backup of the current original", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-stale-backup-");
  const path = join(root, "client.json");
  const firstOriginal = '{"keep":"first"}\n';
  const currentOriginal = '{"keep":"current"}\n';
  await import("node:fs/promises").then(async ({ writeFile }) => {
    await writeFile(path, currentOriginal);
    await writeFile(`${path}.rea.backup`, firstOriginal);
  });
  state.rejectRestore = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );
  state.rejectRestore = false;

  const recoveryPath = `${path}.rea.backup.${createHash("sha256")
    .update(currentOriginal, "utf8")
    .digest("hex")}.recovery`;
  expect(result).toMatchObject({
    status: "failed",
    reason: "rollback",
    backupPath: recoveryPath,
    failure: {
      kind: "restore",
      path,
      detail: "injected restore write failure",
    },
  });
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(firstOriginal);
  expect(await readFile(recoveryPath, "utf8")).toBe(currentOriginal);
});

it("does not write config when a recovery copy disappears before verification", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.removeCopiedRecovery = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-vanished-recovery-");
  const path = join(root, "client.json");
  const firstOriginal = '{"keep":"first"}\n';
  const currentOriginal = '{"keep":"current"}\n';
  await import("node:fs/promises").then(async ({ writeFile }) => {
    await writeFile(path, currentOriginal);
    await writeFile(`${path}.rea.backup`, firstOriginal);
  });
  state.removeCopiedRecovery = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );
  state.removeCopiedRecovery = false;

  expect(result).toEqual({ status: "failed", reason: "backup" });
  expect(await readFile(path, "utf8")).toBe(currentOriginal);
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(firstOriginal);
});

it("does not roll back or remove config when its initial read cleanup fails", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-initial-cleanup-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  const failure = new RegularFileCleanupFailure(
    path,
    await ownReadHandle(path),
    { kind: "completed", value: original },
    new Error("injected initial close failure"),
  );
  state.initialCleanupFailure = failure;

  await expect(
    configureClientConfiguration(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    ),
  ).rejects.toBe(failure);
  expect(await readFile(path, "utf8")).toBe(original);
});

it("reports first-run rollback removal failure without a backup", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-first-run-rollback-");
  const path = join(root, "client.json");
  state.rejectRemove = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );
  state.rejectRemove = false;

  expect(result).toMatchObject({
    status: "failed",
    reason: "rollback",
    failure: {
      kind: "restore",
      path,
      detail: "injected restore remove failure",
    },
  });
  expect(result).not.toHaveProperty("backupPath");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    mcpServers: { rea: { command: "rea", args: ["mcp"] } },
  });
});

it("retains readback cleanup ownership when rollback also fails", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.rejectRemove = false;
  state.initialCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-readback-cleanup-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  const owner = await ownReadHandle(path);
  const cleanupFailure = new RegularFileCleanupFailure(
    path,
    owner,
    { kind: "completed", value: "" },
    new Error("injected readback close failure"),
  );
  state.readbackCleanupFailure = cleanupFailure;
  state.rejectRestore = true;

  const host = systemSetupHost(
    { platform: "linux", homeDirectory: root } as DoctorHost,
    { HOME: root },
  );
  let caught: unknown;
  try {
    await host.configureClient(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    );
  } catch (cause: unknown) {
    caught = cause;
  } finally {
    await host.close?.();
  }

  if (!(caught instanceof ConfigurationError)) throw caught;
  expect(caught.message).toContain("injected restore write failure");
  expect(caught.message).toContain(`${path}.rea.backup`);
  const cleanupOwnerError = caught.cause;
  if (!(cleanupOwnerError instanceof RegularFileCleanupFailure))
    throw new Error("Configuration failure lost its read owner");
  expect(cleanupOwnerError).toMatchObject({
    path,
    outcome: { kind: "completed", value: "" },
    cleanupCause: expect.any(AggregateError),
  });
  expect(cleanupOwnerError.owner).toBe(owner);
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
});

it.each([false, true])(
  "preserves a concurrent update before rollback (existing file: %s)",
  async (existing) => {
    const root = await createTestTempDirectory("rea-config-rollback-conflict-");
    const path = join(root, "client.json");
    const original = '{"keep":"original"}\n';
    const changed = '{"keep":"external"}\n';
    if (existing) await writeFile(path, original);
    state.beforeReadbackFailure = (target) => writeFile(target, changed);

    const result = await configureClientConfiguration({
      name: "cursor",
      configPath: path,
      format: "json",
    });

    expect(result).toMatchObject({ status: "failed", reason: "conflict" });
    expect(await readFile(path, "utf8")).toBe(changed);
    if (existing)
      expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  },
);

it("retains both readback and rollback read owners until host cleanup can release them", async () => {
  const root = await createTestTempDirectory("rea-config-two-read-owners-");
  const path = join(root, "client.json");
  const original = '{"keep":"original"}\n';
  await writeFile(path, original);
  const primary = await ownReadHandle(path);
  const secondary = await ownReadHandle(path);
  const primaryClose = vi
    .spyOn(primary.handle, "close")
    .mockRejectedValue(new Error("primary close held"));
  const secondaryClose = vi
    .spyOn(secondary.handle, "close")
    .mockRejectedValue(new Error("secondary close held"));
  state.readbackCleanupFailure = new RegularFileCleanupFailure(
    path,
    primary,
    { kind: "failed", cause: new Error("readback unavailable") },
    new Error("primary close held"),
  );
  state.rollbackCleanupFailure = new RegularFileCleanupFailure(
    path,
    secondary,
    { kind: "failed", cause: new Error("rollback read unavailable") },
    new Error("secondary close held"),
  );
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: root } as DoctorHost,
    { HOME: root },
  );
  try {
    await expect(
      host.configureClient(
        { name: "cursor", configPath: path, format: "json" },
        {},
        ["rea", "mcp"],
      ),
    ).rejects.toMatchObject({
      cause: {
        owner: primary,
        rollbackCleanupFailure: { owner: secondary },
      },
    });
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  } finally {
    primaryClose.mockRestore();
    secondaryClose.mockRestore();
    expect(await host.close?.()).toBeUndefined();
  }
  expect(primary.handle.fd).toBe(-1);
  expect(secondary.handle.fd).toBe(-1);
});
