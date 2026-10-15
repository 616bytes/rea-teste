import { expect, it } from "vitest";
import {
  closeVerifierResources,
  retryTransientCleanup,
} from "../../../scripts/lib/verifier-cleanup.mjs";

const transientSharingViolation = (): Error =>
  Object.assign(
    new Error(
      "Open private object relative to its directory handle failed (Win32 32)",
    ),
    { code: "ERR_REA_WINDOWS_NATIVE", win32Code: 32 },
  );

it("attempts every cleanup and reports failures when there is no primary error", async () => {
  const attempted: string[] = [];
  const tasks = [
    async () => {
      attempted.push("provider");
      throw new Error("provider close failed");
    },
    async () => {
      attempted.push("fixture");
    },
  ];

  let failure: unknown;
  try {
    await closeVerifierResources(tasks);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(
    (failure as AggregateError).errors.map((error) => error.message),
  ).toEqual(["provider close failed"]);
  expect(attempted).toEqual(["provider", "fixture"]);
});

it("retains primary verification and independent cleanup failures", async () => {
  const primary = new Error("analysis assertion failed");
  const attempted: string[] = [];
  const tasks = [
    async () => {
      attempted.push("provider");
      throw new Error("provider close failed");
    },
    async () => {
      attempted.push("fixture");
      throw new Error("fixture removal failed");
    },
  ];

  let failure: unknown;
  try {
    await closeVerifierResources(tasks, primary);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    primary,
    expect.objectContaining({ message: "provider close failed" }),
    expect.objectContaining({ message: "fixture removal failed" }),
  ]);
  expect(attempted).toEqual(["provider", "fixture"]);
});

it("retries a proven transient Windows sharing violation until cleanup succeeds", async () => {
  const attempts: number[] = [];
  let remaining = 2;
  await retryTransientCleanup(
    async () => {
      attempts.push(remaining);
      if (remaining-- > 0) throw transientSharingViolation();
    },
    { attempts: 5, delayMs: 0 },
  );
  expect(attempts).toEqual([2, 1, 0]);
});

it.each([
  {
    label: "a non-native failure",
    failure: Object.assign(new Error("access denied"), { code: "EACCES" }),
  },
  {
    label: "a native failure with an unlisted Win32 code",
    failure: Object.assign(new Error("access denied (Win32 5)"), {
      code: "ERR_REA_WINDOWS_NATIVE",
      win32Code: 5,
    }),
  },
  {
    label: "a native failure with a string Win32 code",
    failure: Object.assign(new Error("sharing conflict (Win32 32)"), {
      code: "ERR_REA_WINDOWS_NATIVE",
      win32Code: "32",
    }),
  },
  {
    label: "a native failure with no Win32 code",
    failure: Object.assign(new Error("native failure"), {
      code: "ERR_REA_WINDOWS_NATIVE",
    }),
  },
])("does not retry $label and surfaces it immediately", async ({ failure }) => {
  let calls = 0;
  await expect(
    retryTransientCleanup(
      async () => {
        calls++;
        throw failure;
      },
      { attempts: 5, delayMs: 0 },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});

it("surfaces the last cause once the bounded retry budget is exhausted", async () => {
  let calls = 0;
  const failure = transientSharingViolation();
  await expect(
    retryTransientCleanup(
      async () => {
        calls++;
        throw failure;
      },
      { attempts: 3, delayMs: 0 },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(3);
});

it("retains the primary result when a retried cleanup still fails", async () => {
  const primary = new Error("verification assertion failed");
  let calls = 0;
  let failure: unknown;
  try {
    await closeVerifierResources(
      [
        () =>
          retryTransientCleanup(
            async () => {
              calls++;
              throw transientSharingViolation();
            },
            { attempts: 2, delayMs: 0 },
          ),
      ],
      primary,
    );
  } catch (cause) {
    failure = cause;
  }
  expect(calls).toBe(2);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(primary);
  expect((failure as AggregateError).errors[1]).toMatchObject({
    win32Code: 32,
  });
});
