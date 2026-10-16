import { afterEach, expect, it, vi } from "vitest";

import { GhidraStartupProgressObserver } from "./GhidraAnalysisProgress.js";

afterEach(() => {
  vi.useRealTimers();
});

it("streams each discovered procedure once across bounded progress messages", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const procedures = Array.from({ length: 400 }, (_, index) => ({
    address: `0x${(0x1000 + index * 16).toString(16)}`,
    value: `function_${String(index)}_${"x".repeat(180)}`,
    procedure: {
      external: false,
      thunk: false,
      thunk_target: null,
    },
  }));
  const messages: string[] = [];
  const observer = new GhidraStartupProgressObserver({
    connected: () => true,
    requestSnapshot: async () => ({
      status: "analyzing",
      observed: procedures.length,
      procedures,
    }),
    progress: {
      report: async (update) => {
        messages.push(update.message);
      },
    },
  });

  observer.start();
  for (let poll = 0; poll < 20; poll += 1) {
    await vi.advanceTimersByTimeAsync(poll === 0 ? 0 : 750);
    const emitted = messages.flatMap((message) =>
      JSON.parse(message).procedures.map(
        (procedure: { readonly address: string }) => procedure.address,
      ),
    );
    if (emitted.length === procedures.length) break;
  }

  const messageCount = messages.length;
  await vi.advanceTimersByTimeAsync(1_500);
  observer.stop();

  const emitted = messages.flatMap((message) =>
    JSON.parse(message).procedures.map(
      (procedure: { readonly address: string }) => procedure.address,
    ),
  );
  expect(messages.length).toBe(messageCount);
  expect(messages.length).toBeGreaterThan(1);
  expect(
    messages.every(
      (message) => Buffer.byteLength(message, "utf8") <= 24 * 1024,
    ),
  ).toBe(true);
  expect(emitted).toHaveLength(procedures.length);
  expect(new Set(emitted).size).toBe(procedures.length);
});

it("reports a changed procedure again with its latest classification", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const snapshots = [
    {
      status: "analyzing",
      observed: 1,
      procedures: [
        {
          address: "0x1000",
          value: "FUN_1000",
          procedure: {
            external: false,
            thunk: false,
            thunk_target: null,
          },
        },
      ],
    },
    {
      status: "analyzing",
      observed: 1,
      procedures: [
        {
          address: "0x1000",
          value: "main",
          procedure: {
            external: false,
            thunk: true,
            thunk_target: "0x2000",
          },
        },
      ],
    },
  ];
  const messages: string[] = [];
  const observer = new GhidraStartupProgressObserver({
    connected: () => true,
    requestSnapshot: async () => snapshots.shift(),
    progress: {
      report: async (update) => {
        messages.push(update.message);
      },
    },
  });

  observer.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(750);
  observer.stop();

  expect(messages.flatMap((message) => JSON.parse(message).procedures)).toEqual(
    [
      { address: "0x1000", name: "FUN_1000", kind: "Function" },
      { address: "0x1000", name: "main", kind: "Thunk" },
    ],
  );
});
