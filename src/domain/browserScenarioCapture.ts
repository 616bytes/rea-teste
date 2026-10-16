import { z } from "zod";
import { browserNetworkContentSelectionValuesSchema } from "./browserNetworkEvidence.js";
import { browserScenarioCaptureLimitsValuesSchema } from "./browserScenarioCaptureLimits.js";

import {
  BROWSER_SCENARIO_START_STEP,
  browserScenarioCompletenessSchema,
  browserScenarioEventFamilySchema,
  browserScenarioEventKindFamily,
  browserScenarioEventOmissionsSchema,
  browserScenarioEventSchema,
  browserScenarioOmissionKindSelected,
  browserScenarioStepSchema,
  enabledScenarioEventFamilies,
  type BrowserScenarioEventKind,
} from "./browserScenarioCaptureValues.js";

const capturedFieldsSchema = z.strictObject({
  browser: z.strictObject({
    mode: z.enum(["launch", "connect"]),
    process_ownership: z.enum(["provider-owned", "external"]),
    cleanup: z.enum(["terminated-owned-process", "disconnected-external"]),
    product: z.string().min(1),
    version: z.string().min(1),
  }),
  scenario: z.strictObject({
    start_origin: z.string().min(1),
    action_count: z.number().int().min(1),
    secret_references: z.array(z.string().min(1)),
    network_content: browserNetworkContentSelectionValuesSchema,
    event_families: z.array(browserScenarioEventFamilySchema),
    limits: browserScenarioCaptureLimitsValuesSchema,
  }),
  duration_ms: z.number().int().min(0),
  steps: z.array(browserScenarioStepSchema).min(1),
  events: z.strictObject({
    retained: z.number().int().min(0),
    dropped: z.number().int().min(0),
    items: z.array(browserScenarioEventSchema),
    omissions: browserScenarioEventOmissionsSchema,
  }),
  completeness: browserScenarioCompletenessSchema,
  limitations: z.array(z.string().min(1)),
});
type CapturedFields = z.infer<typeof capturedFieldsSchema>;

/**
 * Retained events belong only to families the scenario selected; omission
 * accounting follows the producer's admission rule for selected families, and
 * only the network collector accounts network transaction omissions.
 */
const refineSelectedEventFamilies = (
  { scenario, events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const selected = new Set(
    enabledScenarioEventFamilies(
      scenario.event_families,
      scenario.network_content,
    ),
  );
  const unselected = (
    kind: BrowserScenarioEventKind,
    path: readonly (string | number)[],
  ): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: `Event kind ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family, which the scenario did not select`,
    });
  };
  for (const [index, { kind }] of events.items.entries())
    if (!selected.has(browserScenarioEventKindFamily(kind)))
      unselected(kind, ["events", "items", index, "kind"]);
  for (const [index, { kind }] of events.omissions.by_kind.entries())
    if (!browserScenarioOmissionKindSelected(kind, selected))
      unselected(kind, ["events", "omissions", "by_kind", index, "kind"]);
  const networkSelected = selected.has("network");
  const networkOmission = (path: readonly (string | number)[]): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message:
        "Network transaction omissions require the network family, which the scenario did not select",
    });
  };
  for (const [
    index,
    omission,
  ] of events.omissions.network_transactions.entries()) {
    const path = ["events", "omissions", "network_transactions", index];
    if (!networkSelected) {
      networkOmission(path);
      continue;
    }
    for (const [kindIndex, kind] of omission.omitted_kinds.entries())
      if (browserScenarioEventKindFamily(kind) !== "network")
        context.addIssue({
          code: "custom",
          path: [...path, "omitted_kinds", kindIndex],
          message: `Network transaction omissions name only network event kinds; ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family`,
        });
  }
  if (events.omissions.network_transaction_range !== null && !networkSelected)
    networkOmission(["events", "omissions", "network_transaction_range"]);
};

/** Step 0 is always the producer's completed implicit start navigation. */
const refineStartStep = (
  { steps }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const start = steps[0];
  if (
    start !== undefined &&
    (start.step_id !== BROWSER_SCENARIO_START_STEP.step_id ||
      start.action !== BROWSER_SCENARIO_START_STEP.action ||
      start.status !== "completed")
  )
    context.addIssue({
      code: "custom",
      path: ["steps", 0],
      message: `Step 0 must be the completed implicit start navigation (step_id ${BROWSER_SCENARIO_START_STEP.step_id}, action ${BROWSER_SCENARIO_START_STEP.action})`,
    });
};

/** Step-indexed browser scenario observation. */
export const browserScenarioCaptureSchema = capturedFieldsSchema.superRefine(
  (capture, context) => {
    refineSelectedEventFamilies(capture, context);
    refineStartStep(capture, context);
    const bySequence = new Map(
      capture.events.items.map((event) => [event.sequence, event]),
    );
    if (bySequence.size !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event sequence numbers must be unique",
      });
    for (const [index, event] of capture.events.items.entries()) {
      if (event.kind !== "network-content") continue;
      const source = bySequence.get(event.source_event_sequence);
      if (
        source?.kind !== event.phase ||
        source.transaction_id !== event.transaction_id ||
        source.sequence >= event.sequence
      )
        context.addIssue({
          code: "custom",
          path: ["events", "items", index, "source_event_sequence"],
          message:
            "Network content must reference an earlier matching transaction phase",
        });
    }
    if (capture.events.retained !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "retained"],
        message: "Retained event count must equal items length",
      });
    if (
      capture.events.omissions.by_kind.reduce(
        (count, omission) => count + omission.count,
        0,
      ) !== capture.events.dropped
    )
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind"],
        message: "Per-kind omission counts must equal the dropped event count",
      });
    if (capture.steps.length !== capture.scenario.action_count + 1)
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Capture must include initial state and one entry per action",
      });
    const expectedIndices = capture.steps.map((_, index) => index);
    if (
      capture.steps.some(
        ({ step_index: index }, offset) => index !== expectedIndices[offset],
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step indices must be contiguous from zero",
      });
    if (
      capture.events.items.some(
        ({ step_index: index }) => index >= capture.steps.length,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event references an unknown step index",
      });
  },
);
export type BrowserScenarioCapture = z.infer<
  typeof browserScenarioCaptureSchema
>;

/** Capture fields shared by complete results and retained partial observations. */
export type BrowserScenarioCaptureData = Omit<
  BrowserScenarioCapture,
  "browser" | "steps" | "completeness" | "events"
> & {
  readonly browser: Omit<BrowserScenarioCapture["browser"], "cleanup"> & {
    readonly cleanup:
      | BrowserScenarioCapture["browser"]["cleanup"]
      | "incomplete";
  };
  readonly steps: readonly BrowserScenarioCapture["steps"][number][];
  readonly events: Omit<BrowserScenarioCapture["events"], "items"> & {
    readonly items: readonly BrowserScenarioCapture["events"]["items"][number][];
  };
};

/** Browser scenario data retained when an operation fails before a complete result. */
export interface BrowserScenarioPartialObservation {
  readonly kind: "browser-scenario-observation";
  readonly capture: BrowserScenarioCaptureData;
}
