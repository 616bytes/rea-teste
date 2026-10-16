/**
 * Shared DEX test fixtures: LEB128 encoders, a little-endian byte builder, the
 * one-class debuggable DEX used across the domain, provider and public
 * workflow tests, and an in-memory APK/ZIP writer. Nothing here is committed
 * as a binary; every artifact is built by the test that uses it.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { DexParameterList } from "../../src/domain/dex/dexDebugInfo.js";

/** Unsigned LEB128. */
export const uleb = (value: number): number[] => {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
};

/** `uleb128p1`: the value plus one, so `-1` (NO_INDEX) encodes as `0`. */
export const ulebp1 = (value: number): number[] => uleb(value + 1);

/** Signed LEB128. */
export const sleb = (value: number): number[] => {
  const out: number[] = [];
  let more = true;
  let v = value;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0))
      more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
};

/** A growing little-endian byte builder that records section offsets. */
export class DexBuilder {
  private readonly b: number[] = [];
  u1(v: number): this {
    this.b.push(v & 0xff);
    return this;
  }
  u2(v: number): this {
    this.b.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u4(v: number): this {
    this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  uleb(v: number): this {
    this.b.push(...uleb(v));
    return this;
  }
  ulebp1(v: number): this {
    return this.uleb(v + 1);
  }
  ascii(text: string): this {
    for (const c of text) this.b.push(c.charCodeAt(0));
    return this;
  }
  at(): number {
    return this.b.length;
  }
  setU4(at: number, v: number): void {
    this.b[at] = v & 0xff;
    this.b[at + 1] = (v >> 8) & 0xff;
    this.b[at + 2] = (v >> 16) & 0xff;
    this.b[at + 3] = (v >>> 24) & 0xff;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.b);
  }
}

const NO_INDEX = 0xffff_ffff;
const STRINGS = ["Foo.java", "run", "x", "Lcom/example/Foo;", "I", "V"];

/**
 * One class `Lcom/example/Foo;` (source `Foo.java`) with one static method
 * `run` `(I)V` whose code_item carries a debug_info_item with one parameter
 * name (`x`, seeded as an implicit local) and one line position.
 */
export const debuggableDex = (): Uint8Array => {
  const d = new DexBuilder();
  for (let i = 0; i < 112; i += 1) d.u1(0); // header placeholder
  const stringDataOff = STRINGS.map((s) => {
    const off = d.at();
    d.uleb(s.length).ascii(s).u1(0);
    return off;
  });
  const stringIdsOff = d.at();
  for (const off of stringDataOff) d.u4(off);
  // type_ids: type0->str3, type1->str4, type2->str5
  const typeIdsOff = d.at();
  for (const s of [3, 4, 5]) d.u4(s);
  // type_list for (I): size 1, type_idx 1
  const typeListOff = d.at();
  d.u4(1).u2(1);
  // proto_ids: one proto (shorty 0, return type 2=V, params type_list)
  const protoIdsOff = d.at();
  d.u4(0).u4(2).u4(typeListOff);
  // method_ids: class_idx 0, proto_idx 0, name_idx 1 ("run")
  const methodIdsOff = d.at();
  d.u2(0).u2(0).u4(1);
  const debugInfoOff = d.at();
  d.uleb(10).uleb(1).ulebp1(2); // line_start 10, 1 param, name "x"
  d.u1(0x0e).u1(0x00); // special emit (position at line 10), END_SEQUENCE
  // code_item: registers 1, ins 1, outs 0, tries 0, debug_info_off, insns 4
  const codeOff = d.at();
  d.u2(1).u2(1).u2(0).u2(0).u4(debugInfoOff).u4(4);
  for (let i = 0; i < 4; i += 1) d.u2(0); // insns
  // class_data: 0 static, 0 instance, 1 direct, 0 virtual; method diff 0,
  // access 0x9 (public|static), code_off.
  const classDataOff = d.at();
  d.uleb(0).uleb(0).uleb(1).uleb(0).uleb(0).uleb(0x9).uleb(codeOff);
  // class_def: class_idx 0, access, superclass NO_INDEX, interfaces 0,
  // source_file_idx 0 ("Foo.java"), annotations 0, class_data_off, static 0
  const classDefsOff = d.at();
  d.u4(0).u4(1).u4(NO_INDEX).u4(0).u4(0).u4(0).u4(classDataOff).u4(0);
  d.setU4(0, 0x0a786564); // "dex\n"
  d.setU4(4, 0x00353330); // "035\0"
  d.setU4(32, d.at()); // file_size
  d.setU4(36, 0x70); // header_size
  d.setU4(40, 0x12345678); // endian_tag
  d.setU4(56, STRINGS.length);
  d.setU4(60, stringIdsOff);
  d.setU4(64, 3); // type_ids_size
  d.setU4(68, typeIdsOff);
  d.setU4(72, 1); // proto_ids_size
  d.setU4(76, protoIdsOff);
  d.setU4(88, 1); // method_ids_size
  d.setU4(92, methodIdsOff);
  d.setU4(96, 1); // class_defs_size
  d.setU4(100, classDefsOff);
  return d.bytes();
};

/** A proto's parameter list from plain entries. */
export const dexParameterList = (
  entries: readonly { readonly typeIdx: number; readonly wide: boolean }[],
): DexParameterList => ({
  typeIdx: Uint16Array.from(entries, (e) => e.typeIdx),
  wide: Uint8Array.from(entries, (e) => (e.wide ? 1 : 0)),
});

/** An in-memory APK/ZIP holding `members` under their exact names, in order. */
export const zipArchive = async (
  members: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const member of members)
    await writer.add(member.name, new Uint8ArrayReader(member.bytes));
  return writer.close();
};
