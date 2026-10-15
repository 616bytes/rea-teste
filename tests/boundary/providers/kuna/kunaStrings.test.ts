import { expect, it as test, vi } from "vitest";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";

import { fakeKunaCalls, setFakeKunaBehavior } from "./fakeKuna.js";
import { run, session, unprovenCleanupLauncher } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");
const scans = async (kuna: string) =>
  (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "strings");

it("shares a typed string scan across concurrent searches and exact address reads without analysis", async () => {
  const { open, kuna } = await session("rea-kuna-strings-", {
    stringDelayMs: 50,
  });
  const client = open();
  try {
    const [literal, regex] = await Promise.all([
      run(client, "search_strings", { pattern: "FIXTURE" }),
      run(client, "search_strings", { pattern: "^δ", mode: "regex" }),
    ]);
    expect(literal.result).toEqual([
      {
        address: "0x3000",
        value: "REA fixture prompt",
        string: {
          encoding: "ascii",
          encoding_status: "observed",
          termination: "present_or_not_required",
          byte_length: 19,
        },
      },
    ]);
    expect(regex.result).toEqual([
      {
        address: "0x3020",
        value: "Δelta",
        string: {
          encoding: "utf8",
          encoding_status: "observed",
          termination: "missing",
          byte_length: 6,
        },
      },
    ]);
    expect(literal.rawResult).toMatchObject({
      strings: {
        kind: "kuna-string-inventory",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        inventory_count: 2,
        selected_count: 1,
        scanned: "sections",
        xrefs: false,
      },
    });
    expect(literal.limitations).toContainEqual(
      expect.stringContaining("not proof of absence"),
    );
    const exact = await run(client, "list_strings", { address: "0X00003020" });
    expect(exact.result).toEqual(regex.result);
    expect(
      (await run(client, "list_strings", { address: "0x9999" })).result,
    ).toEqual([]);
    expect(
      (
        await run(client, "search_strings", {
          pattern: "fixture",
          case_sensitive: true,
        })
      ).result,
    ).toEqual(literal.result);
    expect(
      (
        await run(client, "search_strings", {
          pattern: "FIXTURE",
          case_sensitive: true,
        })
      ).result,
    ).toEqual([]);
    expect(await scans(kuna)).toHaveLength(1);
    const commands = (await fakeKunaCalls(kuna)).map(({ argv }) => argv[0]);
    expect(commands.filter((command) => command !== "--version")).toEqual([
      "strings",
    ]);
    expect(
      await client.execute("list_strings", { address: "invalid" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(
      await client.execute("search_strings", { pattern: "[", mode: "regex" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect((await run(client, "list_strings")).result).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it.each(["not-json", "miscounted"] as const)(
  "does not publish or cache a %s inventory",
  async (strings) => {
    const { open, kuna } = await session("rea-kuna-strings-invalid-", {
      strings,
    });
    const client = open();
    try {
      expect(
        await client.execute("search_strings", { pattern: "fixture" }),
      ).toMatchObject({ ok: false, error: { _tag: "ProviderAdapterError" } });
      await setFakeKunaBehavior(kuna, {});
      expect((await run(client, "list_strings")).result).toHaveLength(2);
      expect(await scans(kuna)).toHaveLength(2);
    } finally {
      expect(await client.close()).toEqual({ ok: true, value: null });
    }
  },
);

it("cancels one waiter without stopping the shared scan, and rebuilds in a fresh session", async () => {
  const { open, kuna } = await session("rea-kuna-strings-waiters-", {
    stringDelayMs: 200,
  });
  const first = open();
  try {
    const abort = new AbortController();
    const cancelled = first.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    const survivor = first.execute("search_strings", { pattern: "fixture" });
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await survivor).toMatchObject({ ok: true });
    expect(await scans(kuna)).toHaveLength(1);
  } finally {
    expect(await first.close()).toEqual({ ok: true, value: null });
  }
  const fresh = open();
  try {
    await run(fresh, "list_strings");
    expect(await scans(kuna)).toHaveLength(2);
  } finally {
    expect(await fresh.close()).toEqual({ ok: true, value: null });
  }
});

it("drains a cancelled last scan before retrying and refuses oversized output", async () => {
  const { open, kuna } = await session("rea-kuna-strings-retry-", {
    strings: "hang",
  });
  const client = open();
  try {
    const abort = new AbortController();
    const pending = client.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await setFakeKunaBehavior(kuna, { stringPadding: 16 * 1024 * 1024 });
    expect(await client.execute("list_strings", {})).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError" },
    });
    await setFakeKunaBehavior(kuna, {});
    expect((await run(client, "list_strings")).result).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("retains metadata admission until a string process stop is proven", async () => {
  const cleanup = unprovenCleanupLauncher("strings");
  const { open, kuna } = await session(
    "rea-kuna-strings-owner-",
    { strings: "hang" },
    {},
    cleanup.launcher,
    1,
  );
  const client = open();
  const abort = new AbortController();
  try {
    const pending = client.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.any(ProviderCleanupError),
    });
    const queuedAbort = new AbortController();
    const queued = client.execute(
      "procedure_callees",
      { procedure: "main" },
      { signal: queuedAbort.signal },
    );
    queuedAbort.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(
      (await fakeKunaCalls(kuna)).some(
        ({ argv }) => argv[0] === "decompile-graph",
      ),
    ).toBe(false);
    expect(await client.close()).toMatchObject({
      ok: false,
      error: expect.any(ProviderCleanupError),
    });
  } finally {
    cleanup.release();
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});
