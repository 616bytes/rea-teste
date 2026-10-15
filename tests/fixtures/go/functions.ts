import { createGoBinaryFixture } from "./image.js";

/** Authored ELF metadata, with no executable payload or compiler-built artifact. */
export const createGoFunctionFixture = () => {
  const { bytes } = createGoBinaryFixture();
  const table = 2048;
  const text = 1536;
  const names = Buffer.from("\0.shstrtab\0.go.buildinfo\0.gopclntab\0.text\0");
  names.copy(bytes, 768);
  bytes.writeBigUInt64LE(BigInt(names.length), 320 + 32);
  bytes.writeBigUInt64LE(512n, 384 + 32);
  bytes.writeUInt16LE(5, 60);
  for (const [header, name, offset, size, flags] of [
    [448, ".gopclntab", table, 512, 2],
    [512, ".text", text, 128, 6],
  ] as const) {
    bytes.writeUInt32LE(names.indexOf(name), header);
    bytes.writeUInt32LE(1, header + 4);
    bytes.writeBigUInt64LE(BigInt(flags), header + 8);
    bytes.writeBigUInt64LE(BigInt(0x10000 + offset), header + 16);
    bytes.writeBigUInt64LE(BigInt(offset), header + 24);
    bytes.writeBigUInt64LE(BigInt(size), header + 32);
  }
  bytes.writeUInt32LE(0xfffffff1, table);
  bytes[table + 6] = 1;
  bytes[table + 7] = 8;
  bytes.writeBigUInt64LE(2n, table + 8);
  // As in Go 1.27, textStart is zero; the ELF .text address is authoritative.
  for (const [index, value] of [72, 128, 128, 128, 256].entries())
    bytes.writeBigUInt64LE(BigInt(value), table + 32 + index * 8);
  const firstName = Buffer.from("main.加法\0");
  firstName.copy(bytes, table + 72);
  bytes.write("main.choose\0", table + 72 + firstName.length);
  bytes.writeUInt32LE(0, table + 256);
  bytes.writeUInt32LE(24, table + 260);
  bytes.writeUInt32LE(32, table + 264);
  bytes.writeUInt32LE(40, table + 268);
  bytes.writeUInt32LE(64, table + 272);
  bytes.writeUInt32LE(0, table + 280);
  bytes.writeUInt32LE(0, table + 284);
  bytes.writeUInt32LE(32, table + 296);
  bytes.writeUInt32LE(firstName.length, table + 300);
  return { bytes, table, text };
};
