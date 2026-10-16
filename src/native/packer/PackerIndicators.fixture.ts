/** Hand-built PE/ELF images for packer indicator tests; no real packed program. */

interface PeSection {
  readonly name: string;
  readonly virtualSize: number;
  readonly rva: number;
  readonly raw: Buffer;
  readonly characteristics: number;
}

export const CODE_RX = 0x60000020;
export const DATA_RW = 0xc0000040;
export const RWX = 0xe0000060;

/** Deterministic high-entropy filler (xorshift), standing in for compressed data. */
export const noise = (length: number, seed = 0x12345678): Buffer => {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

/** Low-entropy, code-like filler. */
export const plain = (length: number): Buffer =>
  Buffer.from(
    Array.from(
      { length },
      (_, index) => [0x55, 0x48, 0x89, 0xe5, 0xc3, 0x90][index % 6] ?? 0,
    ),
  );

interface PeOptions {
  readonly plus?: boolean;
  readonly sections: readonly PeSection[];
  readonly entryRva: number;
  readonly importRva?: number;
  readonly overlay?: Buffer;
  readonly certificate?: { offset: number; bytes: number };
}

const FILE_ALIGN = 0x200;
const align = (value: number) => Math.ceil(value / FILE_ALIGN) * FILE_ALIGN;

/** Build a minimal PE32/PE32+ with the given sections laid out after headers. */
export const peImage = (options: PeOptions): Buffer => {
  const plus = options.plus ?? false;
  const pe = 0x80;
  const optionalSize = plus ? 240 : 224;
  const table = pe + 24 + optionalSize;
  const headerSize = align(table + options.sections.length * 40);
  let cursor = headerSize;
  const offsets = options.sections.map((section) => {
    const at = section.raw.length === 0 ? 0 : cursor;
    cursor += align(section.raw.length);
    return at;
  });
  const image = Buffer.alloc(cursor);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(pe, 60);
  image.writeUInt32LE(0x4550, pe);
  image.writeUInt16LE(plus ? 0x8664 : 0x14c, pe + 4);
  image.writeUInt16LE(options.sections.length, pe + 6);
  image.writeUInt16LE(optionalSize, pe + 20);
  const optional = pe + 24;
  image.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  image.writeUInt32LE(options.entryRva, optional + 16);
  image.writeUInt32LE(headerSize, optional + 60);
  const directories = optional + (plus ? 112 : 96);
  image.writeUInt32LE(16, directories - 4);
  image.writeUInt32LE(options.importRva ?? 0, directories + 8);
  image.writeUInt32LE(
    options.importRva === undefined ? 0 : 40,
    directories + 12,
  );
  options.sections.forEach((section, index) => {
    const at = table + index * 40;
    image.write(section.name, at, 8, "latin1");
    image.writeUInt32LE(section.virtualSize, at + 8);
    image.writeUInt32LE(section.rva, at + 12);
    image.writeUInt32LE(align(section.raw.length), at + 16);
    image.writeUInt32LE(offsets[index] ?? 0, at + 20);
    image.writeUInt32LE(section.characteristics, at + 36);
    section.raw.copy(image, offsets[index] ?? 0);
  });
  const overlay = options.overlay ?? Buffer.alloc(0);
  if (options.certificate !== undefined) {
    image.writeUInt32LE(options.certificate.offset, directories + 32);
    image.writeUInt32LE(options.certificate.bytes, directories + 36);
  }
  return Buffer.concat([image, overlay]);
};

/** Import directory placed at `rva` inside a section's raw bytes (PE32 thunks). */
export const importSection = (
  rva: number,
  libraries: readonly { name: string; functions: readonly string[] }[],
  plus = false,
): Buffer => {
  const width = plus ? 8 : 4;
  const parts: Buffer[] = [];
  let size = (libraries.length + 1) * 20;
  const descriptors = Buffer.alloc(size);
  const layout = libraries.map((library) => {
    const thunks = size;
    size += (library.functions.length + 1) * width;
    return { library, thunks };
  });
  const names = new Map<string, number>();
  const tail: Buffer[] = [];
  const stringAt = (value: Buffer) => {
    const at = size;
    tail.push(value);
    size += value.length;
    return at;
  };
  const thunkBlocks = layout.map(({ library, thunks }, index) => {
    const block = Buffer.alloc((library.functions.length + 1) * width);
    library.functions.forEach((name, slot) => {
      const hint = Buffer.concat([
        Buffer.alloc(2),
        Buffer.from(`${name}\0`, "latin1"),
      ]);
      const at = names.get(name) ?? stringAt(hint);
      names.set(name, at);
      if (plus) block.writeBigUInt64LE(BigInt(rva + at), slot * width);
      else block.writeUInt32LE(rva + at, slot * width);
    });
    const dll = stringAt(Buffer.from(`${library.name}\0`, "latin1"));
    descriptors.writeUInt32LE(rva + thunks, index * 20);
    descriptors.writeUInt32LE(rva + dll, index * 20 + 12);
    descriptors.writeUInt32LE(rva + thunks, index * 20 + 16);
    return block;
  });
  parts.push(descriptors, ...thunkBlocks, ...tail);
  return Buffer.concat(parts);
};

interface ElfSegment {
  readonly flags: number;
  readonly vaddr: bigint;
  readonly data: Buffer;
  readonly memsz?: number;
}

/** Build a little-endian ELF64 (or ELF32) EXEC image with PT_LOAD segments and optional sections. */
export const elfImage = (options: {
  readonly elf64?: boolean;
  readonly entry: bigint;
  readonly segments: readonly ElfSegment[];
  readonly sections?: readonly {
    name: string;
    flags: number;
    segment: number;
  }[];
  readonly trailer?: Buffer;
}): Buffer => {
  const elf64 = options.elf64 ?? true;
  const ehsize = elf64 ? 64 : 52;
  const phentsize = elf64 ? 56 : 32;
  const shentsize = elf64 ? 64 : 40;
  const phoff = ehsize;
  let cursor = phoff + options.segments.length * phentsize;
  const offsets = options.segments.map((segment) => {
    const at = cursor;
    cursor += segment.data.length;
    return at;
  });
  const sections = options.sections ?? [];
  const strtab = Buffer.from(
    `\0${sections.map((section) => `${section.name}\0`).join("")}.shstrtab\0`,
    "latin1",
  );
  const strtabOffset = cursor;
  const shoff = sections.length === 0 ? 0 : strtabOffset + strtab.length;
  const shnum = sections.length === 0 ? 0 : sections.length + 2;
  const total = sections.length === 0 ? cursor : shoff + shnum * shentsize;
  const image = Buffer.alloc(total);
  image.writeUInt32BE(0x7f454c46, 0);
  image[4] = elf64 ? 2 : 1;
  image[5] = 1;
  image[6] = 1;
  image.writeUInt16LE(2, 16);
  image.writeUInt16LE(elf64 ? 62 : 3, 18);
  image.writeUInt32LE(1, 20);
  const word = (at: number, value: bigint | number) =>
    elf64
      ? image.writeBigUInt64LE(BigInt(value), at)
      : image.writeUInt32LE(Number(value), at);
  word(24, options.entry);
  word(elf64 ? 32 : 28, phoff);
  word(elf64 ? 40 : 32, shoff);
  const at = elf64 ? 52 : 40;
  image.writeUInt16LE(ehsize, at);
  image.writeUInt16LE(phentsize, at + 2);
  image.writeUInt16LE(options.segments.length, at + 4);
  image.writeUInt16LE(shentsize, at + 6);
  image.writeUInt16LE(shnum, at + 8);
  image.writeUInt16LE(shnum === 0 ? 0 : shnum - 1, at + 10);
  options.segments.forEach((segment, index) => {
    const base = phoff + index * phentsize;
    const offset = offsets[index] ?? 0;
    image.writeUInt32LE(1, base);
    if (elf64) {
      image.writeUInt32LE(segment.flags, base + 4);
      image.writeBigUInt64LE(BigInt(offset), base + 8);
      image.writeBigUInt64LE(segment.vaddr, base + 16);
      image.writeBigUInt64LE(BigInt(segment.data.length), base + 32);
      image.writeBigUInt64LE(
        BigInt(segment.memsz ?? segment.data.length),
        base + 40,
      );
    } else {
      image.writeUInt32LE(offset, base + 4);
      image.writeUInt32LE(Number(segment.vaddr), base + 8);
      image.writeUInt32LE(segment.data.length, base + 16);
      image.writeUInt32LE(segment.memsz ?? segment.data.length, base + 20);
      image.writeUInt32LE(segment.flags, base + 24);
    }
    segment.data.copy(image, offset);
  });
  if (sections.length > 0) {
    strtab.copy(image, strtabOffset);
    let nameAt = 1;
    const header = (
      index: number,
      name: number,
      type: number,
      flags: number,
      address: bigint,
      offset: number,
      size: number,
    ) => {
      const base = shoff + index * shentsize;
      image.writeUInt32LE(name, base);
      image.writeUInt32LE(type, base + 4);
      if (elf64) {
        image.writeBigUInt64LE(BigInt(flags), base + 8);
        image.writeBigUInt64LE(address, base + 16);
        image.writeBigUInt64LE(BigInt(offset), base + 24);
        image.writeBigUInt64LE(BigInt(size), base + 32);
      } else {
        image.writeUInt32LE(flags, base + 8);
        image.writeUInt32LE(Number(address), base + 12);
        image.writeUInt32LE(offset, base + 16);
        image.writeUInt32LE(size, base + 20);
      }
    };
    sections.forEach((section, index) => {
      const segment = options.segments[section.segment];
      header(
        index + 1,
        nameAt,
        1,
        section.flags,
        segment?.vaddr ?? 0n,
        offsets[section.segment] ?? 0,
        segment?.data.length ?? 0,
      );
      nameAt += section.name.length + 1;
    });
    header(shnum - 1, nameAt, 3, 0, 0n, strtabOffset, strtab.length);
  }
  return Buffer.concat([image, options.trailer ?? Buffer.alloc(0)]);
};
