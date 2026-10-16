import { z } from "zod";
import { browserNetworkContentSelectionValuesSchema } from "./browserNetworkEvidence.js";
import { browserScenarioCaptureLimitsValuesSchema } from "./browserScenarioCaptureLimits.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventFamilySchema,
  browserScenarioEventOmissionsSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
} from "./browserScenarioCaptureValues.js";

/** The fields of one browser scenario capture, before cross-field rules. */
export const capturedFieldsSchema = z.strictObject({
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
export type CapturedFields = z.infer<typeof capturedFieldsSchema>;
