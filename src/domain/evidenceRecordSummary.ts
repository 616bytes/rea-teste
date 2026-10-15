import { z } from "zod";

import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { evidenceSchema, type Evidence } from "./evidence.js";
import type { EvidenceBundle } from "./evidenceBundle.js";

/** Exact retained-record selectors; selection never resolves a provider address. */
export const evidenceRecordFiltersSchema = z.strictObject({
  evidence_id: prefixedDigestSchema("ev").optional(),
  operation: z.string().min(1).optional(),
  target_sha256: digestSchema.optional(),
  analysis_profile_digest: digestSchema.optional(),
  procedure_address: z.string().min(1).optional(),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Case-insensitive literal text search; every whitespace-separated term must occur in some string of the record's normalized result or limitations (terms may match different strings)",
    ),
});
export type EvidenceRecordFilters = z.infer<typeof evidenceRecordFiltersSchema>;

const countSchema = z.number().int().nonnegative();
const nativeMetadataSchema = z.object({
  procedure: z.object({ address: z.string(), name: z.string().nullish() }),
  native_value_flow: z.unknown().optional(),
});
const valueFlowMetadataSchema = z.union([
  z.object({
    available: z.literal(true),
    truncated: z.boolean(),
    omitted_operations_lower_bound: countSchema.optional(),
    known_omitted_inputs: countSchema.optional(),
    known_omitted_edges: countSchema.optional(),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);

const nativeSummarySchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    procedure_address: z.string(),
    procedure_name: z.string().nullable(),
    value_flow: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("observed"),
        truncated: z.boolean(),
        omitted_operations_lower_bound: countSchema.nullable(),
        known_omitted_inputs: countSchema.nullable(),
        known_omitted_edges: countSchema.nullable(),
      }),
      z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
      z.strictObject({ status: z.literal("not-recorded") }),
      z.strictObject({ status: z.literal("unknown"), reason: z.string() }),
    ]),
  }),
  z.strictObject({
    available: z.literal(false),
    reason: z.enum(["different-operation", "not-recorded-or-incompatible"]),
  }),
]);

/** Metadata for complete retained records, independent of analysis completeness. */
export const evidenceBundleSummarySchema = z.strictObject({
  kind: z.literal("evidence-bundle-summary"),
  filters: z.record(z.string(), z.string()),
  total_retained_records: countSchema,
  matching_records: countSchema,
  unknown_revisions: countSchema,
  records: z.array(
    z.strictObject({
      evidence_id: evidenceSchema.shape.evidence_id,
      subject: evidenceSchema.shape.subject,
      provider: evidenceSchema.shape.provider,
      operation: evidenceSchema.shape.operation,
      confidence: evidenceSchema.shape.confidence,
      authority: evidenceSchema.shape.authority,
      analysis_profile_digest: digestSchema.nullable(),
      retention: z.literal("complete-record"),
      limitation_count: countSchema,
      native_dossier: nativeSummarySchema,
      query_match: z
        .strictObject({
          path: z.string(),
          snippet: z.string(),
          match_start: countSchema,
          match_length: countSchema,
          offset_units: z.literal("utf16-code-units"),
        })
        .nullable(),
    }),
  ),
});
export type EvidenceBundleSummary = z.infer<typeof evidenceBundleSummarySchema>;

const nativeSummary = (
  evidence: Evidence,
): z.infer<typeof nativeSummarySchema> => {
  if (evidence.operation !== "analyze_function")
    return { available: false, reason: "different-operation" };
  // Read only producer metadata. Parsing the full dossier would allocate every
  // large collection merely to discover its already authenticated parent ID.
  const parsed = nativeMetadataSchema.safeParse(evidence.normalized_result);
  if (!parsed.success)
    return { available: false, reason: "not-recorded-or-incompatible" };
  const flow = valueFlowMetadataSchema.safeParse(parsed.data.native_value_flow);
  return {
    available: true,
    procedure_address: parsed.data.procedure.address,
    procedure_name: parsed.data.procedure.name ?? null,
    value_flow:
      parsed.data.native_value_flow == null
        ? { status: "not-recorded" }
        : !flow.success
          ? {
              status: "unknown",
              reason: "Value-flow metadata has an incompatible representation.",
            }
          : flow.data.available
            ? {
                status: "observed",
                truncated: flow.data.truncated,
                omitted_operations_lower_bound:
                  flow.data.omitted_operations_lower_bound ?? null,
                known_omitted_inputs: flow.data.known_omitted_inputs ?? null,
                known_omitted_edges: flow.data.known_omitted_edges ?? null,
              }
            : { status: "unavailable", reason: flow.data.reason },
  };
};

type QueryMatch = NonNullable<
  EvidenceBundleSummary["records"][number]["query_match"]
>;

const SNIPPET_CONTEXT = 30;

const pointerSegment = (key: string | number): string =>
  String(key).replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Lowercase each code point independently, so a character folds the same way
 * in a query and in retained text (no context-dependent final sigma). `source`
 * maps every folded UTF-16 unit back to its source code point's offset.
 */
export const foldCase = (
  text: string,
): { readonly folded: string; readonly source: readonly number[] } => {
  let folded = "";
  const source: number[] = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const lower = char.toLowerCase();
    folded += lower;
    for (let unit = 0; unit < lower.length; unit++) source.push(i);
    i += char.length;
  }
  return { folded, source };
};

const isLowSurrogate = (text: string, index: number): boolean => {
  const unit = text.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
};

/** Excerpt the original text around a folded match without splitting a code point. */
const snippetAt = (
  text: string,
  source: readonly number[],
  foldedStart: number,
  foldedLength: number,
): Omit<QueryMatch, "path"> => {
  const matchStart = source[foldedStart]!;
  const last = source[foldedStart + foldedLength - 1]!;
  const matchEnd = last + String.fromCodePoint(text.codePointAt(last)!).length;
  let start = Math.max(0, matchStart - SNIPPET_CONTEXT);
  if (isLowSurrogate(text, start)) start--;
  let end = Math.min(text.length, matchEnd + SNIPPET_CONTEXT);
  if (end < text.length && isLowSurrogate(text, end)) end++;
  const prefix = start > 0 ? "…" : "";
  return {
    snippet: prefix + text.slice(start, end) + (end < text.length ? "…" : ""),
    match_start: prefix.length + matchStart - start,
    match_length: matchEnd - matchStart,
    offset_units: "utf16-code-units",
  };
};

type Frame = {
  readonly path: string;
  readonly container: readonly unknown[] | Readonly<Record<string, unknown>>;
  readonly keys: readonly string[] | undefined;
  index: number;
};

/**
 * Match every folded term against string leaves of the record's result and
 * limitations, reporting the first leaf containing the first term. Containers
 * are walked by index so wide arrays are never copied onto the stack.
 */
const matchQuery = (
  evidence: Evidence,
  terms: readonly string[],
): QueryMatch | undefined => {
  const pending = new Set(terms);
  let first: QueryMatch | undefined;
  const visit = (value: unknown, path: string): Frame | undefined => {
    if (typeof value === "string") {
      const { folded, source } = foldCase(value);
      for (const term of pending)
        if (folded.includes(term)) pending.delete(term);
      const at = first === undefined ? folded.indexOf(terms[0]!) : -1;
      if (at !== -1)
        first = { path, ...snippetAt(value, source, at, terms[0]!.length) };
      return undefined;
    }
    if (Array.isArray(value))
      return { path, container: value, keys: undefined, index: 0 };
    if (value !== null && typeof value === "object")
      return {
        path,
        container: value as Record<string, unknown>,
        keys: Object.keys(value),
        index: 0,
      };
    return undefined;
  };
  const roots: readonly [unknown, string][] = [
    [evidence.normalized_result, "/normalized_result"],
    [evidence.limitations, "/limitations"],
  ];
  for (const [root, rootPath] of roots) {
    const stack: Frame[] = [];
    const rootFrame = visit(root, rootPath);
    if (rootFrame !== undefined) stack.push(rootFrame);
    while (stack.length > 0 && (pending.size > 0 || first === undefined)) {
      const frame = stack.at(-1)!;
      const size = frame.keys?.length ?? (frame.container as unknown[]).length;
      if (frame.index >= size) {
        stack.pop();
        continue;
      }
      const key = frame.keys?.[frame.index] ?? frame.index;
      frame.index++;
      const child = visit(
        (frame.container as Record<string | number, unknown>)[key],
        `${frame.path}/${pointerSegment(key)}`,
      );
      if (child !== undefined) stack.push(child);
    }
  }
  return pending.size === 0 ? first : undefined;
};

/**
 * Discover retained Evidence; payloads are read only when a text query is
 * selected, and are never copied into the summary beyond a bounded snippet.
 */
export const summarizeEvidenceBundle = (
  bundle: EvidenceBundle,
  filters: EvidenceRecordFilters = {},
): EvidenceBundleSummary => {
  const selectedFilters: Record<string, string> = {};
  for (const [field, value] of Object.entries(filters))
    if (value !== undefined) selectedFilters[field] = value;
  const terms = filters.query
    ?.split(/\s+/)
    .filter(Boolean)
    .map((term) => foldCase(term).folded);
  const records: EvidenceBundleSummary["records"] = [];
  for (const evidence of bundle.records) {
    if (
      (filters.evidence_id !== undefined &&
        filters.evidence_id !== evidence.evidence_id) ||
      (filters.operation !== undefined &&
        filters.operation !== evidence.operation) ||
      (filters.target_sha256 !== undefined &&
        filters.target_sha256 !== evidence.subject?.digest.sha256) ||
      (filters.analysis_profile_digest !== undefined &&
        filters.analysis_profile_digest !== evidence.analysis_profile?.digest)
    )
      continue;
    const native = nativeSummary(evidence);
    if (
      filters.procedure_address !== undefined &&
      (!native.available ||
        filters.procedure_address !== native.procedure_address)
    )
      continue;
    const queryMatch =
      terms === undefined ? undefined : matchQuery(evidence, terms);
    if (terms !== undefined && queryMatch === undefined) continue;
    records.push({
      evidence_id: evidence.evidence_id,
      subject: evidence.subject,
      provider: evidence.provider,
      operation: evidence.operation,
      confidence: evidence.confidence,
      authority: evidence.authority,
      analysis_profile_digest: evidence.analysis_profile?.digest ?? null,
      retention: "complete-record",
      limitation_count: evidence.limitations.length,
      native_dossier: native,
      query_match: queryMatch ?? null,
    });
  }
  return {
    kind: "evidence-bundle-summary",
    filters: selectedFilters,
    total_retained_records: bundle.records.length,
    matching_records: records.length,
    unknown_revisions: bundle.unknowns.length,
    records,
  };
};
