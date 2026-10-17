import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../../../src/domain/providerAdapterError.js";
import { err } from "../../../../src/domain/result.js";
import { KunaQueryWork } from "../../../../src/kuna/KunaQueryWork.js";
import { KUNA_PROVIDER_ID } from "../../../../src/kuna/KunaRelease.js";
import { KunaRunSlots } from "../../../../src/kuna/KunaRunSlots.js";
import { KunaTargetCommands } from "../../../../src/kuna/KunaTargetCommands.js";

it("does not materialize values for a cancelled queued regex query", async () => {
  const lifetime = new AbortController();
  // This test exercises worker admission only; no native command reads this target.
  const commands = new KunaTargetCommands(
    {
      path: "/unused/program",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    },
    { signal: lifetime.signal },
  );
  const work = new KunaQueryWork(commands, {
    signal: lifetime.signal,
    own: (promise) => promise,
    runSlots: new KunaRunSlots(1),
  });
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const slow = work.match({
    operation: "search_strings",
    pattern: "^(a+)+$",
    caseSensitive: true,
    values: () => {
      admitted();
      return [`${"a".repeat(40)}!`];
    },
  });
  try {
    await ready;
    const cancelled = new AbortController();
    let materialized = false;
    const queued = work.match({
      operation: "search_procedures",
      pattern: "value",
      caseSensitive: true,
      signal: cancelled.signal,
      values: () => {
        materialized = true;
        return ["value"];
      },
    });
    cancelled.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(materialized).toBe(false);
    lifetime.abort();
    expect(await slow).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  } finally {
    lifetime.abort();
    await slow;
    expect(await commands.close()).toEqual({ ok: true, value: null });
  }
});

it("preserves exact caller cancellation reason for departing peer and final waiter", async () => {
  const lifetime = new AbortController();
  const commands = new KunaTargetCommands(
    {
      path: "/unused/program",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    },
    { signal: lifetime.signal },
  );
  const work = new KunaQueryWork(commands, {
    signal: lifetime.signal,
    own: (promise) => promise,
    runSlots: new KunaRunSlots(1),
  });

  let recordedProducerSignal!: AbortSignal;
  const pending = work.start<string>(
    (producerSignal) => {
      recordedProducerSignal = producerSignal;
      return new Promise((resolve) => {
        producerSignal.addEventListener(
          "abort",
          () => {
            resolve(
              err(
                new AnalysisCancelledError("kuna:strings", {
                  cause: producerSignal.reason,
                }),
              ),
            );
          },
          { once: true },
        );
      });
    },
    () => {},
  );

  const caller1 = new AbortController();
  const caller2 = new AbortController();

  const wait1 = work.wait(pending, caller1.signal, "list_strings");
  const wait2 = work.wait(pending, caller2.signal, "list_strings");

  const reason1 = { custom: "first caller left" };
  caller1.abort(reason1);

  const result1 = await wait1;
  expect(result1.ok).toBe(false);
  if (!result1.ok) {
    expect(result1.error._tag).toBe("AnalysisCancelledError");
    expect(result1.error.cause).toBe(reason1);
  }

  expect(recordedProducerSignal.aborted).toBe(false);

  const reason2 = "second caller stopped";
  caller2.abort(reason2);

  const result2 = await wait2;
  expect(result2.ok).toBe(false);
  if (!result2.ok) {
    expect(result2.error._tag).toBe("AnalysisCancelledError");
    expect(result2.error.cause).toBe(reason2);
  }

  expect(recordedProducerSignal.aborted).toBe(true);
  expect(recordedProducerSignal.reason).toBe(reason2);

  lifetime.abort();
  expect(await commands.close()).toEqual({ ok: true, value: null });
});

it.each([
  undefined,
  null,
  "caller stopped",
  { requested: "stop" },
  new Error("explicit failure"),
])("preserves caller reason %j across query wait", async (reason) => {
  const lifetime = new AbortController();
  const commands = new KunaTargetCommands(
    {
      path: "/unused/program",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    },
    { signal: lifetime.signal },
  );
  const work = new KunaQueryWork(commands, {
    signal: lifetime.signal,
    own: (promise) => promise,
    runSlots: new KunaRunSlots(1),
  });

  const pending = work.start<string>(
    (producerSignal) =>
      new Promise((resolve) => {
        producerSignal.addEventListener(
          "abort",
          () => {
            resolve(
              err(
                new AnalysisCancelledError("kuna:strings", {
                  cause: producerSignal.reason,
                }),
              ),
            );
          },
          { once: true },
        );
      }),
    () => {},
  );

  const caller = new AbortController();
  const wait = work.wait(pending, caller.signal, "list_strings");
  caller.abort(reason);

  const result = await wait;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(caller.signal.reason);
  }

  lifetime.abort();
  expect(await commands.close()).toEqual({ ok: true, value: null });
});

it("preserves producer physical failure over cancellation when last waiter departs", async () => {
  const lifetime = new AbortController();
  const commands = new KunaTargetCommands(
    {
      path: "/unused/program",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    },
    { signal: lifetime.signal },
  );
  const work = new KunaQueryWork(commands, {
    signal: lifetime.signal,
    own: (promise) => promise,
    runSlots: new KunaRunSlots(1),
  });

  const physicalError = new ProviderAdapterError(
    KUNA_PROVIDER_ID,
    "kuna:strings",
    { userMessage: "process crashed" },
  );
  const pending = work.start<string>(
    (producerSignal) =>
      new Promise((resolve) => {
        producerSignal.addEventListener(
          "abort",
          () => {
            resolve(err(physicalError));
          },
          { once: true },
        );
      }),
    () => {},
  );

  const caller = new AbortController();
  const wait = work.wait(pending, caller.signal, "list_strings");
  caller.abort("stop");

  const result = await wait;
  expect(result).toEqual(err(physicalError));

  lifetime.abort();
  expect(await commands.close()).toEqual({ ok: true, value: null });
});
