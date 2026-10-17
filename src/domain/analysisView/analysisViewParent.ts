import type { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisViewParent } from "./analysisView.js";

/**
 * The exact source object a validated interpretation may be reused for.
 *
 * `sealedResult` alone is a caller-supplied hint. Only the realm-private
 * snapshot proof registered by `freezeJsonSnapshot` establishes that the value
 * cannot change, so mutable, merely frozen, or forged input returns `undefined`
 * and is validated on every call.
 */
export const reusableAnalysisViewSource = (
  parent: AnalysisViewParent,
): object | undefined =>
  parent.sealedResult === true &&
  typeof parent.normalizedResult === "object" &&
  parent.normalizedResult !== null &&
  isImmutableJsonSnapshot(parent.normalizedResult)
    ? parent.normalizedResult
    : undefined;

/**
 * Complete successful interpretations, keyed by sealed source and format owner.
 *
 * The key is weak, so an entry is released with the Evidence source that owns
 * it. The value is weakly held as well: memory pressure may reclaim it, and a
 * reclaimed entry costs one re-parse rather than returning a stale result. A
 * rejected parse is never remembered, and an abandoned parse never publishes.
 */
const sealedInterpretations = new WeakMap<
  object,
  Map<object, WeakRef<object>>
>();

const cachedInterpretation = <Value extends object>(
  source: object,
  owner: object,
): Value | undefined =>
  sealedInterpretations.get(source)?.get(owner)?.deref() as Value | undefined;

const rememberInterpretation = (
  source: object,
  owner: object,
  value: object,
): void => {
  let byOwner = sealedInterpretations.get(source);
  if (byOwner === undefined) {
    byOwner = new Map();
    sealedInterpretations.set(source, byOwner);
  }
  byOwner.set(owner, new WeakRef(value));
};

/**
 * Reuse one complete interpretation of a sealed source, or parse and remember it.
 *
 * `owner` is the stable format-owning value for the interpretation, so two
 * operations over the same source cannot read each other's result. Only object
 * results are remembered; a scalar interpretation carries no reusable work.
 */
export const sealedAnalysisViewInterpretation = <Value>(
  parent: AnalysisViewParent,
  owner: object,
  parse: () => Result<Value, AnalysisError>,
): Result<Value, AnalysisError> => {
  const source = reusableAnalysisViewSource(parent);
  if (source !== undefined) {
    const cached = cachedInterpretation<object>(source, owner);
    if (cached !== undefined) return ok(cached as Value);
  }
  const parsed = parse();
  if (
    parsed.ok &&
    source !== undefined &&
    typeof parsed.value === "object" &&
    parsed.value !== null
  )
    rememberInterpretation(source, owner, parsed.value);
  return parsed;
};

/** Parse a parent's result with its owning schema; issues point into the view source. */
export const parseAnalysisViewResult = <Schema extends z.ZodType>(
  schema: Schema,
  parent: AnalysisViewParent,
): Result<z.output<Schema>, AnalysisError> =>
  sealedAnalysisViewInterpretation(parent, schema, () => {
    const parsed = schema.safeParse(parent.normalizedResult);
    if (parsed.success) return ok(parsed.data);
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  });
