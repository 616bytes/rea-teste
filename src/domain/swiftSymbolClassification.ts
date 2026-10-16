const LEGACY_CATEGORIES = [
  ["_TtC", "classes"],
  ["_TtV", "structs"],
  ["_TtO", "enums"],
  ["_TtP", "protocols"],
  ["_TtE", "extensions"],
] as const;

/** Supported procedure categories derived from Swift symbol encodings. */
export type SwiftTypeCategory = (typeof LEGACY_CATEGORIES)[number][1] | "other";

const NOMINAL_CATEGORIES: ReadonlyMap<string, SwiftTypeCategory> = new Map([
  ["C", "classes"],
  ["V", "structs"],
  ["O", "enums"],
  ["P", "protocols"],
]);

/**
 * Decode literal module/nominal contexts and supported protocol witnesses.
 * Unresolved substitutions and generic contexts remain unknown.
 */
export const classifySwiftSymbol = (
  name: string,
): { readonly category: SwiftTypeCategory | null } | undefined => {
  const prefix = /^_?(?:\$[sS]|_T0)/u.exec(name);
  if (prefix === null) {
    if (!name.includes("_Tt")) return undefined;
    return {
      category:
        LEGACY_CATEGORIES.find(([prefix]) => name.startsWith(prefix))?.[1] ??
        null,
    };
  }
  const mangling = name.slice(prefix[0].length);
  let offset = identifierEnd(mangling, 0);
  if (offset === undefined) return { category: null };
  let category: SwiftTypeCategory | null = null;
  // Swift registers each literal identifier and each constructed nominal type.
  const substitutions: Array<"identifier" | "nominal"> = ["identifier"];
  for (;;) {
    const end = identifierEnd(mangling, offset);
    if (end === undefined) {
      if (mangling.charAt(offset) === "A") {
        const cursor: SubstitutionCursor = {
          offset,
          index: 0,
          remaining: 0,
          continuing: false,
        };
        const first = readSubstitution(mangling, cursor);
        // A module reference can start an extension or protocol context, even
        // when grouped/repeated with later references. Nominal constructor
        // result substitutions must not be mistaken for module contexts.
        // Any retained identifier can serve as a module, not just index zero.
        if (
          first === undefined ||
          substitutions[first] === undefined ||
          (substitutions[first] === "identifier" &&
            (first !== 0 ||
              !isSameModuleWitness(mangling, cursor, substitutions.length)))
        )
          category = null;
      }
      break;
    }
    const kind = mangling.charAt(end);
    const nominal = NOMINAL_CATEGORIES.get(kind);
    if (nominal === undefined) {
      // Current swiftc emits protocol descriptors as `…<Nominal>Mp` without
      // the nominal `P` marker (e.g. `_$s4main7ScoringMp`). Decode that exact
      // suffix; unknown substitution encodings stay unclassified, never guessed.
      if (mangling.slice(end) === "Mp") category = "protocols";
      else if (kind === "E" && category !== null) category = "extensions";
      break;
    }
    category = nominal;
    substitutions.push("identifier", "nominal");
    offset = end + 1;
  }
  return { category };
};

type SubstitutionCursor = {
  offset: number;
  index: number;
  remaining: number;
  continuing: boolean;
};

/** Decode a same-module conformance and its literal protocol requirement. */
const isSameModuleWitness = (
  mangling: string,
  cursor: SubstitutionCursor,
  substitutionCount: number,
): boolean => {
  // Literal identifiers cannot begin while grouped references are pending.
  if (cursor.remaining !== 0 || cursor.continuing) return false;
  let contextIndex = 0;
  let protocolNameIndex = substitutionCount;
  for (;;) {
    const end = identifierEnd(mangling, cursor.offset);
    if (end === undefined) return false;
    if (!NOMINAL_CATEGORIES.has(mangling.charAt(end))) {
      cursor.offset = end;
      break;
    }
    // A nested protocol's enclosing nominal path registers its name and type.
    contextIndex = protocolNameIndex + 1;
    protocolNameIndex += 2;
    cursor.offset = end + 1;
  }
  // Conformance module, requirement's enclosing context, and protocol name
  // must resolve to the identities just decoded, not merely look like `A…P`.
  for (const expected of [0, contextIndex, protocolNameIndex]) {
    if (readSubstitution(mangling, cursor) !== expected) return false;
  }
  if (
    cursor.remaining !== 0 ||
    cursor.continuing ||
    mangling.charAt(cursor.offset) !== "P"
  )
    return false;
  // The conforming nominal depends on the decoded context, not the kind of
  // requirement (function, accessor, initializer, etc.). The entity body is
  // deliberately opaque: this is category classification, not validation.
  return cursor.offset + 1 < mangling.length - 2 && mangling.endsWith("TW");
};

/** Read one reference lazily; repeated groups never allocate expanded arrays. */
const readSubstitution = (
  mangling: string,
  cursor: SubstitutionCursor,
): number | undefined => {
  if (cursor.remaining > 0) {
    cursor.remaining--;
    return cursor.index;
  }
  if (!cursor.continuing && mangling.charAt(cursor.offset++) !== "A")
    return undefined;
  const token = /^(?:([1-9][0-9]*)?([a-zA-Z])|([0-9]+)?_)/u.exec(
    mangling.slice(cursor.offset),
  );
  if (token === null) return undefined;
  const letter = token[2];
  const index =
    letter === undefined
      ? token[3] === undefined
        ? 26
        : Number(token[3]) + 27
      : letter.toUpperCase().charCodeAt(0) - 65;
  const repeat = letter === undefined ? 1 : Number(token[1] ?? 1);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(repeat))
    return undefined;
  cursor.offset += token[0].length;
  cursor.index = index;
  cursor.remaining = repeat - 1;
  cursor.continuing = letter !== undefined && letter !== letter.toUpperCase();
  return index;
};

/**
 * Prefixes accepted by Swift's demangler as manglings. This is deliberately
 * narrower than visible Swift runtime class names (`_Tt…`): those names are
 * useful metadata symbols but are not themselves demangler manglings.
 */
const SWIFT_MANGLING_PREFIXES = [
  "_T0",
  "$S",
  "_$S",
  "$s",
  "_$s",
  "@__swiftmacro_",
  "$e",
  "_$e",
] as const;

/** Recognize names the Swift demangler accepts as mangled symbols. */
export const isSwiftMangledSymbolName = (name: string): boolean =>
  SWIFT_MANGLING_PREFIXES.some((prefix) => name.startsWith(prefix));

const identifierEnd = (
  mangling: string,
  offset: number,
): number | undefined => {
  const lengthToken = /^[1-9][0-9]*/u.exec(mangling.slice(offset))?.[0];
  if (lengthToken === undefined) return undefined;
  const start = offset + lengthToken.length;
  const end = start + Number(lengthToken);
  // Swift identifiers with substitutions/punycode need a fuller decoder.
  if (
    !Number.isSafeInteger(end) ||
    end > mangling.length ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(mangling.slice(start, end))
  )
    return undefined;
  return end;
};
