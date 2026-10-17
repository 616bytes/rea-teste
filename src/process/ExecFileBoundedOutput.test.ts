import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";

import {
  collectBoundedCommandOutput,
  execFileBoundedOutput,
} from "./ExecFileBoundedOutput.js";

describe("execFileBoundedOutput", () => {
  it("lets a command finish after its output exceeds the capture limit", async () => {
    const result = await execFileBoundedOutput(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(70000)); process.stderr.write('failure detail');",
      ],
      { env: process.env, limit: 64 * 1024 },
    );
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(64 * 1024 + 50);
    expect(result.stdout).toContain("[output omitted]");
    expect(result.stderr).toBe("failure detail");
    expect(result.outputTruncated).toBe(true);
  });

  it("retains a failing command's status and stderr after verbose stdout", async () => {
    const result = await execFileBoundedOutput(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(70000)); process.stderr.write('package conflict'); process.exitCode = 1;",
      ],
      { env: process.env, limit: 64 * 1024 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("package conflict");
    expect(result.outputTruncated).toBe(true);
  });

  it("retains a final error after a long prefix in the same stream", async () => {
    const result = await execFileBoundedOutput(
      process.execPath,
      [
        "-e",
        "process.stderr.write('warning '.repeat(10000)); process.stderr.write('error: final conflict'); process.exitCode = 1;",
      ],
      { env: process.env, limit: 64 * 1024 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[output omitted]");
    expect(result.stderr).toContain("error: final conflict");
    expect(result.outputTruncated).toBe(true);
  });
});

it("streams noisy output with backpressure and waits for final writes without closing the borrowed writer", async () => {
  let bytes = 0;
  let peakQueued = 0;
  let release: (() => void) | undefined;
  let enter!: () => void;
  const flushing = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const forward = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      peakQueued = Math.max(peakQueued, this.writableLength);
      if (chunk.length === 0) {
        release = callback;
        enter();
      } else setImmediate(callback);
    },
  });
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdout.write('x'.repeat(10*1024*1024)); process.stderr.write('y'.repeat(10*1024*1024))",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let settled = false;
  const pending = collectBoundedCommandOutput(child, {
    limit: 64 * 1024,
    forward,
  }).then((result) => {
    settled = true;
    return result;
  });
  try {
    await flushing;
    expect(settled).toBe(false);
    expect(bytes).toBe(20 * 1024 * 1024);
    expect(peakQueued).toBeLessThan(1024 * 1024);
    release?.();
    release = undefined;
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(10 * 1024 * 1024);
    expect(result.stderrBytes).toBe(10 * 1024 * 1024);
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThan(
      128 * 1024 + 100,
    );
    expect(forward.writableEnded).toBe(false);
    expect(forward.destroyed).toBe(false);
    expect(forward.listenerCount("error")).toBe(0);
  } finally {
    release?.();
    await pending;
    forward.destroy();
  }
});

it.each(["body", "flush"])(
  "drains child output and reports a %s forwarding failure separately from physical exit",
  async (stage) => {
    const forward = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        callback(
          (chunk.length === 0) === (stage === "flush")
            ? new Error("observer unavailable")
            : undefined,
        );
      },
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(1024*1024)); process.stderr.write('finished')",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = await collectBoundedCommandOutput(child, {
      limit: 64 * 1024,
      forward,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(1024 * 1024);
    expect(result.stderr).toBe("finished");
    expect(result.failure).toEqual({
      kind: "collection",
      message: "observer unavailable",
    });
    expect(forward.listenerCount("error")).toBe(0);
    forward.destroy();
  },
);

it.each(["already closed", "closed during output"])(
  "drains both streams when the borrowed writer is %s without an error",
  async (stage) => {
    const forward = new Writable({
      write(_chunk, _encoding, callback) {
        if (stage === "closed during output") this.end();
        callback();
      },
    });
    if (stage === "already closed") forward.destroy();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(1024*1024)); process.stderr.write('finished')",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = await collectBoundedCommandOutput(child, {
      limit: 1024,
      forward,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(1024 * 1024);
    expect(result.stderr).toBe("finished");
    expect(result.failure).toMatchObject({
      kind: "collection",
      message: expect.stringContaining("observer closed"),
    });
    expect(forward.listenerCount("error")).toBe(0);
    expect(forward.listenerCount("close")).toBe(0);
    expect(forward.listenerCount("finish")).toBe(0);
    forward.destroy();
  },
);
