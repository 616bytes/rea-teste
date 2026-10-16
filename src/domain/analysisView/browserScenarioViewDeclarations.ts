import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { BrowserScenarioCapture } from "../browserScenarioCapture.js";
import { BROWSER_SCENARIO_STATE_ARTIFACTS } from "../browserScenarioDiffEvidence.js";
import {
  browserScenarioActionClass,
  type BrowserScenarioActionClass,
} from "../browserScenarioSteps.js";
import {
  browserScenarioSnapshotKindSchema,
  requestedScenarioArtifacts,
} from "../browserScenarioValues.js";
import { jsonObjectSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisViewParent } from "./analysisView.js";
import { analysisViewInputError } from "./analysisViewErrors.js";

const recordedActionSchema = z.looseObject({
  step_id: z.string().min(1),
  action: z.string().min(1),
});
const recordedParametersSchema = z.looseObject({
  actions: z.array(z.unknown()),
});

/**
 * Bind each action step to the exact declaration recorded in the parent
 * parameters. The Evidence ID authenticates the parameters; only identity
 * fields are checked, so historical declarations are never re-defaulted.
 */
export interface RecordedAction {
  readonly declaration: z.output<typeof jsonObjectSchema>;
  readonly actionClass: BrowserScenarioActionClass;
}

export const recordedActions = (
  parent: AnalysisViewParent,
  capture: BrowserScenarioCapture,
): Result<readonly RecordedAction[], AnalysisError> => {
  const mismatch = (path: readonly (string | number)[], message: string) =>
    err(
      analysisViewInputError([
        {
          path: ["source", "parameters", ...path],
          reason: "invalid_value",
          message,
        },
      ]),
    );
  const parameters = recordedParametersSchema.safeParse(parent.parameters);
  if (!parameters.success)
    return mismatch(
      ["actions"],
      "Browser scenario Evidence parameters must record the declared actions.",
    );
  const { actions } = parameters.data;
  if (actions.length !== capture.steps.length - 1)
    return mismatch(
      ["actions"],
      "Recorded actions must match the capture's action steps one to one.",
    );
  const recorded: RecordedAction[] = [];
  for (const [index, raw] of actions.entries()) {
    const step = capture.steps[index + 1];
    const identity = recordedActionSchema.safeParse(raw);
    const declaration = jsonObjectSchema.safeParse(raw);
    const actionClass =
      step === undefined ? undefined : browserScenarioActionClass(step.action);
    if (
      step === undefined ||
      actionClass === undefined ||
      !identity.success ||
      !declaration.success ||
      identity.data.step_id !== step.step_id ||
      identity.data.action !== step.action
    )
      return mismatch(
        ["actions", index],
        `Recorded action ${String(index)} must declare a known action with the step_id and action of capture step ${String(index + 1)}.`,
      );
    recorded.push({ declaration: declaration.data, actionClass });
  }
  return ok(recorded);
};

const recordedSelectionSchema = z.looseObject({
  capture: z.looseObject({
    after_each_step: z.array(browserScenarioSnapshotKindSchema),
    at_end: z.array(browserScenarioSnapshotKindSchema),
  }),
});

/**
 * The capture result records no artifact selection, so bind each step's
 * artifacts to the selection the recorded scenario made for that step: a
 * requested artifact is never not_requested, and an unrequested one always is.
 */
export const checkRecordedSelection = (
  parent: AnalysisViewParent,
  capture: BrowserScenarioCapture,
): Result<void, AnalysisError> => {
  const issue = (path: readonly (string | number)[], message: string) =>
    err(
      analysisViewInputError([
        { path: ["source", ...path], reason: "invalid_value", message },
      ]),
    );
  const parameters = recordedSelectionSchema.safeParse(parent.parameters);
  if (!parameters.success)
    return issue(
      ["parameters", "capture"],
      "Browser scenario Evidence parameters must record the artifact selection.",
    );
  const actionCount = capture.steps.length - 1;
  for (const [index, step] of capture.steps.entries()) {
    const requested = requestedScenarioArtifacts(
      parameters.data.capture,
      index,
      actionCount,
    );
    for (const artifact of BROWSER_SCENARIO_STATE_ARTIFACTS) {
      const recorded = step.artifacts[artifact].state !== "not_requested";
      if (recorded !== requested.has(artifact))
        return issue(
          ["normalized_result", "steps", index, "artifacts", artifact],
          recorded
            ? `Step ${String(index)} records ${artifact}, which the recorded scenario did not request there.`
            : `The recorded scenario requested ${artifact} at step ${String(index)}, but the step records it as not requested.`,
        );
    }
  }
  return ok(undefined);
};
