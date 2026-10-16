import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import {
  BROWSER_SCENARIO_START_STEP,
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserScenarioStepSchema,
  browserStepArtifactsSchema,
  classifyBrowserScenarioCompleteness,
} from "./browserScenarioCaptureValues.js";
import { browserScenarioFixtureCapture } from "./browserScenarioCapture.fixture.js";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "./browserScenarioCaptureLimits.js";

const networkEvent = {
  sequence: 1,
  step_index: 0,
  transaction_id: "request-1",
  redirected_from_transaction_id: null,
  redirected_from_transaction_state: "root",
  method: "GET",
  url: sanitizeBrowserUrl("https://example.test/resource"),
  resource_type: "document",
  header_names: [],
} as const;

it("requires transaction IDs and explicit unknown redirect predecessors", () => {
  const request = {
    ...networkEvent,
    kind: "request",
    status: null,
    failure: null,
  } as const;
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      transaction_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      redirected_from_transaction_id: undefined,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...request,
      redirected_from_transaction_id: "request-0",
      redirected_from_transaction_state: "unknown",
    }).success,
  ).toBe(false);
});

it("parses each network outcome without contradictory status or failure data", () => {
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "response",
      status: null,
      failure: null,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "request-failed",
      status: 500,
      failure: "connection reset",
    }).success,
  ).toBe(false);
});

it("keeps WebSocket payload representation tied to its payload type", () => {
  const frame = {
    sequence: 1,
    step_index: 0,
    kind: "websocket-frame-received",
    url: sanitizeBrowserUrl("https://example.test/socket"),
    payload_bytes: 3,
    truncated: false,
  } as const;
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "binary",
      payload_text: "abc",
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "text",
      payload_text: "abc",
    }).success,
  ).toBe(true);
});

it("does not attach a content digest to redacted storage secrets", () => {
  expect(
    browserStepArtifactsSchema.safeParse({
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: {
        state: "captured",
        value: {
          cookies: [],
          local_storage: [
            {
              name: "session",
              value_state: "redacted-secret",
              value_sha256: "a".repeat(64),
            },
          ],
          session_storage: [],
        },
      },
    }).success,
  ).toBe(false);
});

it("accepts complete storage, history, and text artifacts beyond former caps", () => {
  const text = "x".repeat(1_048_577);
  const fingerprint = {
    name: "entry",
    value_state: "hashed",
    value_sha256: "a".repeat(64),
  } as const;
  const parsed = browserStepArtifactsSchema.safeParse({
    screenshot: { state: "not_requested" },
    dom: {
      state: "captured",
      value: {
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
        text,
      },
    },
    accessibility: { state: "not_requested" },
    url: { state: "not_requested" },
    history: {
      state: "captured",
      value: {
        length: 257,
        current_url: sanitizeBrowserUrl("https://example.test/"),
        navigation_entries: Array.from({ length: 257 }, () => ({
          type: "navigate",
          name: sanitizeBrowserUrl("https://example.test/"),
        })),
      },
    },
    storage: {
      state: "captured",
      value: {
        cookies: Array.from({ length: 513 }, () => ({
          name: fingerprint.name,
          domain: "example.test",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "Lax",
          value_state: fingerprint.value_state,
          value_sha256: fingerprint.value_sha256,
        })),
        local_storage: Array.from({ length: 513 }, () => fingerprint),
        session_storage: Array.from({ length: 513 }, () => fingerprint),
      },
    },
  });

  expect(parsed.success).toBe(true);
});

it("accepts complete scenario output beyond former string caps", () => {
  const longText = "detail".repeat(1_000);
  const step = (index: number) => ({
    step_index: index,
    ...(index === 0
      ? BROWSER_SCENARIO_START_STEP
      : { step_id: longText, action: longText }),
    elapsed_ms: 0,
    before_url: sanitizeBrowserUrl("https://example.test/"),
    after_url: sanitizeBrowserUrl("https://example.test/"),
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts: {
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: { state: "not_requested" },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    status: "completed",
    error: null,
  });
  const parsed = browserScenarioCaptureSchema.parse({
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: longText,
      version: longText,
    },
    scenario: {
      start_origin: longText,
      action_count: 1,
      secret_references: [longText],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
      event_families: [],
      limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
    },
    duration_ms: 0,
    steps: [step(0), step(1)],
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
    limitations: Array.from({ length: 65 }, () => longText),
  });

  expect(parsed.steps[1]?.step_id).toBe(longText);
  expect(parsed.limitations).toHaveLength(65);
});

/** Complete capture input with network omission accounting. */
const omissionAccountingInput = () => {
  const outputStep = (index: number) => ({
    step_index: index,
    ...(index === 0
      ? BROWSER_SCENARIO_START_STEP
      : { step_id: `step-${index}`, action: "wait_for_timeout" }),
    elapsed_ms: 0,
    before_url: sanitizeBrowserUrl("http://127.0.0.1/"),
    after_url: sanitizeBrowserUrl("http://127.0.0.1/"),
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts: {
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: { state: "not_requested" },
    },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    status: "completed",
    error: null,
  });
  return {
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "fixture",
    },
    scenario: {
      start_origin: "http://127.0.0.1",
      action_count: 1,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: true,
        header_values: false,
      },
      event_families: ["network"],
      limits: {
        ...DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
        max_total_event_allocation_bytes: 32 * 1024 * 1024,
      },
    },
    duration_ms: 1,
    steps: [outputStep(0), outputStep(1)],
    events: {
      retained: 0,
      dropped: 2,
      items: [],
      omissions: {
        by_kind: [
          {
            kind: "network-content",
            count: 1,
            reasons: ["max-total-event-allocation-bytes"],
          },
          {
            kind: "request",
            count: 1,
            reasons: ["max-network-transactions"],
          },
        ],
        network_transactions: [
          {
            transaction_id: "request-1",
            omitted_kinds: ["network-content"],
            reasons: ["max-total-event-allocation-bytes"],
          },
        ],
        network_transaction_range: {
          first_transaction_id: "request-2",
          last_transaction_id: "request-2",
          count: 1,
          reason: "max-network-transactions",
        },
      },
    },
    completeness: {
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["events"],
      truncated_sections: [],
    },
    limitations: ["Event coverage is incomplete."],
  };
};

it("validates reported event limits and omission accounting", () => {
  const capture = browserScenarioCaptureSchema.safeParse(
    omissionAccountingInput(),
  );
  if (!capture.success) throw new Error("Expected valid omission accounting");
  expect(capture.data.scenario.limits.max_total_event_allocation_bytes).toBe(
    32 * 1024 * 1024,
  );
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...capture.data,
      events: {
        ...capture.data.events,
        dropped: 3,
      },
    }).success,
  ).toBe(false);
  for (const limits of [
    {},
    { max_events: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_events },
  ])
    expect(
      browserScenarioCaptureSchema.safeParse({
        ...capture.data,
        scenario: { ...capture.data.scenario, limits },
      }).success,
    ).toBe(false);
  expect(
    browserScenarioCaptureSchema.safeParse({
      ...capture.data,
      scenario: { ...capture.data.scenario, limits: undefined },
    }).success,
  ).toBe(false);
});

it("limits event omission accounting to selected families", () => {
  const capture = browserScenarioCaptureSchema.parse(omissionAccountingInput());
  const selecting = (
    eventFamilies: (typeof capture.scenario.event_families)[number][],
    responseBody: boolean,
  ) =>
    browserScenarioCaptureSchema.safeParse({
      ...capture,
      scenario: {
        ...capture.scenario,
        event_families: eventFamilies,
        network_content: {
          ...capture.scenario.network_content,
          response_body: responseBody,
        },
      },
    });
  // Selecting network content alone enables network observation.
  expect(selecting([], true).success).toBe(true);
  expect(
    selecting(["console"], false).error?.issues.map(({ path }) => path),
  ).toEqual([
    ["events", "omissions", "by_kind", 0, "kind"],
    ["events", "omissions", "by_kind", 1, "kind"],
    ["events", "omissions", "network_transactions", 0],
    ["events", "omissions", "network_transaction_range"],
  ]);
  const transactionOmitting = (kind: "network-content" | "popup-opened") =>
    browserScenarioCaptureSchema.safeParse({
      ...capture,
      events: {
        ...capture.events,
        omissions: {
          ...capture.events.omissions,
          network_transactions: [
            {
              transaction_id: "request-1",
              omitted_kinds: [kind],
              reasons: ["max-total-event-allocation-bytes"],
            },
          ],
        },
      },
    });
  expect(transactionOmitting("network-content").success).toBe(true);
  expect(
    transactionOmitting("popup-opened").error?.issues.map(({ path }) => path),
  ).toEqual([
    ["events", "omissions", "network_transactions", 0, "omitted_kinds", 0],
  ]);
  // Popup discovery serves every selected family, so an unadmitted popup page
  // is an omission whenever any family is selected.
  const popupDiscovery = (
    eventFamilies: (typeof capture.scenario.event_families)[number][],
  ) =>
    browserScenarioCaptureSchema.safeParse({
      ...capture,
      scenario: {
        ...capture.scenario,
        event_families: eventFamilies,
        network_content: {
          request_body: false,
          response_body: false,
          header_values: false,
        },
      },
      events: {
        ...capture.events,
        dropped: 1,
        omissions: {
          by_kind: [
            { kind: "popup-opened", count: 1, reasons: ["max-events"] },
          ],
          network_transactions: [],
          network_transaction_range: null,
        },
      },
    }).success;
  expect(popupDiscovery(["console"])).toBe(true);
  expect(popupDiscovery([])).toBe(false);
});

it("keeps step completeness equal to the step's artifacts and outcome", () => {
  const step = browserScenarioFixtureCapture().steps[1];
  if (step === undefined) throw new Error("Expected a fixture step");
  const issues = (changes: Record<string, unknown>) =>
    browserScenarioStepSchema
      .safeParse({ ...step, ...changes })
      .error?.issues.map(({ path }) => path);
  const failedCompleteness = classifyBrowserScenarioCompleteness(
    [...step.completeness.missing_sections, "action"],
    step.completeness.truncated_sections,
  );

  expect(issues({})).toBeUndefined();
  expect(
    issues({
      completeness: classifyBrowserScenarioCompleteness([], ["accessibility"]),
    }),
  ).toEqual([["completeness"]]);
  expect(
    issues({
      artifacts: {
        ...step.artifacts,
        dom: { state: "missing", reason: "DOM capture failed" },
      },
    }),
  ).toEqual([["completeness"]]);
  expect(issues({ status: "failed", error: "click failed" })).toEqual([
    ["completeness"],
  ]);
  expect(
    issues({
      status: "failed",
      error: "click failed",
      completeness: failedCompleteness,
    }),
  ).toBeUndefined();
  expect(issues({ completeness: failedCompleteness })).toEqual([
    ["completeness"],
  ]);
});

it("derives equality eligibility from exact completeness state", () => {
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "complete",
      equality_eligible: false,
      missing_sections: [],
      truncated_sections: [],
    }).success,
  ).toBe(false);
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["events"],
    }).success,
  ).toBe(false);
});
