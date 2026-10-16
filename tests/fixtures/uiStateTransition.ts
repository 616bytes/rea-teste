import { createEvidence, type Evidence } from "../../src/domain/evidence.js";
import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "../../src/domain/browserObservationSchemas.js";
import {
  webObservationSessionSchema,
  type WebObservationSession,
} from "../../src/domain/browserSession.js";
import { jsonValueSchema } from "../../src/domain/jsonValue.js";

const ORIGIN = "https://ui.example.test";
const CAPTURED_AT = "2026-10-15T12:00:00.000Z";

const completeness = (overrides: Partial<Record<string, unknown>> = {}) => ({
  status: "complete_within_window",
  conditions: ["complete_within_window"],
  policy_filtered_sections: [],
  attach_limited_sections: [],
  truncated_sections: [],
  unavailable_sections: [],
  excluded: [],
  dropped_events: {
    scripts: 0,
    network_requests: 0,
    console_events: 0,
    websocket_connections: 0,
    websocket_frames: 0,
    webmcp_tools: 0,
    timeline_events: 0,
    total: 0,
  },
  ...overrides,
});

/** A complete browser page inspection with duplicate names and AX state. */
export const uiPageInspection = (
  overrides: Partial<WebPageInspection> = {},
): WebPageInspection =>
  webPageInspectionSchema.parse({
    browser: {
      product: "fixture-browser",
      protocol_version: "1.3",
      revision: "fixture",
      user_agent: "fixture",
      js_version: "fixture",
    },
    target: {
      target_id: "page-1",
      type: "page",
      title: "UI fixture",
      url: `${ORIGIN}/settings`,
      origin: ORIGIN,
      attached: true,
    },
    capture_window: {
      started_at: CAPTURED_AT,
      ended_at: CAPTURED_AT,
      observation_ms: 0,
    },
    completeness: completeness(),
    frames: [],
    dom: {
      total_nodes: 5,
      nodes: [
        {
          index: 0,
          parent_index: -1,
          node_type: 1,
          node_name: "HTML",
          node_value_length: 0,
          attribute_names: [],
        },
      ],
    },
    accessibility: {
      total_nodes: 3,
      text_capture: {
        status: "included",
        retained_bytes: 0,
        excluded_fields: 0,
      },
      nodes: [
        {
          node_id: "ax-root",
          parent_id: null,
          role: "RootWebArea",
          name: "Settings",
          description: null,
          ignored: false,
          states: [],
        },
        {
          node_id: "ax-save",
          parent_id: "ax-root",
          role: "button",
          name: "Save",
          description: "Save settings",
          ignored: false,
          states: [{ name: "disabled", value: false }],
        },
        {
          node_id: "ax-save-copy",
          parent_id: "ax-root",
          role: "button",
          name: "Save",
          description: null,
          ignored: false,
          states: [{ name: "focused", value: true }],
        },
      ],
    },
    scripts: { total: 0, items: [] },
    resources: [],
    network: {
      requests: [],
      websocket_connections: [],
      coverage_started_at: CAPTURED_AT,
      prior_activity_available: false,
    },
    console: {
      events: [],
      coverage_started_at: CAPTURED_AT,
      prior_activity_available: false,
    },
    workers: [],
    metadata: {
      responses: [],
      dom_urls: [],
      agent_hints: [],
      excluded_dom_urls: 0,
      headers_allowlisted: true,
    },
    storage: {
      origin: ORIGIN,
      usage_bytes: null,
      quota_bytes: null,
      local_storage_keys: [],
      session_storage_keys: [],
      indexed_db_names: [],
      cache_names: [],
      content_fingerprints: [],
      fingerprint_algorithm: "sha256",
      fingerprints_complete: false,
      values_redacted: true,
    },
    limitations: [],
    ...overrides,
  });

export const uiPageEvidence = (
  inspection: WebPageInspection = uiPageInspection(),
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "fixture-browser",
      name: "Fixture browser",
      version: "1",
    },
    {
      predicateType: "rea.web-page-inspection",
      operation: "inspect_web_page",
      parameters: {},
      result: jsonValueSchema.parse(inspection),
      confidence: "observed",
      authority: "external-service",
      limitations: inspection.limitations,
    },
  );

export const uiSessionObservation = (
  overrides: Partial<WebObservationSession> = {},
): WebObservationSession =>
  webObservationSessionSchema.parse({
    browser: {
      product: "fixture-browser",
      protocol_version: "1.3",
      revision: "fixture",
      user_agent: "fixture",
      js_version: "fixture",
    },
    target: {
      target_id: "page-1",
      initial_url: `${ORIGIN}/settings`,
      final_url: `${ORIGIN}/settings?saved=1`,
    },
    window: {
      armed_at: CAPTURED_AT,
      ended_at: CAPTURED_AT,
      requested_ms: 100,
      end_reason: "window_elapsed",
    },
    timeline: [
      {
        sequence: 1,
        type: "same_document_navigation",
        timestamp: 1,
        frame_id: "frame-1",
        loader_id: null,
        request_id: null,
        url: `${ORIGIN}/settings?saved=1`,
        destination_scope: "approved",
        detail: null,
      },
    ],
    completeness: completeness(),
    limitations: [],
    ...overrides,
  });

export const uiSessionEvidence = (
  observation: WebObservationSession = uiSessionObservation(),
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "fixture-browser",
      name: "Fixture browser",
      version: "1",
    },
    {
      predicateType: "rea.web-observation-session",
      operation: "observe_web_session",
      parameters: {},
      result: jsonValueSchema.parse(observation),
      confidence: "observed",
      authority: "external-service",
      limitations: observation.limitations,
    },
  );

export const uiRelatedEvidence = (): Evidence =>
  createEvidence(
    undefined,
    {
      id: "fixture-reconciliation",
      name: "Fixture reconciliation",
      version: "1",
    },
    {
      predicateType: "rea.javascript-runtime-reconciliation",
      operation: "reconcile_javascript_runtime",
      parameters: {},
      result: { matches: [] },
      confidence: "derived",
      authority: "analyst-inference",
    },
  );
