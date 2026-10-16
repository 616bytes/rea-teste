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
 * Recognize Swift manglings and decode literal module/nominal contexts.
 * Substitutions, generic contexts, and other encodings remain unknown.
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
  let substitutionCount = 1;
  for (;;) {
    const end = identifierEnd(mangling, offset);
    if (end === undefined) {
      // `AA` can introduce an extension module or a protocol's module. Keep
      // the nominal only for a decoded witness context; other continuations
      // remain unknown. Other substitutions may be constructor result types.
      if (
        mangling.startsWith("AA", offset) &&
        !isSameModuleWitness(mangling, offset, substitutionCount)
      )
        category = null;
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
    substitutionCount += 2;
    offset = end + 1;
  }
  return { category };
};

/** Decode a same-module conformance and its literal protocol requirement. */
const isSameModuleWitness = (
  mangling: string,
  offset: number,
  protocolNameIndex: number,
): boolean => {
  const protocolEnd = identifierEnd(mangling, offset + 2);
  if (protocolEnd === undefined) return false;
  // After the literal protocol name: conformance module, requirement module,
  // then the same protocol name. Grouped/repeated substitutions must resolve
  // to those identities, including when the conforming type is nested.
  const contextEnd = substitutionSequenceEnd(mangling, protocolEnd, [
    0,
    0,
    protocolNameIndex,
  ]);
  if (contextEnd === undefined || mangling.charAt(contextEnd) !== "P")
    return false;
  const memberEnd = identifierEnd(mangling, contextEnd + 1);
  // Like literal nominal members, function signatures are opaque here. Decode
  // the context and exact function-witness envelope, not arbitrary suffix text.
  return (
    memberEnd !== undefined &&
    memberEnd < mangling.length - 3 &&
    mangling.endsWith("FTW")
  );
};

/** Consume only the expected substitution references, without expanding runs. */
const substitutionSequenceEnd = (
  mangling: string,
  offset: number,
  expected: readonly number[],
): number | undefined => {
  let matched = 0;
  while (matched < expected.length) {
    if (mangling.charAt(offset++) !== "A") return undefined;
    for (;;) {
      const token = /^(?:([1-9][0-9]*)?([a-zA-Z])|([0-9]+)?_)/u.exec(
        mangling.slice(offset),
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
      if (repeat > expected.length - matched) return undefined;
      for (let count = 0; count < repeat; count++) {
        if (expected[matched++] !== index) return undefined;
      }
      offset += token[0].length;
      if (letter === undefined || letter === letter.toUpperCase()) break;
    }
  }
  return offset;
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
