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
 * Decode literal module/nominal prefixes, stopping at supported substituted
 * extension contexts. Unsupported tails retain the nominal prefix category;
 * this is deliberately not full mangling validation or extension decoding.
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
        if (
          category !== null &&
          isSubstitutedExtensionContext(mangling, cursor, substitutions)
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

/**
 * Recognize only module + [supported generic signature] + E, at token
 * boundaries. See Swift ABI Mangling.rst: Declaration Contexts and Generics.
 * Witness bodies and global wrappers are intentionally never inspected.
 */
const isSubstitutedExtensionContext = (
  mangling: string,
  cursor: SubstitutionCursor,
  substitutions: readonly ("identifier" | "nominal")[],
): boolean => {
  const module = readSubstitution(mangling, cursor);
  if (module === undefined || substitutions[module] !== "identifier")
    return false;
  const atBoundary = () => cursor.remaining === 0 && !cursor.continuing;
  if (atBoundary() && mangling.charAt(cursor.offset) === "E") return true;
  for (;;) {
    if (atBoundary()) {
      // Single-parameter and explicit parameter-count signature terminators.
      if (mangling.charAt(cursor.offset) === "l")
        return mangling.charAt(cursor.offset + 1) === "E";
      if (mangling.charAt(cursor.offset) === "r") {
        cursor.offset++;
        while (mangling.charAt(cursor.offset) !== "l") {
          if (mangling.charAt(cursor.offset) === "z") cursor.offset++;
          else {
            const end = indexEnd(mangling, cursor.offset);
            if (end === undefined) return false;
            cursor.offset = end;
          }
        }
        return mangling.charAt(cursor.offset + 1) === "E";
      }
      if (mangling.startsWith("Ri", cursor.offset)) {
        const end = indexEnd(mangling, cursor.offset + 2);
        if (end === undefined) return false;
        cursor.offset = end;
      } else if (mangling.startsWith("SQR", cursor.offset)) {
        // SQ is the standard Equatable protocol substitution.
        cursor.offset += 3;
      } else if (!readProtocolRequirement(mangling, cursor, substitutions))
        return false;
    } else if (!readProtocolRequirement(mangling, cursor, substitutions))
      return false;
    const end = genericParamIndexEnd(mangling, cursor.offset);
    if (end === undefined) return false;
    cursor.offset = end;
  }
};

/** Only a module identifier/reference and literal protocol name followed by R. */
const readProtocolRequirement = (
  mangling: string,
  cursor: SubstitutionCursor,
  substitutions: readonly ("identifier" | "nominal")[],
): boolean => {
  if (
    cursor.remaining !== 0 ||
    cursor.continuing ||
    mangling.charAt(cursor.offset) === "A"
  ) {
    const module = readSubstitution(mangling, cursor);
    if (module === undefined || substitutions[module] !== "identifier")
      return false;
  } else {
    const end = identifierEnd(mangling, cursor.offset);
    if (end === undefined) return false;
    cursor.offset = end;
  }
  if (cursor.remaining !== 0 || cursor.continuing) return false;
  const end = identifierEnd(mangling, cursor.offset);
  if (end === undefined || mangling.charAt(end) !== "R") return false;
  cursor.offset = end + 1;
  return true;
};

// Swift's demangleIndex accepts decimal digits (including 0) then underscore.
const indexEnd = (mangling: string, offset: number): number | undefined => {
  const token = /^(?:[0-9]+)?_/u.exec(mangling.slice(offset))?.[0];
  if (token === undefined || Number(token.slice(0, -1)) >= 0x7fffffff)
    return undefined;
  return offset + token.length;
};

const genericParamIndexEnd = (
  mangling: string,
  offset: number,
): number | undefined => {
  const kind = mangling.charAt(offset);
  if (kind === "z" || kind === "s") return offset + 1;
  if (kind !== "d") return indexEnd(mangling, offset);
  const depthEnd = indexEnd(mangling, offset + 1);
  return depthEnd === undefined ? undefined : indexEnd(mangling, depthEnd);
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
