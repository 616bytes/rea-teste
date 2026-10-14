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
      "Case-insensitive literal text search; every whitespace-separated term must occur in the record's normalized result or limitations",
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
 * Match every term against string leaves of the record's result and
 * limitations, reporting the first leaf containing the first term.
 */
const matchQuery = (
  evidence: Evidence,
  terms: readonly string[],
): QueryMatch | undefined => {
  const pending = new Set(terms);
  let first: QueryMatch | undefined;
  const stack: [unknown, string][] = [
    [evidence.limitations, "/limitations"],
    [evidence.normalized_result, "/normalized_result"],
  ];
  while (stack.length > 0 && (pending.size > 0 || first === undefined)) {
    const [value, path] = stack.pop()!;
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      for (const term of pending)
        if (lower.includes(term)) pending.delete(term);
      const at = lower.indexOf(terms[0]!);
      if (first === undefined && at !== -1) {
        // Case folding can change length; then offsets refer to the folded text.
        const text = lower.length === value.length ? value : lower;
        const start = Math.max(0, at - SNIPPET_CONTEXT);
        const end = Math.min(
          text.length,
          at + terms[0]!.length + SNIPPET_CONTEXT,
        );
        const prefix = start > 0 ? "…" : "";
        first = {
          path,
          snippet:
            prefix + text.slice(start, end) + (end < text.length ? "…" : ""),
          match_start: prefix.length + at - start,
          match_length: terms[0]!.length,
        };
      }
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--)
        stack.push([value[i], `${path}/${i}`]);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value).reverse())
        stack.push([child, `${path}/${pointerSegment(key)}`]);
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
  const terms = filters.query?.toLowerCase().split(/\s+/).filter(Boolean);
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
