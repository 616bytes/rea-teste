import type { Stats } from "node:fs";
import { lstat, rm, writeFile } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

import { err, ok, type Result } from "../domain/result.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  readRegularFileTextSnapshot,
  RegularFileCleanupFailure,
  type RegularFileTextSnapshot,
} from "./RegularFileRead.js";

/** A valid backup does not establish that the write target is still current. */
export class ClientConfigurationConflict extends Error {
  readonly _tag = "ClientConfigurationConflict";
  constructor(readonly path: string) {
    super(`Client configuration changed during setup: ${path}`);
  }
}

const activeTransactions = new Map<string, Promise<void>>();

/** Serialize the complete read/merge/write workflow, not just its final rename. */
export const withClientConfigurationTransaction = async <Value>(
  path: string,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const previous = activeTransactions.get(path);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTransactions.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeTransactions.get(path) === current)
      activeTransactions.delete(path);
  }
};

const readSnapshot = async (
  path: string,
): Promise<RegularFileTextSnapshot | undefined> => {
  try {
    return await readRegularFileTextSnapshot(path, { symlinks: "reject" });
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

interface InstalledConfiguration {
  readonly identity: Stats;
  readonly text: string;
}

/** Own the original snapshot and the identity/content installed by this write. */
export class ClientConfigurationTransaction {
  #installed: InstalledConfiguration | undefined;

  private constructor(
    readonly path: string,
    private readonly requestedPath: string,
    private readonly snapshot: RegularFileTextSnapshot | undefined,
  ) {}

  static async read(
    path: string,
    requestedPath: string,
  ): Promise<ClientConfigurationTransaction> {
    return new ClientConfigurationTransaction(
      path,
      requestedPath,
      await readSnapshot(path),
    );
  }

  get original(): string | undefined {
    return this.snapshot?.text;
  }

  async write(text: string): Promise<void> {
    await writeFileAtomic(this.path, text, {
      encoding: "utf8",
      mode: 0o600,
      // Run inside the writer's own queue, before it writes or replaces anything.
      // This is conflict detection, not an OS compare-and-swap against arbitrary writers.
      tmpfileCreated: async (temporaryPath) => {
        const identity = await lstat(temporaryPath);
        const resolved = await resolveClientConfigTransactionPath(
          this.requestedPath,
        );
        if (resolved === undefined)
          throw new ConfigurationError(
            `Client configuration path could not be safely verified: ${this.requestedPath}`,
          );
        if (resolved !== this.path)
          throw new ClientConfigurationConflict(this.path);
        const current = await readSnapshot(this.path);
        if (
          this.snapshot === undefined
            ? current !== undefined
            : current === undefined ||
              current.text !== this.snapshot.text ||
              !sameRegularFileState(this.snapshot.state, current.state)
        )
          throw new ClientConfigurationConflict(this.path);
        this.#installed = { identity, text };
      },
    });
  }

  async readInstalled(): Promise<string> {
    const current = await readSnapshot(this.path);
    const installed = this.#installed;
    if (
      installed === undefined ||
      current === undefined ||
      installed.identity.dev !== current.state.dev ||
      installed.identity.ino !== current.state.ino ||
      installed.text !== current.text
    )
      throw new ClientConfigurationConflict(this.path);
    return current.text;
  }

  async restore(): Promise<
    Result<
      void,
      | { readonly kind: "conflict" }
      | {
          readonly kind: "restore";
          readonly path: string;
          readonly detail: string;
        }
    >
  > {
    try {
      await this.readInstalled();
      if (this.original === undefined) await rm(this.path, { force: true });
      else
        await writeFile(this.path, this.original, {
          encoding: "utf8",
          mode: this.snapshot?.state.mode ?? 0o600,
        });
      return ok(undefined);
    } catch (cause: unknown) {
      if (cause instanceof RegularFileCleanupFailure) throw cause;
      if (cause instanceof ClientConfigurationConflict)
        return err({ kind: "conflict" });
      return err({
        kind: "restore",
        path: this.path,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
