import type { ProviderIdentity } from "../../src/application/AnalysisProvider.js";
import { sanitizeBrowserUrl } from "../../src/domain/browserObservation.js";
import type { BrowserScenario } from "../../src/domain/browserScenario.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../../src/domain/browserScenarioCapture.js";

/** Identity reported by fake scenario ports in MCP boundary tests. */
export const FAKE_BROWSER_SCENARIO_PROVIDER_IDENTITY: ProviderIdentity = {
  id: "test-browser-scenario",
  name: "Test browser scenario provider",
  version: "1",
};

const artifacts = {
  screenshot: { state: "not_requested" },
  dom: { state: "not_requested" },
  accessibility: { state: "not_requested" },
  url: { state: "not_requested" },
  history: { state: "not_requested" },
  storage: { state: "not_requested" },
} as const;

/** Build a complete, schema-valid capture for a scenario without a browser. */
export const fakeBrowserScenarioCapture = (
  scenario: BrowserScenario,
): BrowserScenarioCapture => {
  const start = scenario.start_url.url;
  const step = (stepIndex: number, stepId: string, action: string) => ({
    step_index: stepIndex,
    step_id: stepId,
    action,
    status: "completed",
    elapsed_ms: 1,
    before_url: sanitizeBrowserUrl(start),
    after_url: sanitizeBrowserUrl(start),
    error: null,
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts,
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
  });
  return browserScenarioCaptureSchema.parse({
    browser: {
      mode: scenario.browser.mode,
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Test Browser",
      version: "1",
    },
    scenario: {
      start_origin: new URL(start).origin,
      action_count: scenario.actions.length,
      secret_references: scenario.secrets.map(({ secret_id: id }) => id),
      network_content: scenario.capture.network,
      event_families: scenario.capture.events,
      limits: scenario.capture.limits,
    },
    duration_ms: 2,
    steps: [
      step(0, "scenario_start", "goto_start"),
      ...scenario.actions.map((action, index) =>
        step(index + 1, action.step_id, action.action),
      ),
    ],
    events: {
      retained: 0,
      dropped: 0,
      items: [],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    limitations: [],
  });
};
