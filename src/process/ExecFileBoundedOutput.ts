import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

export interface BoundedCommandOutput {
  readonly exitCode: string | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly failure?: {
    readonly kind: "spawn" | "collection";
    readonly message: string;
  };
}

/** Drain both streams while retaining bounded head and tail evidence. */
export const execFileBoundedOutput = (
  executable: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly limit: number;
  },
): Promise<BoundedCommandOutput> =>
  collectBoundedCommandOutput(
    spawn(executable, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    options,
  );

/**
 * collect through child/pipe closure without terminating a package installation.
 * each stream retains at most limit bytes, plus the explicit omission marker.
 * an optional borrowed output receives all bytes with stream backpressure.
 */
export const collectBoundedCommandOutput = (
  child: ChildProcess,
  options: { readonly limit: number; readonly forward?: Writable },
): Promise<BoundedCommandOutput> =>
  new Promise((resolve) => {
    const headLimit = Math.ceil(options.limit / 2);
    const tailLimit = options.limit - headLimit;
    const stdout = { head: Buffer.alloc(0), tail: Buffer.alloc(0), total: 0 };
    const stderr = { head: Buffer.alloc(0), tail: Buffer.alloc(0), total: 0 };
    let outputTruncated = false;
    const capture =
      (stream: typeof stdout) =>
      (chunk: Buffer): void => {
        stream.total += chunk.length;
        const headCount = Math.min(
          chunk.length,
          Math.max(0, headLimit - stream.head.length),
        );
        if (headCount > 0)
          stream.head = Buffer.concat([
            stream.head,
            chunk.subarray(0, headCount),
          ]);
        const rest = chunk.subarray(headCount);
        if (rest.length > 0 && tailLimit > 0)
          // copy only the needed suffix: a small view must not retain a huge chunk.
          stream.tail = Buffer.from(
            Buffer.concat([stream.tail, rest.subarray(-tailLimit)]).subarray(
              -tailLimit,
            ),
          );
        if (stream.total > options.limit) outputTruncated = true;
      };
    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));
    let failure: BoundedCommandOutput["failure"];
    const collectionFailed = (cause: Error): void => {
      failure ??= { kind: "collection", message: cause.message };
    };
    child.stdout?.on("error", collectionFailed);
    child.stderr?.on("error", collectionFailed);
    if (child.stdout === null || child.stderr === null)
      collectionFailed(new Error("command output stream is unavailable"));
    const forward = options.forward;
    let forwardFailed = false;
    const forwardingFailed = (cause: Error): void => {
      forwardFailed = true;
      collectionFailed(cause);
      // a failed observer must not leave the package manager blocked on its pipes.
      child.stdout?.unpipe(forward);
      child.stderr?.unpipe(forward);
      child.stdout?.resume();
      child.stderr?.resume();
    };
    const forwardingClosed = (): void => {
      forwardingFailed(
        new Error("command output observer closed before collection completed"),
      );
    };
    if (forward !== undefined) {
      forward.on("error", forwardingFailed);
      forward.on("close", forwardingClosed);
      forward.on("finish", forwardingClosed);
      if (forward.destroyed || forward.writableEnded) forwardingClosed();
      else {
        child.stdout?.pipe(forward, { end: false });
        child.stderr?.pipe(forward, { end: false });
      }
    }
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      failure ??= { kind: "spawn", message: error.message };
    });
    child.on("close", (code, signal) => {
      const finish = (): void => {
        forward?.off("error", forwardingFailed);
        forward?.off("close", forwardingClosed);
        forward?.off("finish", forwardingClosed);
        resolve({
          exitCode: spawnError?.code ?? code ?? signal,
          stdout: retainedOutput(stdout, options.limit),
          stderr: retainedOutput(stderr, options.limit),
          stdoutBytes: stdout.total,
          stderrBytes: stderr.total,
          outputTruncated,
          ...(failure === undefined ? {} : { failure }),
        });
      };
      if (forward === undefined || forwardFailed) finish();
      else {
        // acknowledge queued writes without ending or destroying borrowed stderr.
        try {
          forward.write(Buffer.alloc(0), (cause) => {
            if (cause) {
              forwardingFailed(cause);
              // writable emits error after its callback; retain our listener for it.
              setImmediate(finish);
            } else finish();
          });
        } catch (cause: unknown) {
          collectionFailed(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
          finish();
        }
      }
    });
  });

const retainedOutput = (
  stream: {
    readonly head: Buffer;
    readonly tail: Buffer;
    readonly total: number;
  },
  limit: number,
): string =>
  stream.total > limit
    ? `${stream.head.toString("utf8")} … [output omitted] … ${stream.tail.toString("utf8")}`
    : Buffer.concat([stream.head, stream.tail]).toString("utf8");
