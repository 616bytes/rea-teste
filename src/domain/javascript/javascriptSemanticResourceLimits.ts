import type {
  JavaScriptSemanticResourceLimit,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

/** Maximum distinct alternatives retained in one normalized primitive value. */
export const SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT = 256;
/** Maximum active expression nesting during inert semantic evaluation. */
export const SEMANTIC_EXPRESSION_DEPTH_LIMIT = 256;
/** Distinct getter, receiver and path states retained in one precise query. */
export const SEMANTIC_GETTER_EXPANSION_LIMIT = 512;
/** Distinct expression/path candidates admitted while resolving one call
 * target's returned references. */
export const SEMANTIC_RETURNED_REFERENCE_EXPANSION_LIMIT = 16384;
/** Distinct projection-path links created while resolving one call target's
 * returned references. One candidate can prepend a long member chain, so
 * links are budgeted independently of candidates. */
export const SEMANTIC_RETURNED_REFERENCE_PATH_LINK_LIMIT = 262144;
/** Distinct cycle-blocker entries retained while resolving one call target's
 * returned references. */
export const SEMANTIC_RETURNED_REFERENCE_BLOCKER_LIMIT = 262144;
/** Largest cached blocker context per completed expansion. Richer expansions
 * stay uncached; re-expansion is bounded by the candidate reserve. */
export const SEMANTIC_RETURNED_REFERENCE_BLOCKER_CONTEXT_LIMIT = 1024;
/** Bound normalized strings and transient keys independently of transport limits. */
export const SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT = 1_048_576;

const RESOURCE_LIMIT_REASON: Record<JavaScriptSemanticResourceLimit, string> = {
  "primitive-candidates":
    "Primitive candidate budget exceeded (maximum 256 alternatives).",
  "primitive-bytes":
    "Primitive string-byte budget exceeded (maximum 1048576 estimated JSON bytes).",
  "expression-depth":
    "Semantic expression depth budget exceeded (maximum 256 nested expressions).",
  "getter-expansion":
    "Getter expansion was conservatively bounded (maximum 512 distinct states or a growing receiver cycle).",
  "returned-reference-expansion":
    "Returned-reference expansion was conservatively bounded (maximum 16384 distinct expression/path states for one call target).",
  "returned-reference-path-links":
    "Returned-reference expansion was conservatively bounded (maximum 262144 distinct projection-path links for one call target).",
  "returned-reference-blockers":
    "Returned-reference expansion was conservatively bounded (maximum 262144 cycle-blocker entries for one call target).",
};

/** Check UTF-16 length against worst-case JSON escaping without flattening. */
const jsonStringBytesFromLength = (codeUnits: number): number =>
  codeUnits * 6 + 2;

/** Bound string payload before JSON key serialization or candidate creation. */
export const exceedsSemanticPrimitiveStringByteBudget = (
  strings: Iterable<string>,
): boolean => {
  let total = 0;
  for (const value of strings) {
    total += jsonStringBytesFromLength(value.length);
    if (total > SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT) return true;
  }
  return false;
};

/** Bound all outputs of a primitive addition before concatenating any. */
export const exceedsSemanticPrimitiveAdditionByteBudget = (
  left: readonly (string | number | boolean | null)[],
  right: readonly (string | number | boolean | null)[],
): boolean => {
  let total = 0;
  for (const leftValue of left) {
    for (const rightValue of right) {
      if (typeof leftValue !== "string" && typeof rightValue !== "string")
        continue;
      const length = String(leftValue).length + String(rightValue).length;
      total += jsonStringBytesFromLength(length);
      if (total > SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT) return true;
    }
  }
  return false;
};

/** Bound template interpolation outputs before creating concatenated strings. */
export const exceedsSemanticTemplateByteBudget = (
  prefixes: readonly string[],
  suffixes: readonly string[],
): boolean => {
  let total = 0;
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      total += jsonStringBytesFromLength(prefix.length + suffix.length);
      if (total > SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT) return true;
    }
  }
  return false;
};

/** Make an explicit unknown value tagged with the semantic resource bound. */
export const semanticResourceLimitUnknown = (
  resourceLimit: JavaScriptSemanticResourceLimit,
): JavaScriptSemanticValue => ({
  status: "unknown",
  reason: RESOURCE_LIMIT_REASON[resourceLimit],
  resourceLimit,
});

/** Display label for one stable resource classification. */
export const semanticResourceLimitReason = (
  resourceLimit: JavaScriptSemanticResourceLimit,
): string => RESOURCE_LIMIT_REASON[resourceLimit];
