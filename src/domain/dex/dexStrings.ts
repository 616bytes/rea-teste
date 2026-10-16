/**
 * Resolve names and type descriptors from a DEX file's string and type id pools
 * (Dalvik Executable format). A `string_id_item` is a u4 offset to a
 * `string_data_item` (`uleb128 utf16_size` then NUL-terminated modified UTF-8);
 * a `type_id_item` is a u4 index into the string pool. All lookups are bounded
 * and return `null` for an out-of-range index (including NO_INDEX = -1) or a
 * malformed/uncross-checked string, never a throw or a guess.
 */
import { decodeModifiedUtf8, modifiedUtf8JsonBound } from "../modifiedUtf8.js";
import { DEX_MAX_PARAMETERS } from "./dexDebugInfo.js";
import { DEX_NO_INDEX, DexCursor, type DexHeader } from "./dexFile.js";

/**
 * The resolver is the owner of string identity for one DEX file, so it decodes
 * each string id at most once: thousands of locals sharing one long name must
 * cost one decode, not one per reference.
 */
/**
 * Entries kept per memo. Memoisation is an optimisation, not a working set:
 * past the cap a value is recomputed, never retained, so a DEX with millions of
 * distinct strings or protos cannot grow these maps without bound.
 */
const MEMO_LIMIT = 65_536;

export class DexStringResolver {
  private readonly view: DataView;
  readonly #strings = new Map<number, string | null>();
  readonly #bounds = new Map<number, number>();
  constructor(
    private readonly bytes: Uint8Array,
    private readonly header: DexHeader,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #remember<K, V>(memo: Map<K, V>, key: K, value: V): void {
    if (memo.size < MEMO_LIMIT) memo.set(key, value);
  }

  /** Resolve a string-pool index to its text, or `null` when absent/malformed. */
  string(index: number): string | null {
    const cached = this.#strings.get(index);
    if (cached !== undefined || this.#strings.has(index)) return cached ?? null;
    const raw = this.#raw(index);
    const decoded = raw === null ? null : this.#decode(raw);
    this.#remember(this.#strings, index, decoded);
    return decoded;
  }

  /**
   * Upper bound on the JSON bytes `string(index)` serialises to (4 for `null`),
   * computed from the raw bytes without decoding and memoised per index.
   */
  jsonBound(index: number): number {
    let bound = this.#bounds.get(index);
    if (bound === undefined) {
      const raw = this.#raw(index);
      bound = raw === null ? 4 : Math.max(4, modifiedUtf8JsonBound(raw.bytes));
      this.#remember(this.#bounds, index, bound);
    }
    return bound;
  }

  /** JSON bound of a type id's descriptor string. */
  typeJsonBound(index: number): number {
    const stringIdx = this.#typeStringIndex(index);
    return stringIdx === null ? 4 : this.jsonBound(stringIdx);
  }

  #decode(raw: {
    readonly bytes: Uint8Array;
    readonly utf16Size: number;
  }): string | null {
    const decoded = decodeModifiedUtf8(raw.bytes);
    // A length that disagrees with the declared UTF-16 size is malformed.
    return decoded === null || decoded.length !== raw.utf16Size
      ? null
      : decoded;
  }

  /** The string's modified-UTF8 bytes (a view) and declared UTF-16 size, memoised. */
  #raw(
    index: number,
  ): { readonly bytes: Uint8Array; readonly utf16Size: number } | null {
    const memo = this.#rawMemo.get(index);
    if (memo !== undefined || this.#rawMemo.has(index)) return memo ?? null;
    const raw = this.#locate(index);
    this.#remember(this.#rawMemo, index, raw);
    return raw;
  }

  readonly #rawMemo = new Map<
    number,
    { readonly bytes: Uint8Array; readonly utf16Size: number } | null
  >();

  #locate(
    index: number,
  ): { readonly bytes: Uint8Array; readonly utf16Size: number } | null {
    if (
      index < 0 ||
      index === DEX_NO_INDEX ||
      index >= this.header.stringIdsSize
    )
      return null;
    const idOffset = this.header.stringIdsOff + index * 4;
    if (idOffset + 4 > this.bytes.length) return null;
    const dataOffset = this.view.getUint32(idOffset, true);
    if (dataOffset <= 0 || dataOffset >= this.bytes.length) return null;
    const cursor = new DexCursor(this.bytes, dataOffset);
    const utf16Size = cursor.uleb128();
    if (!utf16Size.ok) return null;
    // Modified UTF-8 runs to a NUL terminator; find it within the buffer.
    let end = cursor.offset;
    while (end < this.bytes.length && this.bytes[end] !== 0x00) end += 1;
    if (end >= this.bytes.length) return null; // unterminated
    return {
      bytes: this.bytes.subarray(cursor.offset, end),
      utf16Size: utf16Size.value,
    };
  }

  /** Resolve a type-pool index to its descriptor string (e.g. `Lcom/example/Foo;`). */
  typeDescriptor(index: number): string | null {
    const stringIdx = this.#typeStringIndex(index);
    return stringIdx === null ? null : this.string(stringIdx);
  }

  #typeStringIndex(index: number): number | null {
    if (index < 0 || index === DEX_NO_INDEX || index >= this.header.typeIdsSize)
      return null;
    const idOffset = this.header.typeIdsOff + index * 4;
    if (idOffset + 4 > this.bytes.length) return null;
    return this.view.getUint32(idOffset, true);
  }

  /** Bounded u4 read, or null past the end. */
  #u4(at: number): number | null {
    return at >= 0 && at + 4 <= this.bytes.length
      ? this.view.getUint32(at, true)
      : null;
  }

  /** A method's `proto_idx`, or null when the method or proto is out of range. */
  methodProtoIndex(methodIndex: number): number | null {
    if (methodIndex < 0 || methodIndex >= this.header.methodIdsSize)
      return null;
    const protoAt = this.header.methodIdsOff + methodIndex * 8 + 2;
    if (protoAt + 2 > this.bytes.length) return null;
    const protoIndex = this.view.getUint16(protoAt, true);
    return protoIndex < this.header.protoIdsSize ? protoIndex : null;
  }

  /** `method_id_item` = { class_idx u2, proto_idx u2, name_idx u4 }. */
  methodName(methodIndex: number): string | null {
    if (methodIndex < 0 || methodIndex >= this.header.methodIdsSize)
      return null;
    const nameIdx = this.#u4(this.header.methodIdsOff + methodIndex * 8 + 4);
    return nameIdx === null ? null : this.string(nameIdx);
  }

  /**
   * The JVM-form descriptor of a method, e.g. `(Ljava/lang/String;I)V`, built
   * from its `proto_id_item` { shorty_idx u4, return_type_idx u4,
   * parameters_off u4 } and the `type_list` at `parameters_off`.
   */
  methodDescriptor(methodIndex: number): string | null {
    if (methodIndex < 0 || methodIndex >= this.header.methodIdsSize)
      return null;
    // method_id_item: class_idx u2 @0, proto_idx u2 @2, name_idx u4 @4.
    const protoAt = this.header.methodIdsOff + methodIndex * 8 + 2;
    if (protoAt + 2 > this.bytes.length) return null;
    const protoIndex = this.view.getUint16(protoAt, true);
    if (protoIndex >= this.header.protoIdsSize) return null;
    const protoBase = this.header.protoIdsOff + protoIndex * 12;
    const returnTypeIdx = this.#u4(protoBase + 4);
    const parametersOff = this.#u4(protoBase + 8);
    if (returnTypeIdx === null || parametersOff === null) return null;
    const returnDescriptor = this.typeDescriptor(returnTypeIdx);
    if (returnDescriptor === null) return null;
    const params = this.#typeList(parametersOff);
    if (params === null) return null;
    return `(${params.join("")})${returnDescriptor}`;
  }

  /**
   * A method's proto parameter types, in declaration order, each with whether it
   * is wide (long/double — occupies two registers but one parameter slot). Used
   * to seed the implicit parameter locals that a debug_info_item starts at
   * address 0. Returns null when the method or proto cannot be resolved.
   */
  methodParameters(
    methodIndex: number,
  ): readonly { readonly typeIdx: number; readonly wide: boolean }[] | null {
    if (methodIndex < 0 || methodIndex >= this.header.methodIdsSize)
      return null;
    const protoAt = this.header.methodIdsOff + methodIndex * 8 + 2;
    if (protoAt + 2 > this.bytes.length) return null;
    const protoIndex = this.view.getUint16(protoAt, true);
    if (protoIndex >= this.header.protoIdsSize) return null;
    // Many methods share a proto; resolve each proto once.
    const cached = this.#protoParams.get(protoIndex);
    if (cached !== undefined || this.#protoParams.has(protoIndex))
      return cached ?? null;
    const params = this.#protoParameters(protoIndex);
    this.#remember(this.#protoParams, protoIndex, params);
    return params;
  }

  readonly #protoParams = new Map<
    number,
    readonly { readonly typeIdx: number; readonly wide: boolean }[] | null
  >();

  #protoParameters(
    protoIndex: number,
  ): readonly { readonly typeIdx: number; readonly wide: boolean }[] | null {
    const parametersOff = this.#u4(
      this.header.protoIdsOff + protoIndex * 12 + 8,
    );
    if (parametersOff === null) return null;
    if (parametersOff === 0) return [];
    const size = this.#u4(parametersOff);
    // A proto with more parameters than a method's 255 argument registers can
    // hold is malformed; refuse before allocating its list.
    if (size === null || size > DEX_MAX_PARAMETERS) return null;
    const params: { typeIdx: number; wide: boolean }[] = [];
    for (let i = 0; i < size; i += 1) {
      const at = parametersOff + 4 + i * 2;
      if (at + 2 > this.bytes.length) return null;
      const typeIdx = this.view.getUint16(at, true);
      const descriptor = this.typeDescriptor(typeIdx);
      params.push({ typeIdx, wide: descriptor === "J" || descriptor === "D" });
    }
    return params;
  }

  /** A `type_list` { size u4, list[size] of u2 type_idx }, resolved to descriptors. */
  #typeList(offset: number): string[] | null {
    if (offset === 0) return []; // no parameters
    const size = this.#u4(offset);
    if (size === null || size > DEX_MAX_PARAMETERS) return null;
    const descriptors: string[] = [];
    for (let i = 0; i < size; i += 1) {
      const at = offset + 4 + i * 2;
      if (at + 2 > this.bytes.length) return null;
      const descriptor = this.typeDescriptor(this.view.getUint16(at, true));
      if (descriptor === null) return null;
      descriptors.push(descriptor);
    }
    return descriptors;
  }
}
