/**
 * Decode the compiler-emitted debug attributes relevant to debugging readiness
 * (JVMS §4.7.10–4.7.14) from a framed {@link JavaClassFile}:
 * `SourceFile`, `SourceDebugExtension`, `LineNumberTable`, `LocalVariableTable`
 * and `LocalVariableTypeTable`.
 *
 * This module interprets attribute `info` bytes that {@link parseJavaClassFile}
 * framed but left undecoded. It never executes Java, resolves source URLs, or
 * claims that any source matches a declared `SourceFile`. `SourceDebugExtension`
 * stays opaque — only its presence and size are reported. Facts are preserved
 * on partial failure: a table that runs short is reported `malformed` with the
 * entries recovered before the short read, not discarded.
 */
import {
  ByteCursor,
  type ConstantPoolEntry,
  type JavaClassFile,
  type JavaMember,
  parseAttributes,
  resolveConstantUtf8,
} from "./javaClassFile.js";

/** Whether a named attribute was found and whether it decoded cleanly. */
export type AttributePresence = "absent" | "present" | "malformed";

/** A decoded debug table with the entries recovered and how fully it was read. */
export interface DebugTable<T> {
  readonly presence: AttributePresence;
  /** The attribute's self-declared entry count, or 0 when the attribute is absent. */
  readonly declaredCount: number;
  readonly entries: readonly T[];
}

export interface LineNumberEntry {
  readonly startPc: number;
  readonly lineNumber: number;
}

export interface LocalVariableEntry {
  readonly startPc: number;
  readonly length: number;
  readonly nameIndex: number;
  readonly name: string | null;
  readonly descriptorIndex: number;
  readonly descriptor: string | null;
  /** The local-variable array slot; wide (long/double) locals occupy this slot and the next. */
  readonly slot: number;
}

export interface LocalVariableTypeEntry {
  readonly startPc: number;
  readonly length: number;
  readonly nameIndex: number;
  readonly name: string | null;
  readonly signatureIndex: number;
  readonly signature: string | null;
  readonly slot: number;
}

/** Overall debugging-readiness of one method's body. */
export type MethodDebugState =
  | "present" // line and local-variable tables both decoded
  | "partial" // one of them present, the other absent
  | "stripped" // a body exists but carries neither table (e.g. javac -g:none)
  | "malformed" // a present table failed to decode fully
  | "not-applicable"; // no Code attribute (native/abstract, or no body)

export interface MethodDebugMetadata {
  readonly name: string | null;
  readonly descriptor: string | null;
  readonly state: MethodDebugState;
  readonly hasCode: boolean;
  readonly lineNumbers: DebugTable<LineNumberEntry>;
  readonly localVariables: DebugTable<LocalVariableEntry>;
  readonly localVariableTypes: DebugTable<LocalVariableTypeEntry>;
  /**
   * Slots that appear in more than one `LocalVariableTable` entry. Reuse is
   * legal and does not imply error, but a reused slot may denote different
   * variables across disjoint scope ranges, so it is surfaced, not collapsed.
   */
  readonly reusedSlots: readonly number[];
}

export interface ClassDebugMetadata {
  readonly sourceFile: {
    readonly presence: AttributePresence;
    readonly name: string | null;
  };
  readonly sourceDebugExtension: {
    readonly presence: AttributePresence;
    /** Byte length of the opaque extension; the bytes themselves are never interpreted here. */
    readonly byteLength: number;
  };
  readonly methods: readonly MethodDebugMetadata[];
}

type NamedAttribute = {
  readonly name: string | null;
  readonly info: Uint8Array;
};

/** First matching attribute's info. For names JVMS permits at most once (Code, SourceFile, SourceDebugExtension). */
const findAttribute = (
  attributes: readonly NamedAttribute[],
  name: string,
): Uint8Array | null => attributes.find((a) => a.name === name)?.info ?? null;

/**
 * Every matching attribute's info, in order. JVMS §4.7.12–14 permit multiple
 * LineNumberTable / LocalVariableTable / LocalVariableTypeTable attributes in
 * one Code attribute; the full table is their union.
 */
const collectAttributes = (
  attributes: readonly NamedAttribute[],
  name: string,
): readonly Uint8Array[] =>
  attributes.filter((a) => a.name === name).map((a) => a.info);

/**
 * Decode a fixed-stride table, merging every occurrence of a repeatable
 * attribute into one table. Reads up to each occurrence's self-declared count,
 * stopping early if its buffer runs short; a short read or trailing bytes mark
 * the whole table `malformed` while keeping every entry decoded before it.
 */
const decodeTable = <T>(
  infos: readonly Uint8Array[],
  stride: number,
  decodeEntry: (cursor: ByteCursor) => T,
): DebugTable<T> => {
  if (infos.length === 0)
    return { presence: "absent", declaredCount: 0, entries: [] };
  const entries: T[] = [];
  let declaredCount = 0;
  let malformed = false;
  for (const info of infos) {
    const cursor = new ByteCursor(info);
    const countResult = cursor.u2();
    if (!countResult.ok) {
      malformed = true;
      continue;
    }
    declaredCount += countResult.value;
    let short = false;
    for (let i = 0; i < countResult.value; i += 1) {
      if (cursor.remaining < stride) {
        short = true;
        break;
      }
      entries.push(decodeEntry(cursor));
    }
    // A short read, or trailing bytes past the declared entries, is malformed
    // rather than silently ignored (JVMS fixes attribute_length exactly).
    if (short || cursor.remaining !== 0) malformed = true;
  }
  return {
    presence: malformed ? "malformed" : "present",
    declaredCount,
    entries,
  };
};

const u2 = (cursor: ByteCursor): number => {
  const result = cursor.u2();
  // Guarded by the `remaining >= stride` check in decodeTable before each entry.
  return result.ok ? result.value : 0;
};

const decodeLineNumberTable = (
  infos: readonly Uint8Array[],
): DebugTable<LineNumberEntry> =>
  decodeTable(infos, 4, (cursor) => ({
    startPc: u2(cursor),
    lineNumber: u2(cursor),
  }));

const decodeLocalVariableTable = (
  infos: readonly Uint8Array[],
  pool: readonly ConstantPoolEntry[],
): DebugTable<LocalVariableEntry> =>
  decodeTable(infos, 10, (cursor) => {
    const startPc = u2(cursor);
    const length = u2(cursor);
    const nameIndex = u2(cursor);
    const descriptorIndex = u2(cursor);
    const slot = u2(cursor);
    return {
      startPc,
      length,
      nameIndex,
      name: resolveConstantUtf8(pool, nameIndex),
      descriptorIndex,
      descriptor: resolveConstantUtf8(pool, descriptorIndex),
      slot,
    };
  });

const decodeLocalVariableTypeTable = (
  infos: readonly Uint8Array[],
  pool: readonly ConstantPoolEntry[],
): DebugTable<LocalVariableTypeEntry> =>
  decodeTable(infos, 10, (cursor) => {
    const startPc = u2(cursor);
    const length = u2(cursor);
    const nameIndex = u2(cursor);
    const signatureIndex = u2(cursor);
    const slot = u2(cursor);
    return {
      startPc,
      length,
      nameIndex,
      name: resolveConstantUtf8(pool, nameIndex),
      signatureIndex,
      signature: resolveConstantUtf8(pool, signatureIndex),
      slot,
    };
  });

/** Advance a cursor past the fixed Code header and exception table to its sub-attributes. */
const seekCodeSubAttributes = (code: Uint8Array): ByteCursor | null => {
  const cursor = new ByteCursor(code);
  if (!cursor.u2().ok) return null; // max_stack
  if (!cursor.u2().ok) return null; // max_locals
  const codeLength = cursor.u4();
  if (!codeLength.ok || !cursor.slice(codeLength.value).ok) return null;
  const exceptionTableLength = cursor.u2();
  if (
    !exceptionTableLength.ok ||
    !cursor.slice(exceptionTableLength.value * 8).ok
  )
    return null;
  return cursor;
};

const computeReusedSlots = (
  entries: readonly LocalVariableEntry[],
): number[] => {
  const counts = new Map<number, number>();
  for (const entry of entries)
    counts.set(entry.slot, (counts.get(entry.slot) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([slot]) => slot)
    .sort((a, b) => a - b);
};

const classifyMethod = (
  hasCode: boolean,
  lineNumbers: DebugTable<LineNumberEntry>,
  localVariables: DebugTable<LocalVariableEntry>,
  localVariableTypes: DebugTable<LocalVariableTypeEntry>,
): MethodDebugState => {
  if (!hasCode) return "not-applicable";
  if (
    lineNumbers.presence === "malformed" ||
    localVariables.presence === "malformed" ||
    localVariableTypes.presence === "malformed"
  ) {
    return "malformed";
  }
  const hasLine = lineNumbers.presence === "present";
  const hasLocals = localVariables.presence === "present";
  if (hasLine && hasLocals) return "present";
  if (!hasLine && !hasLocals) return "stripped";
  return "partial";
};

/** Decode one method's debug tables from its `Code` attribute, if any. */
export const decodeMethodDebugMetadata = (
  method: JavaMember,
  pool: readonly ConstantPoolEntry[],
): MethodDebugMetadata => {
  const code = findAttribute(method.attributes, "Code");
  const absentTable = <T>(): DebugTable<T> => ({
    presence: "absent",
    declaredCount: 0,
    entries: [],
  });
  if (code === null) {
    return {
      name: method.name,
      descriptor: method.descriptor,
      state: "not-applicable",
      hasCode: false,
      lineNumbers: absentTable(),
      localVariables: absentTable(),
      localVariableTypes: absentTable(),
      reusedSlots: [],
    };
  }

  const subCursor = seekCodeSubAttributes(code);
  const subAttrs = subCursor ? parseAttributes(subCursor, pool) : null;
  const attributes = subAttrs && subAttrs.ok ? subAttrs.value : [];
  const codeMalformed =
    subCursor === null || (subAttrs !== null && !subAttrs.ok);

  const lineNumbers = decodeLineNumberTable(
    collectAttributes(attributes, "LineNumberTable"),
  );
  const localVariables = decodeLocalVariableTable(
    collectAttributes(attributes, "LocalVariableTable"),
    pool,
  );
  const localVariableTypes = decodeLocalVariableTypeTable(
    collectAttributes(attributes, "LocalVariableTypeTable"),
    pool,
  );

  const state = codeMalformed
    ? "malformed"
    : classifyMethod(true, lineNumbers, localVariables, localVariableTypes);

  return {
    name: method.name,
    descriptor: method.descriptor,
    state,
    hasCode: true,
    lineNumbers,
    localVariables,
    localVariableTypes,
    reusedSlots: computeReusedSlots(localVariables.entries),
  };
};

/** Decode class-level debug attributes and every method's debug tables. */
export const decodeClassDebugMetadata = (
  cls: JavaClassFile,
): ClassDebugMetadata => {
  const sourceFileInfo = findAttribute(cls.attributes, "SourceFile");
  let sourceFile: ClassDebugMetadata["sourceFile"] = {
    presence: "absent",
    name: null,
  };
  if (sourceFileInfo !== null) {
    const cursor = new ByteCursor(sourceFileInfo);
    const indexResult = cursor.u2();
    sourceFile = indexResult.ok
      ? {
          presence: "present",
          name: resolveConstantUtf8(cls.constantPool, indexResult.value),
        }
      : { presence: "malformed", name: null };
  }

  const sdeInfo = findAttribute(cls.attributes, "SourceDebugExtension");
  const sourceDebugExtension: ClassDebugMetadata["sourceDebugExtension"] =
    sdeInfo === null
      ? { presence: "absent", byteLength: 0 }
      : { presence: "present", byteLength: sdeInfo.length };

  return {
    sourceFile,
    sourceDebugExtension,
    methods: cls.methods.map((method) =>
      decodeMethodDebugMetadata(method, cls.constantPool),
    ),
  };
};
