import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectElfNotesInputSchema } from "../../domain/native/elfNotes.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  elfNote,
  elfNoteFixture,
  gnuAbiTagNote,
  gnuBuildIdNote,
} from "./ElfNotes.fixture.js";
import { parseElfNotes } from "./ElfNoteParser.js";

const defaults = inspectElfNotesInputSchema.parse({
  path: "/artifacts/app",
});

const parse = (bytes: Buffer) =>
  parseElfNotes(
    bytes,
    {
      path: defaults.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    defaults,
  );

it("reads GNU build-id and ABI-tag notes from ELF32 and ELF64", () => {
  for (const bits of [32, 64] as const) {
    const bytes = elfNoteFixture({ bits, ownership: "program" });
    const report = parse(bytes);
    expect(report.format).toBe(bits === 64 ? "elf64" : "elf32");
    expect(report.byte_order).toBe("little");
    expect(report.tables).toHaveLength(1);
    expect(report.tables[0]?.kind).toBe("program");
    const buildId = report.entries.find(
      (entry) => entry.type_name === "gnu_build_id",
    );
    const abi = report.entries.find(
      (entry) => entry.type_name === "gnu_abi_tag",
    );
    expect(buildId?.gnu?.build_id_hex).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(abi?.gnu?.abi_tag).toMatchObject({
      os: 0,
      os_name: "linux",
      major: 3,
      minor: 2,
      subminor: 0,
    });
  }
});

it("reads the same notes from an SHT_NOTE section including its name", () => {
  const report = parse(elfNoteFixture({ ownership: "section" }));
  expect(report.tables).toEqual([
    expect.objectContaining({
      kind: "section",
      name: ".note.gnu.build-id",
    }),
  ]);
  expect(
    report.entries.some((entry) => entry.type_name === "gnu_build_id"),
  ).toBe(true);
});

it("reports independent PT_NOTE and SHT_NOTE declarations of the same bytes", () => {
  const report = parse(elfNoteFixture({ ownership: "both" }));
  expect(report.tables.map((table) => table.kind).sort()).toEqual([
    "program",
    "section",
  ]);
  expect(
    report.entries.filter((entry) => entry.type_name === "gnu_build_id"),
  ).toHaveLength(2);
});

it("reports missing note tables without claiming notes never existed", () => {
  const report = parse(elfNoteFixture({ ownership: "none" }));
  expect(report.tables).toEqual([]);
  expect(report.entries).toEqual([]);
  expect(report.limitations[0]).toMatch(/No PT_NOTE/u);
});

it("fails a truncated note payload without partial success", () => {
  const notes = gnuBuildIdNote();
  notes.writeUInt32LE(64, 0);
  const bytes = elfNoteFixture({ ownership: "program", notes });
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("keeps non-GNU owners as unknown types with descriptor hashes", () => {
  const payload = Buffer.from("hello");
  const notes = elfNote("CORE", 1, payload);
  const report = parse(elfNoteFixture({ ownership: "program", notes }));
  expect(report.entries[0]).toMatchObject({
    owner: "CORE",
    type_name: "unknown",
    gnu: null,
  });
  expect(report.entries[0]?.descriptor.sha256).toBe(
    createHash("sha256").update(payload).digest("hex"),
  );
});

it("reads a big-endian ELF32 GNU build-id", () => {
  const notes = gnuBuildIdNote(undefined, false);
  const report = parse(
    elfNoteFixture({
      bits: 32,
      little: false,
      machine: 20,
      ownership: "program",
      notes,
    }),
  );
  expect(report.byte_order).toBe("big");
  expect(report.machine).toBe(20);
  expect(report.entries[0]?.gnu?.build_id_hex).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
});

it("fails when the entry budget is exhausted", () => {
  const notes = Buffer.concat([
    gnuBuildIdNote(),
    gnuAbiTagNote(),
    elfNote("GNU", 4, Buffer.from("gold")),
  ]);
  const bytes = elfNoteFixture({ ownership: "program", notes });
  expect(() =>
    parseElfNotes(
      bytes,
      {
        path: defaults.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      inspectElfNotesInputSchema.parse({ path: defaults.path, max_entries: 1 }),
    ),
  ).toThrow(ArtifactReaderFailure);
});
