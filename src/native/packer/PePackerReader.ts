import type {
  PackerIndicators,
  PackerRegion,
} from "../../domain/native/packerIndicators.js";
import { formatFailure, hexAddress, shannonEntropy } from "./packerFacts.js";
import { clampRange, decodeName, type ImageFacts } from "./imageFacts.js";

const SCN_EXECUTE = 0x20000000;
const SCN_CODE = 0x20;
const SCN_READ = 0x40000000;
const SCN_WRITE = 0x80000000;
const MAX_IMPORT_LIBRARIES = 4096;
const MAX_IMPORT_FUNCTIONS = 65536;
const MAX_IMPORT_NAME = 512;

// Functions a decompression stub needs to map and link the restored program.
const LOADER_STYLE = new Set([
  "LoadLibraryA",
  "LoadLibraryW",
  "LoadLibraryExA",
  "LoadLibraryExW",
  "GetProcAddress",
  "GetModuleHandleA",
  "GetModuleHandleW",
  "VirtualAlloc",
  "VirtualAllocEx",
  "VirtualProtect",
  "VirtualProtectEx",
  "VirtualFree",
  "LdrLoadDll",
  "LdrGetProcedureAddress",
]);

interface Section {
  readonly rva: number;
  readonly virtualSize: number;
  readonly offset: number;
  readonly size: number;
}

const need = (bytes: Buffer, offset: number, length: number): void => {
  if (offset < 0 || length < 0 || offset > bytes.length - length)
    formatFailure(
      `PE range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

class ImportFailure extends Error {}

const rvaToOffset = (sections: readonly Section[], rva: number): number => {
  for (const section of sections) {
    const extent = Math.max(section.virtualSize, section.size);
    if (rva >= section.rva && rva < section.rva + extent) {
      const delta = rva - section.rva;
      if (delta >= section.size)
        throw new ImportFailure(
          `RVA 0x${rva.toString(16)} is not backed by file bytes.`,
        );
      return section.offset + delta;
    }
  }
  throw new ImportFailure(
    `RVA 0x${rva.toString(16)} is outside every section.`,
  );
};

const cString = (bytes: Buffer, offset: number): string => {
  if (offset >= bytes.length)
    throw new ImportFailure("Import name leaves the artifact.");
  const end = bytes.indexOf(0, offset);
  if (end === -1 || end - offset > MAX_IMPORT_NAME)
    throw new ImportFailure("Import name is unterminated or too long.");
  return bytes.toString("latin1", offset, end);
};

/** Decode the import directory; any inconsistency is reported, not repaired. */
const readImports = (
  bytes: Buffer,
  sections: readonly Section[],
  rva: number,
  plus: boolean,
): PackerIndicators["imports"] => {
  if (rva === 0) return { status: "absent" };
  try {
    const libraries: string[] = [];
    const nonLoaderPerLibrary: number[] = [];
    const loaderFound = new Set<string>();
    let functionCount = 0;
    let ordinalCount = 0;
    let at = rvaToOffset(sections, rva);
    for (;;) {
      if (at + 20 > bytes.length)
        throw new ImportFailure("Import descriptor leaves the artifact.");
      const lookup = bytes.readUInt32LE(at);
      const nameRva = bytes.readUInt32LE(at + 12);
      const thunk = bytes.readUInt32LE(at + 16);
      if (lookup === 0 && nameRva === 0 && thunk === 0) break;
      if (libraries.length >= MAX_IMPORT_LIBRARIES)
        throw new ImportFailure("Import library budget exhausted.");
      libraries.push(cString(bytes, rvaToOffset(sections, nameRva)));
      let nonLoader = 0;
      const width = plus ? 8 : 4;
      let entry = rvaToOffset(sections, lookup === 0 ? thunk : lookup);
      for (;;) {
        if (entry + width > bytes.length)
          throw new ImportFailure("Import thunk leaves the artifact.");
        const value = plus
          ? bytes.readBigUInt64LE(entry)
          : BigInt(bytes.readUInt32LE(entry));
        if (value === 0n) break;
        if (++functionCount > MAX_IMPORT_FUNCTIONS)
          throw new ImportFailure("Import function budget exhausted.");
        const ordinal = plus
          ? value >> 63n === 1n
          : (value & 0x80000000n) !== 0n;
        if (ordinal) {
          ordinalCount++;
          nonLoader++;
        } else {
          const name = cString(
            bytes,
            rvaToOffset(sections, Number(value & 0x7fffffffn)) + 2,
          );
          if (LOADER_STYLE.has(name)) loaderFound.add(name);
          else nonLoader++;
        }
        entry += width;
      }
      nonLoaderPerLibrary.push(nonLoader);
      at += 20;
    }
    const loader = [...loaderFound].sort();
    return {
      status: "parsed",
      libraries,
      function_count: functionCount,
      ordinal_count: ordinalCount,
      loader_style_functions: loader,
      only_loader_style:
        functionCount > 0 &&
        loader.some((name) => name.startsWith("LoadLibrary")) &&
        loaderFound.has("GetProcAddress") &&
        nonLoaderPerLibrary.every((count) => count <= 1),
    };
  } catch (cause) {
    if (cause instanceof ImportFailure)
      return { status: "unreadable", reason: cause.message };
    throw cause;
  }
};

/** Tolerant PE header reader: packed layouts are reported, not rejected. */
export const readPePackerFacts = (bytes: Buffer): ImageFacts => {
  need(bytes, 0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) formatFailure("Expected an MZ image.");
  const pe = bytes.readUInt32LE(60);
  need(bytes, pe, 24);
  if (bytes.readUInt32LE(pe) !== 0x4550)
    formatFailure("Expected a PE signature.");
  const machine = bytes.readUInt16LE(pe + 4);
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  need(bytes, optional, optionalSize);
  if (optionalSize < 2) formatFailure("Truncated PE optional header.");
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b)
    formatFailure("Unsupported PE optional header magic.");
  const plus = magic === 0x20b;
  const directoriesAt = plus ? 112 : 96;
  if (optionalSize < directoriesAt)
    formatFailure("Truncated PE optional header.");
  const entryRva = bytes.readUInt32LE(optional + 16);
  const directoryCount = Math.min(
    bytes.readUInt32LE(optional + directoriesAt - 4),
    Math.floor((optionalSize - directoriesAt) / 8),
  );
  const directory = (index: number) =>
    index < directoryCount
      ? {
          value: bytes.readUInt32LE(optional + directoriesAt + index * 8),
          size: bytes.readUInt32LE(optional + directoriesAt + index * 8 + 4),
        }
      : { value: 0, size: 0 };
  const table = optional + optionalSize;
  need(bytes, table, sectionCount * 40);
  const limitations: string[] = [];
  let incomplete = false;
  const sections: Section[] = [];
  const regions: PackerRegion[] = [];
  let mappedEnd = table + sectionCount * 40;
  for (let index = 0; index < sectionCount; index++) {
    const at = table + index * 40;
    const { name, name_hex } = decodeName(bytes.subarray(at, at + 8));
    const section = {
      virtualSize: bytes.readUInt32LE(at + 8),
      rva: bytes.readUInt32LE(at + 12),
      size: bytes.readUInt32LE(at + 16),
      offset: bytes.readUInt32LE(at + 20),
    };
    const characteristics = bytes.readUInt32LE(at + 36);
    const raw = clampRange(bytes.length, section.offset, section.size);
    if (raw.truncated) {
      incomplete = true;
      limitations.push(
        `Section ${String(index)} declares raw bytes beyond the end of the file; entropy covers only the present bytes.`,
      );
    }
    if (section.size > 0)
      mappedEnd = Math.max(mappedEnd, raw.offset + raw.bytes);
    sections.push({ ...section, size: raw.bytes });
    regions.push({
      index,
      kind: "section",
      name,
      name_hex,
      virtual_address: hexAddress(section.rva),
      virtual_size: section.virtualSize,
      raw: { offset: raw.offset, bytes: raw.bytes },
      flags_value: characteristics,
      readable: (characteristics & SCN_READ) !== 0,
      writable: (characteristics & SCN_WRITE) !== 0,
      executable: (characteristics & (SCN_EXECUTE | SCN_CODE)) !== 0,
      entropy: shannonEntropy(
        bytes.subarray(raw.offset, raw.offset + raw.bytes),
      ),
    });
  }
  const entryIndex = sections.findIndex(
    (section) =>
      entryRva >= section.rva &&
      entryRva < section.rva + Math.max(section.virtualSize, section.size),
  );
  const entrySection = sections[entryIndex];
  const entryDelta =
    entrySection === undefined ? 0 : entryRva - entrySection.rva;
  const security = directory(4);
  const certificate =
    security.value !== 0 && security.size !== 0
      ? clampRange(bytes.length, security.value, security.size)
      : undefined;
  return {
    format: plus ? "pe32-plus" : "pe32",
    machine,
    regions,
    entryAddress: BigInt(entryRva),
    entryApplicable: entryRva !== 0,
    entryRegion: regions[entryIndex],
    entryFileOffset:
      entrySection !== undefined && entryDelta < entrySection.size
        ? entrySection.offset + entryDelta
        : null,
    firstSectionIndex: sectionCount > 0 ? 0 : undefined,
    imports: readImports(bytes, sections, directory(1).value, plus),
    mappedEnd,
    certificateTable:
      certificate === undefined
        ? null
        : { offset: certificate.offset, bytes: certificate.bytes },
    elfWithoutSections: false,
    limitations: [
      ...limitations,
      "PE virtual addresses and the entry point are reported as RVAs relative to the image base.",
      "Import evidence covers the static import directory only; delay-load and runtime-resolved imports are not observed.",
    ],
    incomplete,
  };
};
