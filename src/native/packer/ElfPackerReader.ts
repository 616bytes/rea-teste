import type { PackerRegion } from "../../domain/native/packerIndicators.js";
import { formatFailure, hexAddress, shannonEntropy } from "./packerFacts.js";
import { clampRange, decodeName, type ImageFacts } from "./imageFacts.js";

const PT_LOAD = 1;
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;
const SHT_NOBITS = 8;
const SHF_WRITE = 1n;
const SHF_ALLOC = 2n;
const SHF_EXECINSTR = 4n;
const MAX_HEADERS = 65535;
const MAX_NAME = 256;

const size = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    formatFailure(`ELF ${what} exceeds the supported range.`);
  return Number(value);
};

/** ELF32/ELF64 reader over program and optional section headers, either byte order. */
export const readElfPackerFacts = (bytes: Buffer): ImageFacts => {
  if (bytes.length < 52) formatFailure("Truncated ELF header.");
  const elf64 = bytes[4] === 2;
  if (bytes[4] !== 1 && !elf64) formatFailure("Unsupported ELF class.");
  const little = bytes[5] === 1;
  if (bytes[5] !== 1 && bytes[5] !== 2)
    formatFailure("Unsupported ELF byte order.");
  if (elf64 && bytes.length < 64) formatFailure("Truncated ELF64 header.");
  const u16 = (at: number) =>
    little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at: number) =>
    little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const word = (at: number): bigint =>
    elf64
      ? little
        ? bytes.readBigUInt64LE(at)
        : bytes.readBigUInt64BE(at)
      : BigInt(u32(at));
  const need = (offset: number, length: number) => {
    if (offset > bytes.length - length)
      formatFailure(
        `ELF range ${String(offset)} + ${String(length)} leaves the artifact.`,
      );
  };
  const type = u16(16);
  const machine = u16(18);
  const entry = word(24);
  const phoff = size(word(elf64 ? 32 : 28), "program header offset");
  const shoff = size(word(elf64 ? 40 : 32), "section header offset");
  const at = elf64 ? 52 : 40;
  const phentsize = u16(at + 2);
  const phnum = u16(at + 4);
  const shentsize = u16(at + 6);
  const shnum = u16(at + 8);
  const shstrndx = u16(at + 10);
  const headerSize = elf64 ? 64 : 52;
  const phMin = elf64 ? 56 : 32;
  const shMin = elf64 ? 64 : 40;
  if (phnum > 0 && phentsize < phMin)
    formatFailure("ELF program header entries are too small.");
  if (phnum >= MAX_HEADERS || shnum >= MAX_HEADERS)
    formatFailure("Extended ELF header counts are not supported.");
  if (phnum > 0) need(phoff, phnum * phentsize);
  const limitations: string[] = [];
  let incomplete = false;
  const regions: PackerRegion[] = [];
  let mappedEnd = Math.max(
    headerSize,
    phnum > 0 ? phoff + phnum * phentsize : 0,
  );
  const region = (
    kind: PackerRegion["kind"],
    name: { name: string; name_hex: string } | null,
    address: bigint,
    virtualSize: number,
    offset: number,
    fileBytes: number,
    flags: number,
    access: { r: boolean; w: boolean; x: boolean },
  ) => {
    const raw = clampRange(bytes.length, offset, fileBytes);
    if (raw.truncated) {
      incomplete = true;
      limitations.push(
        `ELF ${kind} at file offset ${String(offset)} declares bytes beyond the end of the file; entropy covers only the present bytes.`,
      );
    }
    if (fileBytes > 0) mappedEnd = Math.max(mappedEnd, raw.offset + raw.bytes);
    const value: PackerRegion = {
      index: regions.length,
      kind,
      name: name?.name ?? null,
      name_hex: name?.name_hex ?? null,
      virtual_address: hexAddress(address),
      virtual_size: virtualSize,
      raw: { offset: raw.offset, bytes: raw.bytes },
      flags_value: flags,
      readable: access.r,
      writable: access.w,
      executable: access.x,
      entropy: shannonEntropy(
        bytes.subarray(raw.offset, raw.offset + raw.bytes),
      ),
    };
    regions.push(value);
    return value;
  };
  let entryRegion: PackerRegion | undefined;
  let entryFileOffset: number | null = null;
  for (let index = 0; index < phnum; index++) {
    const base = phoff + index * phentsize;
    if (u32(base) !== PT_LOAD) continue;
    const flags = elf64 ? u32(base + 4) : u32(base + 24);
    const offset = size(word(elf64 ? base + 8 : base + 4), "segment offset");
    const vaddr = word(elf64 ? base + 16 : base + 8);
    const filesz = size(word(elf64 ? base + 32 : base + 16), "segment size");
    const memsz = size(word(elf64 ? base + 40 : base + 20), "segment size");
    const segment = region(
      "segment",
      null,
      vaddr,
      memsz,
      offset,
      filesz,
      flags,
      {
        r: (flags & PF_R) !== 0,
        w: (flags & PF_W) !== 0,
        x: (flags & PF_X) !== 0,
      },
    );
    if (
      entryRegion === undefined &&
      entry >= vaddr &&
      entry < vaddr + BigInt(memsz)
    ) {
      entryRegion = segment;
      const delta = Number(entry - vaddr);
      entryFileOffset = delta < segment.raw.bytes ? offset + delta : null;
    }
  }
  if (shnum > 0) {
    if (shentsize < shMin)
      formatFailure("ELF section header entries are too small.");
    need(shoff, shnum * shentsize);
    mappedEnd = Math.max(mappedEnd, shoff + shnum * shentsize);
    const header = (index: number) => {
      const base = shoff + index * shentsize;
      return {
        name: u32(base),
        type: u32(base + 4),
        flags: word(base + 8),
        address: word(elf64 ? base + 16 : base + 12),
        offset: size(word(elf64 ? base + 24 : base + 16), "section offset"),
        size: size(word(elf64 ? base + 32 : base + 20), "section size"),
      };
    };
    const strings = shstrndx < shnum ? header(shstrndx) : undefined;
    const nameOf = (offset: number) => {
      if (strings === undefined || offset >= strings.size) return null;
      const start = strings.offset + offset;
      if (start >= bytes.length) return null;
      return decodeName(
        bytes.subarray(start, Math.min(bytes.length, start + MAX_NAME)),
      );
    };
    for (let index = 1; index < shnum; index++) {
      const section = header(index);
      const nobits = section.type === SHT_NOBITS;
      region(
        "section",
        nameOf(section.name),
        section.address,
        section.size,
        section.offset,
        nobits ? 0 : section.size,
        Number(section.flags & 0xffffffffn),
        {
          r: (section.flags & SHF_ALLOC) !== 0n,
          w: (section.flags & SHF_WRITE) !== 0n,
          x: (section.flags & SHF_EXECINSTR) !== 0n,
        },
      );
    }
  }
  return {
    format: elf64 ? "elf64" : "elf32",
    machine,
    regions,
    entryAddress: entry,
    entryApplicable: entry !== 0n && (type === 2 || type === 3),
    entryRegion,
    entryFileOffset,
    firstSectionIndex: undefined,
    imports: { status: "not_applicable" },
    mappedEnd,
    certificateTable: null,
    elfWithoutSections: shnum === 0 && (type === 2 || type === 3),
    limitations: [
      ...limitations,
      "ELF entry placement is evaluated against PT_LOAD segments; dynamic-symbol import heuristics are not applied to ELF.",
    ],
    incomplete,
  };
};
