import { z } from "zod";

import { browserCompletenessSchema } from "./browserCompleteness.js";
import type { WebObservationSession } from "./browserSession.js";
import type { WebPageInspection } from "./browserObservationSchemas.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { prefixedDigestSchema } from "./digests.js";
import { compareWebCaptures } from "./webCaptureDiff.js";
import { webCaptureDiffSchema } from "./webCaptureDiffSchemas.js";

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** An action supplied by the caller, never promoted to an observed event. */
export const uiStateTransitionActionSchema = z.strictObject({
  action_id: z.string().min(1),
  description: z.string().min(1),
  provenance: z.literal("caller-declared"),
  executor: z.literal("external").default("external"),
  outcome: z
    .enum(["completed", "cancelled", "failed", "unknown"])
    .default("unknown"),
  authority: z
    .literal("caller-declared-unverified")
    .default("caller-declared-unverified"),
});

/** Bounded, symmetric page selection for the before and after AX inventories. */
export const uiStateTransitionSelectionSchema = z.strictObject({
  offset: safeInteger.default(0),
  limit: safeInteger.positive().default(64),
});

const uiNodeSchema = z.strictObject({
  node_id: z.string(),
  parent_id: z.string().nullable(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  ignored: z.boolean(),
  states: z.array(
    z.strictObject({
      name: z.string(),
      value: z.union([z.boolean(), z.number(), z.string()]),
    }),
  ),
});

const pageCoverageSchema = z.strictObject({
  status: z.enum(["page", "empty"]),
  examined: safeInteger,
  total: safeInteger,
  next_offset: safeInteger.nullable(),
  exhausted: z.boolean(),
});

const domProjectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("observed"),
    total_nodes: safeInteger,
  }),
  z.strictObject({
    status: z.literal("partial"),
    total_nodes: safeInteger,
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);

const accessibilityProjectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("observed"),
    total_nodes: safeInteger,
    retained_nodes: safeInteger,
    items: z.array(uiNodeSchema),
    coverage: pageCoverageSchema,
  }),
  z.strictObject({
    status: z.literal("partial"),
    total_nodes: safeInteger,
    retained_nodes: safeInteger,
    items: z.array(uiNodeSchema),
    coverage: pageCoverageSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);

const uiStateSchema = z.strictObject({
  state_evidence_id: prefixedDigestSchema("ev"),
  observed_at: z.iso.datetime(),
  target: z.strictObject({
    target_id: z.string().min(1),
    url: z.string(),
    origin: z.string(),
  }),
  source_coverage: browserCompletenessSchema,
  dom: domProjectionSchema,
  accessibility: accessibilityProjectionSchema,
  visibility: z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1),
  }),
});

const targetContinuitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("observed"),
    target_id: z.string().min(1),
    origin: z.string(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);

const sessionProjectionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-supplied") }),
  z.strictObject({
    status: z.literal("observed"),
    evidence_id: prefixedDigestSchema("ev"),
    timeline_event_count: safeInteger,
    end_reason: z.enum([
      "window_elapsed",
      "target_left_scope",
      "target_terminated",
    ]),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    evidence_id: prefixedDigestSchema("ev"),
    reason: z.string().min(1),
  }),
]);

const relatedEvidenceSchema = z.strictObject({
  evidence_id: prefixedDigestSchema("ev"),
  operation: z.string().min(1),
  authority: z.enum([
    "shipped-artifact",
    "controlled-replay",
    "historical-reference",
    "external-service",
    "analyst-inference",
  ]),
  confidence: z.enum(["observed", "derived", "inferred"]),
  relationship: z.literal("caller-linked-uninterpreted"),
});

/** Read-only v1 result for two page observations around a caller action. */
export const uiStateTransitionResultSchema = z.strictObject({
  schema: z.literal("UiStateTransitionEvidence"),
  adapter: z.literal("browser-page-v1"),
  action: uiStateTransitionActionSchema,
  before: uiStateSchema,
  after: uiStateSchema,
  transition: z.strictObject({
    association: z.literal("caller-declared-between-observations"),
    target_continuity: targetContinuitySchema,
    diff: webCaptureDiffSchema,
    session: sessionProjectionSchema,
    related_evidence: z.array(relatedEvidenceSchema),
  }),
  coverage: z.strictObject({
    observed_state_count: z.literal(2),
    same_target_state_pair: z.enum(["observed", "unknown"]),
    unvisited_state_candidates: z.literal("unknown"),
    unreachable_state_candidates: z.literal("unknown"),
  }),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type UiStateTransitionResult = z.infer<
  typeof uiStateTransitionResultSchema
>;

export interface UiStateTransitionObservation {
  readonly evidenceId: string;
  readonly inspection: WebPageInspection;
}

export interface UiStateTransitionSession {
  readonly evidenceId: string;
  readonly observation: WebObservationSession;
}

export interface UiStateTransitionRelatedEvidence {
  readonly evidenceId: string;
  readonly operation: string;
  readonly authority: z.infer<typeof relatedEvidenceSchema>["authority"];
  readonly confidence: z.infer<typeof relatedEvidenceSchema>["confidence"];
}

export interface UiStateTransitionProjectionInput {
  readonly action: z.infer<typeof uiStateTransitionActionSchema>;
  readonly selection: z.infer<typeof uiStateTransitionSelectionSchema>;
  readonly before: UiStateTransitionObservation;
  readonly after: UiStateTransitionObservation;
  readonly session?: UiStateTransitionSession | undefined;
  readonly relatedEvidence: readonly UiStateTransitionRelatedEvidence[];
}

const pageCoverage = (
  offset: number,
  limit: number,
  total: number,
): z.infer<typeof pageCoverageSchema> => {
  const end = Math.min(total, offset + limit);
  const examined = Math.max(0, end - Math.min(offset, total));
  const exhausted = offset >= total || end >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : end,
    exhausted,
  };
};

const sectionStatus = (
  inspection: WebPageInspection,
  section: "dom" | "accessibility",
): "observed" | "partial" | "unknown" => {
  if (inspection.completeness.unavailable_sections.includes(section))
    return "unknown";
  if (inspection.completeness.truncated_sections.includes(section))
    return "partial";
  return "observed";
};

const sectionReason = (
  section: "dom" | "accessibility",
  status: "partial" | "unknown",
): string =>
  status === "partial"
    ? `The retained ${section} observation is truncated; consult the source Evidence coverage.`
    : `The ${section} observation is unavailable in the source Evidence; an empty inventory would be misleading.`;

const projectState = (
  source: UiStateTransitionObservation,
  selection: z.infer<typeof uiStateTransitionSelectionSchema>,
): z.infer<typeof uiStateSchema> => {
  const { inspection } = source;
  const domStatus = sectionStatus(inspection, "dom");
  const dom =
    domStatus === "unknown"
      ? { status: "unknown" as const, reason: sectionReason("dom", domStatus) }
      : domStatus === "partial"
        ? {
            status: "partial" as const,
            total_nodes: inspection.dom.total_nodes,
            reason: sectionReason("dom", domStatus),
          }
        : {
            status: "observed" as const,
            total_nodes: inspection.dom.total_nodes,
          };
  const accessibilityStatus = sectionStatus(inspection, "accessibility");
  const retainedNodes = inspection.accessibility.nodes;
  const page = pageCoverage(
    selection.offset,
    selection.limit,
    retainedNodes.length,
  );
  const items = retainedNodes
    .slice(selection.offset, selection.offset + selection.limit)
    .map(
      ({ node_id, parent_id, role, name, description, ignored, states }) => ({
        node_id,
        parent_id,
        role,
        name,
        description,
        ignored,
        states,
      }),
    );
  const accessibility =
    accessibilityStatus === "unknown"
      ? {
          status: "unknown" as const,
          reason: sectionReason("accessibility", accessibilityStatus),
        }
      : accessibilityStatus === "partial"
        ? {
            status: "partial" as const,
            total_nodes: inspection.accessibility.total_nodes,
            retained_nodes: retainedNodes.length,
            items,
            coverage: page,
            reason: sectionReason("accessibility", accessibilityStatus),
          }
        : {
            status: "observed" as const,
            total_nodes: inspection.accessibility.total_nodes,
            retained_nodes: retainedNodes.length,
            items,
            coverage: page,
          };
  return {
    state_evidence_id: source.evidenceId,
    observed_at: inspection.capture_window.ended_at,
    target: {
      target_id: inspection.target.target_id,
      url: inspection.target.url,
      origin: inspection.target.origin,
    },
    source_coverage: inspection.completeness,
    dom,
    accessibility,
    visibility: {
      status: "unknown",
      reason:
        "DOM and accessibility capture do not prove visibility, occlusion, or clickability on a physical display.",
    },
  };
};

const sameTarget = (
  before: WebPageInspection,
  after: WebPageInspection,
): boolean =>
  before.target.target_id === after.target.target_id &&
  before.target.origin === after.target.origin;

const projectSession = (
  session: UiStateTransitionSession | undefined,
  before: WebPageInspection,
  after: WebPageInspection,
): z.infer<typeof sessionProjectionSchema> => {
  if (session === undefined) return { status: "not-supplied" };
  const targetId = session.observation.target.target_id;
  if (
    targetId !== before.target.target_id ||
    targetId !== after.target.target_id
  )
    return {
      status: "unknown",
      evidence_id: session.evidenceId,
      reason:
        "The supplied observation window has a different CDP target; it cannot be associated with this state pair.",
    };
  return {
    status: "observed",
    evidence_id: session.evidenceId,
    timeline_event_count: session.observation.timeline.length,
    end_reason: session.observation.window.end_reason,
  };
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);

/** Derive a bounded, non-causal UI state pair from existing browser Evidence. */
export const projectUiStateTransition = (
  input: UiStateTransitionProjectionInput,
): UiStateTransitionResult => {
  const before = projectState(input.before, input.selection);
  const after = projectState(input.after, input.selection);
  const same = sameTarget(input.before.inspection, input.after.inspection);
  const diff = compareWebCaptures({
    before: { inspection: input.before.inspection, webmcp: null },
    after: { inspection: input.after.inspection, webmcp: null },
  });
  const targetContinuity = same
    ? {
        status: "observed" as const,
        target_id: before.target.target_id,
        origin: before.target.origin,
      }
    : {
        status: "unknown" as const,
        reason:
          "The before and after observations do not share one CDP target and origin; transition continuity is unknown.",
      };
  const relatedEvidence = input.relatedEvidence
    .map(({ evidenceId, operation, authority, confidence }) => ({
      evidence_id: evidenceId,
      operation,
      authority,
      confidence,
      relationship: "caller-linked-uninterpreted" as const,
    }))
    .sort((left, right) =>
      compareUnicodeCodePoints(left.evidence_id, right.evidence_id),
    );
  const unknowns = [
    "The action is caller-declared; this record does not observe or prove that it caused the state change.",
    "Unvisited UI-state candidates are unknown; this record contains only the supplied before and after observations.",
    "Unreachable UI-state candidates are unknown; no reachability search was run.",
    "Network, IPC, process, filesystem, and static causality are unknown unless separately established by a dedicated Evidence workflow. Caller-linked Evidence is retained without reinterpretation.",
    ...(same
      ? []
      : [
          "The supplied state pair does not prove one continuous target because the target or origin differs.",
        ]),
  ];
  const limitations = uniqueSorted([
    ...input.before.inspection.limitations,
    ...input.after.inspection.limitations,
    ...(input.session === undefined
      ? [
          "No observe_web_session Evidence was supplied, so no bounded event window is linked to this state pair.",
        ]
      : input.session.observation.limitations),
    "browser-page-v1 projects one browser-page target only. It does not inventory arbitrary native windows or Electron accessibility state.",
    "Screenshots are not part of this projection; use separately captured screenshot Evidence for visual comparison.",
  ]);
  return uiStateTransitionResultSchema.parse({
    schema: "UiStateTransitionEvidence",
    adapter: "browser-page-v1",
    action: input.action,
    before,
    after,
    transition: {
      association: "caller-declared-between-observations",
      target_continuity: targetContinuity,
      diff,
      session: projectSession(
        input.session,
        input.before.inspection,
        input.after.inspection,
      ),
      related_evidence: relatedEvidence,
    },
    coverage: {
      observed_state_count: 2,
      same_target_state_pair: same ? "observed" : "unknown",
      unvisited_state_candidates: "unknown",
      unreachable_state_candidates: "unknown",
    },
    limitations,
    unknowns: uniqueSorted(unknowns),
  });
};
