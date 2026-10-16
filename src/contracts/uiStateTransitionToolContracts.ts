import { z } from "zod";

import { evidenceInputSchema } from "./evidenceInputContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  uiStateTransitionActionSchema,
  uiStateTransitionResultSchema,
  uiStateTransitionSelectionSchema,
} from "../domain/uiStateTransition.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Source references for the read-only browser-page UI-state projection. */
export const uiStateTransitionInputSchema = z.strictObject({
  before: evidenceInputSchema.describe(
    "Complete inspect_web_page Evidence captured before the caller-declared action.",
  ),
  after: evidenceInputSchema.describe(
    "Complete inspect_web_page Evidence captured after the caller-declared action.",
  ),
  action: uiStateTransitionActionSchema,
  selection: uiStateTransitionSelectionSchema.default({ offset: 0, limit: 64 }),
  session: evidenceInputSchema
    .optional()
    .describe(
      "Optional observe_web_session Evidence for a bounded event window; it is not interpreted as causal proof.",
    ),
  related_evidence: z
    .array(evidenceInputSchema)
    .default([])
    .describe(
      "Optional exact Evidence links retained as caller-linked context without causal or semantic reinterpretation.",
    ),
});
export type UiStateTransitionInput = z.output<
  typeof uiStateTransitionInputSchema
>;

/** Read-only browser UI state/transition evidence for external executors. */
export const UI_STATE_TRANSITION_TOOL_CONTRACTS = [
  {
    name: "derive_ui_state_transition",
    ...toolContractMetadata("derive_ui_state_transition"),
    kind: "application",
    description:
      "Derive read-only browser-page UI state and transition Evidence from complete inspect_web_page observations captured before and after one caller-declared action. It preserves accessibility role/name/state inventory pages, DOM counts, source coverage, target continuity, optional bounded observe_web_session context, and exact caller-linked Evidence IDs. It neither executes the action nor claims causality, reset determinism, unvisited-state coverage, native-window coverage, Electron accessibility coverage, or static/IPC/network/process/filesystem correlation. Use an external executor such as Pyppeteer for the action, then provide its REA observations here.",
    inputSchema: uiStateTransitionInputSchema,
    outputSchema: evidenceResultOf(uiStateTransitionResultSchema),
    examples: [
      {
        title: "Link two retained browser page observations around one action",
        input: {
          before: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          after: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          action: {
            action_id: "open-settings",
            description: "Pyppeteer clicked the settings control.",
            provenance: "caller-declared",
          },
          selection: { offset: 0, limit: 32 },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
