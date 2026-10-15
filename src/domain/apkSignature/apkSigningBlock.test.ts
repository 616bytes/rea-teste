import { describe, expect, it } from "vitest";

import {
  APK_BLOCK_ID,
  locateApkSigningBlock,
  parseZipTail,
} from "./apkSigningBlock.js";

/** Little-endian byte builder for a minimal APK-like tail. */
class Bytes {
  readonly b: number[] = [];
  u16(v: number): this {
    this.b.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number): this {
    return this.u32(v).u32(0); // values in tests stay within 32 bits
  }
  raw(bytes: readonly number[]): this {
    this.b.push(...bytes);
    return this;
  }
  ascii(text: string): this {
    for (const c of text) this.b.push(c.charCodeAt(0));
    return this;
  }
}

/**
 * Assemble [entries][signing block][central directory][EOCD] with one V2 pair.
 * Layout is computed so the EOCD points the central directory at the block end.
 */
const apkWithBlock = (
  pairs: readonly { id: number; value: readonly number[] }[],
  withMagic = true,
): Uint8Array => {
  const entries = new Bytes().raw([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // filler
  const pairBytes = new Bytes();
  for (const p of pairs)
    pairBytes
      .u64(4 + p.value.length)
      .u32(p.id)
      .raw(p.value);
  const sizeOfBlock =
    pairBytes.b.length + 8 /* trailing size */ + 16; /* magic */
  const block = new Bytes().u64(sizeOfBlock).raw(pairBytes.b).u64(sizeOfBlock);
  if (withMagic) block.ascii("APK Sig Block 42");
  else block.ascii("NOT the block!!!"); // 16 bytes, wrong magic
  const cdOffset = entries.b.length + block.b.length;
  const cd = new Bytes().raw([0xca, 0xfe, 0xca, 0xfe]); // filler central directory
  const eocd = new Bytes()
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(1)
    .u16(1)
    .u32(cd.b.length)
    .u32(cdOffset)
    .u16(0);
  return Uint8Array.from([...entries.b, ...block.b, ...cd.b, ...eocd.b]);
};

describe("APK signing block locator", () => {
  it("parses the ZIP tail to the central-directory offset", () => {
    const tail = parseZipTail(
      apkWithBlock([{ id: APK_BLOCK_ID.signatureV2, value: [1, 2, 3, 4] }]),
    );
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.value.centralDirectoryOffset).toBe(10 + 48); // entries + block
    expect(tail.value.totalEntries).toBe(1);
  });

  it("locates the signing block and frames its id-value pairs", () => {
    const bytes = apkWithBlock([
      { id: APK_BLOCK_ID.signatureV2, value: [0xaa, 0xbb, 0xcc, 0xdd] },
      { id: APK_BLOCK_ID.signatureV3, value: [0x11, 0x22] },
    ]);
    const tail = parseZipTail(bytes);
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    const block = locateApkSigningBlock(bytes, tail.value);
    expect(block.ok).toBe(true);
    if (!block.ok || block.value === null) return expect(block).toBeTruthy();
    expect(block.value.pairs.map((p) => p.id)).toEqual([
      APK_BLOCK_ID.signatureV2,
      APK_BLOCK_ID.signatureV3,
    ]);
    expect([...block.value.pairs[0]!.value]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("returns null when no block magic precedes the central directory", () => {
    const bytes = apkWithBlock(
      [{ id: APK_BLOCK_ID.signatureV2, value: [1, 2, 3, 4] }],
      false,
    );
    const tail = parseZipTail(bytes);
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    const block = locateApkSigningBlock(bytes, tail.value);
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(block.value).toBeNull();
  });

  it("refuses a buffer with no end-of-central-directory record", () => {
    const result = parseZipTail(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not-a-zip");
  });

  it("flags a leading/trailing size mismatch as malformed", () => {
    const bytes = apkWithBlock([
      { id: APK_BLOCK_ID.signatureV2, value: [1, 2, 3, 4] },
    ]);
    // Corrupt the leading size (first byte of the block, after 10 filler bytes).
    bytes[10] = 0xff;
    const tail = parseZipTail(bytes);
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    const block = locateApkSigningBlock(bytes, tail.value);
    expect(block.ok).toBe(false);
    if (block.ok) return;
    expect(block.error.kind).toBe("malformed-block");
  });
});
