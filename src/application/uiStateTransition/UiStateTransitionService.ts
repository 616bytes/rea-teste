import { z } from "zod";

import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import { UI_STATE_TRANSITION_PROVIDER } from "../InvestigationProviders.js";
import {
  uiStateTransitionInputSchema,
  type UiStateTransitionInput,
} from "../../contracts/uiStateTransitionToolContracts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  projectUiStateTransition,
  type UiStateTransitionRelatedEvidence,
} from "../../domain/uiStateTransition.js";
import { webObservationSessionSchema } from "../../domain/browserSession.js";
import { webPageInspectionSchema } from "../../domain/browserObservationSchemas.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";

const OPERATION = "derive_ui_state_transition";

/** A derived transition together with the exact resolved Evidence it cites. */
export interface UiStateTransitionDerivation {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

const inputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError => new AnalysisInputError(OPERATION, undefined, issues);

/** Resolve, authenticate, and retain the exact caller-selected Evidence source. */
const resolveEvidence = (
  input: UiStateTransitionInput["before"],
  lookup: EvidenceLookup | undefined,
  path: string,
): Result<Evidence, AnalysisError> => {
  const resolved = resolveEvidenceInput(input, lookup);
  if (!resolved.ok) return resolved;
  try {
    return ok(parseEvidence(resolved.value));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(
        analysisInputErrorFromIssues(
          OPERATION,
          cause.issues.map((issue) => ({
            ...issue,
            path: [path, ...issue.path],
          })),
          { [path]: input },
          { cause },
        ),
      );
    if (cause instanceof TypeError)
      return err(
        new EvidenceIntegrityError(
          cause.message,
          cause.message.length > 0 ? { userMessage: cause.message } : undefined,
        ),
      );
    throw cause;
  }
};

const pageObservation = (
  evidence: Evidence,
  path: string,
): Result<
  {
    readonly evidenceId: string;
    readonly inspection: z.output<typeof webPageInspectionSchema>;
  },
  AnalysisError
> => {
  if (
    evidence.operation !== "inspect_web_page" ||
    evidence.predicate_type !== "rea.web-page-inspection"
  )
    return err(
      inputError([
        {
          path: [path],
          reason: "invalid_value",
          message:
            "Expected inspect_web_page Evidence. Capture the selected browser page before and after the caller action.",
        },
      ]),
    );
  const parsed = webPageInspectionSchema.safeParse(evidence.normalized_result);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        OPERATION,
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: [path, "normalized_result", ...issue.path],
        })),
        { [path]: evidence },
        { cause: parsed.error },
      ),
    );
  return ok({ evidenceId: evidence.evidence_id, inspection: parsed.data });
};

const sessionObservation = (
  evidence: Evidence,
): Result<
  {
    readonly evidenceId: string;
    readonly observation: z.output<typeof webObservationSessionSchema>;
  },
  AnalysisError
> => {
  if (
    evidence.operation !== "observe_web_session" ||
    evidence.predicate_type !== "rea.web-observation-session"
  )
    return err(
      inputError([
        {
          path: ["session"],
          reason: "invalid_value",
          message:
            "Expected observe_web_session Evidence for the optional bounded event window.",
        },
      ]),
    );
  const parsed = webObservationSessionSchema.safeParse(
    evidence.normalized_result,
  );
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        OPERATION,
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["session", "normalized_result", ...issue.path],
        })),
        { session: evidence },
        { cause: parsed.error },
      ),
    );
  return ok({ evidenceId: evidence.evidence_id, observation: parsed.data });
};

const relatedEvidence = (
  evidence: Evidence,
): UiStateTransitionRelatedEvidence => ({
  evidenceId: evidence.evidence_id,
  operation: evidence.operation,
  authority: evidence.authority,
  confidence: evidence.confidence,
});

const deriveUiStateTransitionFromInput = <T>(
  rawInput: unknown,
  lookup: EvidenceLookup | undefined,
  options: ExecutionOptions,
  derive: (
    input: UiStateTransitionInput,
    lookup?: EvidenceLookup,
  ) => Result<T, AnalysisError>,
): Result<T, AnalysisError> => {
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));
  const parsed = uiStateTransitionInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
        cause: parsed.error,
      }),
    );
  const result = derive(parsed.data, lookup);
  return result.ok && options.signal?.aborted
    ? err(new AnalysisCancelledError(OPERATION))
    : result;
};

/** Derive one read-only UI state pair from completed browser Evidence. */
export const deriveUiStateTransition = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: ExecutionOptions = {},
): Result<Evidence, AnalysisError> =>
  deriveUiStateTransitionFromInput(
    rawInput,
    lookup,
    options,
    deriveUiStateTransitionValidated,
  );

/** Resolve one transition and retain its exact source records for a session adapter. */
export const deriveUiStateTransitionWithSources = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: ExecutionOptions = {},
): Result<UiStateTransitionDerivation, AnalysisError> =>
  deriveUiStateTransitionFromInput(
    rawInput,
    lookup,
    options,
    deriveUiStateTransitionValidatedWithSources,
  );

/** Execute the pure projection after the public contract owns input parsing. */
export const deriveUiStateTransitionValidated = (
  input: UiStateTransitionInput,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const result = deriveUiStateTransitionValidatedWithSources(input, lookup);
  return result.ok ? ok(result.value.evidence) : err(result.error);
};

/** Execute one validated projection and preserve its resolved source records. */
export const deriveUiStateTransitionValidatedWithSources = (
  input: UiStateTransitionInput,
  lookup?: EvidenceLookup,
): Result<UiStateTransitionDerivation, AnalysisError> => {
  const beforeEvidence = resolveEvidence(input.before, lookup, "before");
  if (!beforeEvidence.ok) return beforeEvidence;
  const afterEvidence = resolveEvidence(input.after, lookup, "after");
  if (!afterEvidence.ok) return afterEvidence;
  const before = pageObservation(beforeEvidence.value, "before");
  if (!before.ok) return before;
  const after = pageObservation(afterEvidence.value, "after");
  if (!after.ok) return after;
  let session;
  let sessionEvidence: Evidence | undefined;
  if (input.session !== undefined) {
    const resolved = resolveEvidence(input.session, lookup, "session");
    if (!resolved.ok) return resolved;
    sessionEvidence = resolved.value;
    const observed = sessionObservation(resolved.value);
    if (!observed.ok) return observed;
    session = observed.value;
  }
  const related: UiStateTransitionRelatedEvidence[] = [];
  const relatedEvidenceIds: string[] = [];
  const relatedSources: Evidence[] = [];
  for (const [index, source] of input.related_evidence.entries()) {
    const resolved = resolveEvidence(
      source,
      lookup,
      `related_evidence.${String(index)}`,
    );
    if (!resolved.ok) return resolved;
    related.push(relatedEvidence(resolved.value));
    relatedEvidenceIds.push(resolved.value.evidence_id);
    relatedSources.push(resolved.value);
  }
  const result = projectUiStateTransition({
    action: input.action,
    selection: input.selection,
    before: before.value,
    after: after.value,
    ...(session === undefined ? {} : { session }),
    relatedEvidence: related,
  });
  const evidenceLinks = [
    beforeEvidence.value.evidence_id,
    afterEvidence.value.evidence_id,
    ...(sessionEvidence === undefined ? [] : [sessionEvidence.evidence_id]),
    ...relatedEvidenceIds,
  ].sort();
  const evidence = createEvidence(undefined, UI_STATE_TRANSITION_PROVIDER, {
    predicateType: "rea.ui-state-transition",
    operation: OPERATION,
    parameters: {
      action: input.action,
      before_evidence_id: beforeEvidence.value.evidence_id,
      after_evidence_id: afterEvidence.value.evidence_id,
      ...(sessionEvidence === undefined
        ? {}
        : { session_evidence_id: sessionEvidence.evidence_id }),
      related_evidence_ids: [...new Set(relatedEvidenceIds)].sort(),
      selection: input.selection,
    },
    result: jsonValueSchema.parse(result),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: result.limitations,
    evidenceLinks: [...new Set(evidenceLinks)],
  });
  return ok({
    evidence,
    sources: [
      beforeEvidence.value,
      afterEvidence.value,
      ...(sessionEvidence === undefined ? [] : [sessionEvidence]),
      ...relatedSources,
    ],
  });
};
