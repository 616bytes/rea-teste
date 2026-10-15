import type {
  GoFunctionEntry,
  GoFunctionTable,
} from "../domain/go/goFunctionTable.js";
import {
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
  GoBinaryReader,
  goUtf8,
  mappedFileOffset,
  type GoBinaryContainer,
  type GoImageSection,
} from "./GoBinaryContainer.js";

const FUNCTION_BYTES = 8 * 1024 * 1024;
const NAME_BYTES = 1024 * 1024;
const MAPPING_COMPARISONS = 4 * 1024 * 1024;

/** Computational work admission is counted separately from byte budgets. */
export class GoFunctionMappingLimit extends Error {
  readonly maximum_comparisons = MAPPING_COMPARISONS;
  constructor() {
    super(
      "Go function address checks exceed the cumulative mapping-comparison budget",
    );
    this.name = "GoFunctionMappingLimit";
  }
}

const unavailable = (
  reason: "not-found" | "unsupported" | "malformed",
  limitation: string,
  section?: GoImageSection,
): GoFunctionTable => ({
  state: "unavailable",
  table:
    section === undefined
      ? null
      : { offset: section.offset, bytes: section.size },
  reason,
  limitation,
  entries: [],
});

function malformed(detail: string): never {
  throw new GoBinaryFormatFailure("malformed", `Go pclntab: ${detail}`);
}

/** Prove the whole declared section has one file-backed virtual identity. */
const verifySection = (
  container: GoBinaryContainer,
  section: GoImageSection,
): void => {
  let address: bigint | undefined;
  for (const mapping of container.mappings) {
    const delta = section.offset - mapping.offset;
    if (delta < 0 || section.size > mapping.size - delta) continue;
    const candidate = mapping.address + BigInt(delta);
    if (address !== undefined && address !== candidate)
      malformed("section has ambiguous virtual identities");
    address = candidate;
  }
  if (
    address === undefined ||
    address !== section.address ||
    mappedFileOffset(
      container.mappings,
      address,
      section.size,
      container.zero_fills,
    ) !== section.offset
  )
    malformed("section is not covered by a unique file-backed load mapping");
};

/** Read only a proven ELF64/amd64 Go 1.20-layout table; never search arbitrary bytes for a magic. */
export const readGoFunctionTable = (
  bytes: Buffer,
  container: GoBinaryContainer,
): GoFunctionTable => {
  if (
    container.format !== "elf" ||
    container.bits !== 64 ||
    container.byte_order !== "little" ||
    container.architecture !== "amd64"
  )
    return unavailable(
      "unsupported",
      "Function-table inspection currently covers ELF64 little-endian amd64 images only.",
    );
  if (container.elf_type !== 2)
    return unavailable(
      "unsupported",
      "Relocatable, PIE and shared images require additional text-base/relocation facts.",
    );
  const tables = container.sections.filter(
    (section) => section.name === ".gopclntab",
  );
  const section = tables[0];
  if (section === undefined)
    return unavailable(
      "not-found",
      "No named .gopclntab section was observed; absent metadata does not establish absence of Go functions.",
    );
  if (
    tables.length !== 1 ||
    !section.file_backed ||
    !section.read_only ||
    section.compressed ||
    section.size < 72
  )
    return unavailable(
      "malformed",
      "The .gopclntab section is ambiguous, unbacked, compressed, writable or shorter than its header.",
    );
  try {
    const reader = new GoBinaryReader(bytes, true);
    reader.table(BigInt(section.offset), 1, section.size, "Go pclntab section");
    verifySection(container, section);
    if (reader.u32(section.offset) !== 0xffff_fff1)
      return unavailable(
        "unsupported",
        "Only the Go 1.20 pclntab magic/layout is decoded; other layouts remain unknown.",
        section,
      );
    return decodeTable(bytes, reader, container, section);
  } catch (cause: unknown) {
    if (!(cause instanceof GoBinaryFormatFailure)) throw cause;
    return unavailable(cause.kind, cause.message, section);
  }
};

interface TableFacts {
  readonly count: number;
  readonly textStart: bigint;
  readonly names: number;
  readonly namesEnd: number;
  readonly functions: number;
  readonly tableEnd: number;
}

const tableFacts = (
  reader: GoBinaryReader,
  section: GoImageSection,
): TableFacts => {
  const start = section.offset;
  const end = start + section.size;
  if (
    reader.u16(start + 4) !== 0 ||
    reader.bytes[start + 6] !== 1 ||
    reader.bytes[start + 7] !== 8
  )
    malformed(
      "header padding, instruction quantum or pointer width is invalid",
    );
  const count = reader.word(start + 8, 64);
  if (count * 256n > BigInt(FUNCTION_BYTES))
    throw new GoBinaryResourceFailure(
      "structure",
      FUNCTION_BYTES,
      "Go function records exceed the 8 MiB representation admission budget",
    );
  const offsets = [3, 4, 5, 6, 7].map((word) =>
    reader.word(start + 8 + word * 8, 64),
  );
  let previous = 72n;
  for (const offset of offsets) {
    if (offset < previous || offset > BigInt(section.size))
      malformed("subtable offsets are unordered or leave the section");
    previous = offset;
  }
  const names = start + Number(offsets[0]);
  const namesEnd = start + Number(offsets[1]);
  const functions = start + Number(offsets[4]);
  const tableEnd = functions + (Number(count) * 2 + 1) * 4;
  if (tableEnd > end) malformed("declared function table leaves the section");
  return {
    count: Number(count),
    textStart: reader.word(start + 24, 64),
    names,
    namesEnd,
    functions,
    tableEnd,
  };
};

const decodeTable = (
  bytes: Buffer,
  reader: GoBinaryReader,
  container: GoBinaryContainer,
  section: GoImageSection,
): GoFunctionTable => {
  const facts = tableFacts(reader, section);
  if (
    facts.count *
      (container.mappings.length * 2 + container.zero_fills.length) >
    MAPPING_COMPARISONS
  )
    throw new GoFunctionMappingLimit();
  const texts = container.sections.filter((item) => item.name === ".text");
  const text = texts[0];
  if (
    texts.length !== 1 ||
    text === undefined ||
    !text.file_backed ||
    text.compressed
  )
    malformed("a unique file-backed .text section is required");
  verifySection(container, text);
  if (
    mappedFileOffset(
      container.mappings,
      text.address,
      1,
      container.zero_fills,
    ) !== text.offset
  )
    malformed("declared .text address disagrees with its file mapping");
  let remainingNames = NAME_BYTES;
  let remainingOutput = FUNCTION_BYTES - facts.count * 256;
  const entries: GoFunctionEntry[] = [];
  for (let index = 0; index < facts.count; index++) {
    const row = facts.functions + index * 8;
    const entry = reader.u32(row);
    if (entry >= reader.u32(row + 8))
      malformed("function entry offsets are not strictly increasing");
    const data = facts.functions + reader.u32(row + 4);
    if (
      data < facts.tableEnd ||
      data > section.offset + section.size - 8 ||
      reader.u32(data) !== entry
    )
      malformed(
        "function record is outside its data span or contradicts its table entry",
      );
    const name = facts.names + reader.u32(data + 4);
    if (name >= facts.namesEnd)
      malformed("function name offset leaves the name table");
    const limit = Math.min(facts.namesEnd, name + remainingNames + 1);
    const length = bytes.subarray(name, limit).indexOf(0);
    if (length < 0) {
      if (limit < facts.namesEnd)
        throw new GoBinaryResourceFailure(
          "structure",
          NAME_BYTES,
          "Go function names exceed the cumulative 1 MiB search budget",
        );
      malformed("function name is unterminated");
    }
    if (length === 0) malformed("function name is empty");
    remainingNames -= length + 1;
    remainingOutput -= length * 6;
    if (remainingNames < 0)
      throw new GoBinaryResourceFailure(
        "structure",
        NAME_BYTES,
        "Go function names exceed the cumulative 1 MiB search budget",
      );
    if (remainingOutput < 0)
      throw new GoBinaryResourceFailure(
        "structure",
        FUNCTION_BYTES,
        "Go function names exceed representation admission capacity",
      );
    const address = text.address + BigInt(entry);
    if (address > 0xffff_ffff_ffff_ffffn)
      malformed("function address overflows 64 bits");
    const fileOffset = mappedFileOffset(
      container.mappings,
      address,
      1,
      container.zero_fills,
    );
    if (fileOffset < text.offset || fileOffset >= text.offset + text.size)
      malformed("function entry is outside the mapped .text section");
    entries.push({
      name: goUtf8(bytes.subarray(name, name + length), "Go function name"),
      entry_address: `0x${address.toString(16)}`,
      file_offset: fileOffset,
      table_row_offset: row,
      function_data_offset: data,
      name_location: { offset: name, bytes: length },
    });
  }
  return {
    state: "complete",
    layout: "go1.20-pclntab",
    table: { offset: section.offset, bytes: section.size },
    text_start: `0x${text.address.toString(16)}`,
    declared_text_start: `0x${facts.textStart.toString(16)}`,
    text_start_source: ".text-section",
    entries,
  };
};
