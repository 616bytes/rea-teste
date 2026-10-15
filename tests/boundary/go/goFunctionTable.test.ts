import { expect, it } from "vitest";
import {
  readGoBinaryImage,
  readGoBinaryContainer,
  GoBinaryResourceFailure,
} from "../../../src/go/GoBinaryImage.js";
import { goBinarySchema } from "../../../src/domain/go/goBinary.js";
import { createGoFunctionFixture } from "../../fixtures/go/functions.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import { readGoFunctionTable } from "../../../src/go/GoFunctionTable.js";

it("observes named function coordinates without requiring a symbol table or nonzero header text base", () => {
  const { bytes, table, text } = createGoFunctionFixture();
  const result = readGoBinaryImage(bytes, true);
  expect(result.build_info?.go_version).toBe("go1.26.0");
  expect(result.functions).toMatchObject({
    state: "complete",
    text_start: "0x10600",
    declared_text_start: "0x0",
    text_start_source: ".text-section",
    table: { offset: table, bytes: 512 },
    entries: [
      {
        name: "main.加法",
        entry_address: "0x10600",
        file_offset: text,
        table_row_offset: table + 256,
        function_data_offset: table + 280,
        name_location: { offset: table + 72, bytes: 11 },
      },
      { name: "main.choose", entry_address: "0x10620", file_offset: text + 32 },
    ],
  });
});

it.each([
  ["reserved header", (b: Buffer, t: number) => b.writeUInt16LE(1, t + 4)],
  ["pointer width", (b: Buffer, t: number) => b.writeUInt8(4, t + 7)],
  [
    "subtable range",
    (b: Buffer, t: number) => b.writeBigUInt64LE(513n, t + 64),
  ],
  ["subtable order", (b: Buffer, t: number) => b.writeBigUInt64LE(71n, t + 40)],
  ["function record", (b: Buffer, t: number) => b.writeUInt32LE(0, t + 260)],
  [
    "contradictory entry",
    (b: Buffer, t: number) => b.writeUInt32LE(1, t + 280),
  ],
  ["unordered entries", (b: Buffer, t: number) => b.writeUInt32LE(0, t + 264)],
  [
    "entry outside text",
    (b: Buffer, t: number) => {
      b.writeUInt32LE(128, t + 264);
      b.writeUInt32LE(128, t + 296);
      b.writeUInt32LE(160, t + 272);
    },
  ],
  ["name range", (b: Buffer, t: number) => b.writeUInt32LE(56, t + 284)],
  ["unterminated name", (b: Buffer, t: number) => b.fill(65, t + 72, t + 128)],
  ["invalid UTF8", (b: Buffer, t: number) => b.writeUInt8(255, t + 72)],
  [
    "conflicting section address",
    (b: Buffer) => b.writeBigUInt64LE(1n, 512 + 16),
  ],
  ["duplicate table", (b: Buffer) => b.copy(b, 512, 448, 512)],
])(
  "keeps build information and explicit unknown functions after %s corruption",
  (_name, change) => {
    const { bytes, table } = createGoFunctionFixture();
    change(bytes, table);
    const result = readGoBinaryImage(bytes, true);
    expect(result.build_info).not.toBeNull();
    expect(result.functions).toMatchObject({
      state: "unavailable",
      reason: "malformed",
      entries: [],
    });
  },
);

it("refuses oversized function counts before reading or allocating their entries", () => {
  const { bytes, table } = createGoFunctionFixture();
  bytes.writeBigUInt64LE(0xffffffffffffffffn, table + 8);
  expect(readGoBinaryImage(bytes).functions).toEqual({
    state: "not-requested",
    entries: [],
  });
  expect(readGoBinaryImage(bytes, false).functions).toEqual({
    state: "not-requested",
    entries: [],
  });
  expect(() => readGoBinaryImage(bytes, true)).toThrow(GoBinaryResourceFailure);
});

it("bounds cumulative name scanning even when rows reuse one long name", () => {
  const fixture = createGoFunctionFixture();
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  fixture.bytes.copy(bytes);
  const table = fixture.table;
  const functions = 600200;
  bytes.writeBigUInt64LE(BigInt(bytes.length), 160);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 168);
  bytes.writeBigUInt64LE(700000n, 448 + 32);
  for (const field of [40, 48, 56])
    bytes.writeBigUInt64LE(600100n, table + field);
  bytes.writeBigUInt64LE(BigInt(functions), table + 64);
  bytes.fill(65, table + 72, table + 600072);
  bytes[table + 600072] = 0;
  for (const [offset, value] of [
    [0, 0],
    [4, 24],
    [8, 32],
    [12, 40],
    [16, 64],
    [24, 0],
    [28, 0],
    [40, 32],
    [44, 0],
  ])
    bytes.writeUInt32LE(value!, table + functions + offset!);
  expect(() => readGoBinaryImage(bytes, true)).toThrow(/cumulative 1 MiB/);
});

it("bounds address-mapping work before visiting a large declared function table", () => {
  const fixture = createGoFunctionFixture();
  const bytes = Buffer.alloc(8192);
  fixture.bytes.copy(bytes);
  bytes.writeBigUInt64LE(8192n, 160);
  bytes.writeBigUInt64LE(8192n, 168);
  bytes.writeBigUInt64LE(4096n, 448 + 32);
  bytes.writeBigUInt64LE(256n, fixture.table + 8);
  const container = readGoBinaryContainer(bytes);
  const mapping = container.mappings[0]!;
  expect(() =>
    readGoFunctionTable(bytes, {
      ...container,
      mappings: Array.from({ length: 10000 }, () => mapping),
    }),
  ).toThrow(/mapping-comparison budget/);
});

it("rejects conflicting file and zero-fill aliases rather than picking a mapping", () => {
  const { bytes, table } = createGoFunctionFixture();
  const container = readGoBinaryContainer(bytes);
  for (const patch of [
    { zero_fills: [{ address: BigInt(0x10000 + table), size: 1n }] },
    {
      mappings: [
        ...container.mappings,
        { address: BigInt(0x10000 + table), offset: 1, size: 1 },
      ],
    },
  ])
    expect(
      readGoFunctionTable(bytes, { ...container, ...patch }),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
});

it("does not search anonymous sections or decode unsupported layouts and image types", () => {
  for (const options of [
    { format: "pe" },
    { format: "macho" },
    { bits: 32 },
    { sectionless: true },
  ] as const) {
    expect(
      readGoBinaryImage(createGoBinaryFixture(options).bytes, true).functions,
    ).toMatchObject({ state: "unavailable", entries: [] });
  }
  const { bytes, table } = createGoFunctionFixture();
  bytes.writeUInt32LE(0xfffffff0, table);
  expect(readGoBinaryImage(bytes, true).functions).toMatchObject({
    state: "unavailable",
    reason: "unsupported",
  });
  bytes.writeUInt16LE(3, 16);
  expect(readGoBinaryImage(bytes, true).functions).toMatchObject({
    state: "unavailable",
    reason: "unsupported",
  });
});

it("rejects provider reports with function coordinates outside their artifact or source table", () => {
  const { bytes } = createGoFunctionFixture();
  const image = readGoBinaryImage(bytes, true);
  const report = {
    ...image,
    build_info: null,
    artifact: {
      path: "/artifacts/app",
      bytes: bytes.length,
      sha256: "a".repeat(64),
    },
    limitations: [],
  };
  expect(goBinarySchema.safeParse(report).success).toBe(true);
  if (image.functions.state !== "complete")
    throw new Error("Expected complete fixture");
  const first = image.functions.entries[0]!;
  for (const patch of [
    { file_offset: bytes.length },
    { name_location: { offset: bytes.length, bytes: 1 } },
    { function_data_offset: 0 },
    { table_row_offset: 0 },
  ])
    expect(
      goBinarySchema.safeParse({
        ...report,
        functions: { ...image.functions, entries: [{ ...first, ...patch }] },
      }).success,
    ).toBe(false);
});
