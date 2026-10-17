const concat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

const pad = (bytes: Buffer, alignment: number): Buffer => {
  const size = alignTo(bytes.length, alignment);
  if (size === bytes.length) return bytes;
  const padded = Buffer.alloc(size);
  bytes.copy(padded);
  return padded;
};

const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) {
    if (little) bytes.writeBigUInt64LE(BigInt(value), offset);
    else bytes.writeBigUInt64BE(BigInt(value), offset);
    return;
  }
  if (little) bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
};

const write16 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
};

const write32 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
};

/** Encode one ELF note with 4-byte name/descriptor padding. */
export const elfNote = (
  owner: string,
  type: number,
  descriptor: Buffer,
  little = true,
  alignment = 4,
): Buffer => {
  const name = Buffer.from(`${owner}\0`, "latin1");
  const header = Buffer.alloc(12);
  write32(header, 0, name.length, little);
  write32(header, 4, descriptor.length, little);
  write32(header, 8, type, little);
  return concat(header, pad(name, alignment), pad(descriptor, alignment));
};

/** GNU NT_GNU_BUILD_ID note with a 20-byte descriptor. */
export const gnuBuildIdNote = (
  hex = "0123456789abcdef0123456789abcdef01234567",
  little = true,
): Buffer => elfNote("GNU", 3, Buffer.from(hex, "hex"), little);

/** GNU NT_GNU_ABI_TAG note: Linux 3.2.0. */
export const gnuAbiTagNote = (little = true): Buffer => {
  const descriptor = Buffer.alloc(16);
  write32(descriptor, 0, 0, little);
  write32(descriptor, 4, 3, little);
  write32(descriptor, 8, 2, little);
  write32(descriptor, 12, 0, little);
  return elfNote("GNU", 1, descriptor, little);
};

export interface ElfNoteImageOptions {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly notes?: Buffer;
  readonly ownership?: "program" | "section" | "both" | "none";
  readonly machine?: number;
  readonly type?: number;
}

/** Minimal ELF32/ELF64 image declaring PT_NOTE and/or SHT_NOTE. */
export const elfNoteFixture = (options: ElfNoteImageOptions = {}): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const ownership = options.ownership ?? "both";
  const notes =
    options.notes ??
    concat(gnuBuildIdNote(undefined, little), gnuAbiTagNote(little));
  const header = bits === 64 ? 64 : 52;
  const phent = bits === 64 ? 56 : 32;
  const shent = bits === 64 ? 64 : 40;
  const program = ownership === "program" || ownership === "both";
  const section = ownership === "section" || ownership === "both";
  const phnum = program ? 1 : 0;
  const shstrtab = Buffer.from("\0.note.gnu.build-id\0.shstrtab\0", "latin1");
  const shnum = section ? 3 : 0;
  const phoff = header;
  const shoff = phoff + phnum * phent;
  const noteOff = alignTo(shoff + shnum * shent, 4);
  const strOff = noteOff + notes.length;
  const bytes = Buffer.alloc(strOff + (section ? shstrtab.length : 0));
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = bits === 64 ? 2 : 1;
  bytes[5] = little ? 1 : 2;
  bytes[6] = 1;
  write16(bytes, 0x10, options.type ?? 3, little);
  write16(bytes, 0x12, options.machine ?? 62, little);
  write32(bytes, 0x14, 1, little);
  write16(bytes, bits === 64 ? 0x34 : 0x28, header, little);
  writeWord(
    bytes,
    bits === 64 ? 0x20 : 0x1c,
    phnum === 0 ? 0 : phoff,
    bits,
    little,
  );
  write16(bytes, bits === 64 ? 0x36 : 0x2a, phent, little);
  write16(bytes, bits === 64 ? 0x38 : 0x2c, phnum, little);
  writeWord(
    bytes,
    bits === 64 ? 0x28 : 0x20,
    shnum === 0 ? 0 : shoff,
    bits,
    little,
  );
  write16(bytes, bits === 64 ? 0x3a : 0x2e, shent, little);
  write16(bytes, bits === 64 ? 0x3c : 0x30, shnum, little);
  write16(bytes, bits === 64 ? 0x3e : 0x32, section ? 2 : 0, little);
  if (program) {
    const ph = phoff;
    write32(bytes, ph, 4, little);
    if (bits === 64) {
      write32(bytes, ph + 4, 4, little);
      writeWord(bytes, ph + 8, noteOff, bits, little);
      writeWord(bytes, ph + 32, notes.length, bits, little);
      writeWord(bytes, ph + 40, notes.length, bits, little);
      writeWord(bytes, ph + 48, 4, bits, little);
    } else {
      writeWord(bytes, ph + 4, noteOff, bits, little);
      writeWord(bytes, ph + 16, notes.length, bits, little);
      writeWord(bytes, ph + 20, notes.length, bits, little);
      write32(bytes, ph + 24, 4, little);
      writeWord(bytes, ph + 28, 4, bits, little);
    }
  }
  if (section) {
    const noteName = 1;
    const strName = ".note.gnu.build-id\0".length + 1;
    const noteSh = shoff + shent;
    const strSh = shoff + 2 * shent;
    write32(bytes, noteSh, noteName, little);
    write32(bytes, noteSh + 4, 7, little);
    writeWord(bytes, noteSh + (bits === 64 ? 24 : 16), noteOff, bits, little);
    writeWord(
      bytes,
      noteSh + (bits === 64 ? 32 : 20),
      notes.length,
      bits,
      little,
    );
    writeWord(bytes, noteSh + (bits === 64 ? 48 : 32), 4, bits, little);
    write32(bytes, strSh, strName, little);
    write32(bytes, strSh + 4, 3, little);
    writeWord(bytes, strSh + (bits === 64 ? 24 : 16), strOff, bits, little);
    writeWord(
      bytes,
      strSh + (bits === 64 ? 32 : 20),
      shstrtab.length,
      bits,
      little,
    );
    shstrtab.copy(bytes, strOff);
  }
  notes.copy(bytes, noteOff);
  return bytes;
};
