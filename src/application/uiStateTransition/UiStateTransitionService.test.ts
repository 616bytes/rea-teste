import { describe, expect, it } from "vitest";

import {
  uiPageEvidence,
  uiPageInspection,
  uiRelatedEvidence,
  uiSessionEvidence,
  uiSessionObservation,
} from "../../../tests/fixtures/uiStateTransition.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { uiStateTransitionResultSchema } from "../../domain/uiStateTransition.js";
import { deriveUiStateTransition } from "./UiStateTransitionService.js";

const action = {
  action_id: "save",
  description: "External Pyppeteer clicked Save.",
  provenance: "caller-declared" as const,
};

// oxlint-disable-next-line max-lines-per-function -- keeps one derived-workflow contract in one focused fixture suite.
describe("deriveUiStateTransition", () => {
  it("preserves caller-declared action, AX duplicates, source coverage and exact links", () => {
    const before = uiPageEvidence();
    const after = uiPageEvidence(
      uiPageInspection({
        capture_window: {
          started_at: "2026-10-15T12:00:01.000Z",
          ended_at: "2026-10-15T12:00:01.000Z",
          observation_ms: 0,
        },
      }),
    );
    const session = uiSessionEvidence();
    const related = uiRelatedEvidence();
    const result = deriveUiStateTransition({
      before,
      after,
      action,
      selection: { offset: 1, limit: 1 },
      session,
      related_evidence: [related],
    });
    if (!result.ok) throw result.error;
    const evidence = parseEvidence(result.value);
    expect(evidence.operation).toBe("derive_ui_state_transition");
    expect(evidence.confidence).toBe("derived");
    expect(evidence.evidence_links).toEqual(
      [
        before.evidence_id,
        after.evidence_id,
        session.evidence_id,
        related.evidence_id,
      ].sort(),
    );
    const projected = uiStateTransitionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(projected).toMatchObject({
      action,
      before: {
        accessibility: {
          status: "observed",
          items: [{ node_id: "ax-save", name: "Save" }],
          coverage: { total: 3, examined: 1, next_offset: 2 },
        },
      },
      transition: {
        association: "caller-declared-between-observations",
        target_continuity: { status: "observed", target_id: "page-1" },
        diff: {
          dimensions: { accessibility: { status: "unchanged" } },
        },
        session: { status: "observed", timeline_event_count: 1 },
        related_evidence: [
          {
            evidence_id: related.evidence_id,
            relationship: "caller-linked-uninterpreted",
          },
        ],
      },
      coverage: {
        unvisited_state_candidates: "unknown",
        unreachable_state_candidates: "unknown",
      },
    });
    expect(projected.unknowns).toContain(
      "The action is caller-declared; this record does not observe or prove that it caused the state change.",
    );
  });

  it("keeps target mismatch and unavailable accessibility unknown instead of empty", () => {
    const before = uiPageEvidence();
    const after = uiPageEvidence(
      uiPageInspection({
        target: {
          target_id: "page-2",
          type: "page",
          title: "Other",
          url: "https://other.example.test/",
          origin: "https://other.example.test",
          attached: true,
        },
        completeness: {
          status: "attach_limited",
          conditions: ["attach_limited"],
          policy_filtered_sections: [],
          attach_limited_sections: ["accessibility"],
          truncated_sections: [],
          unavailable_sections: ["accessibility"],
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
        },
        accessibility: {
          total_nodes: 0,
          text_capture: {
            status: "unavailable",
            retained_bytes: 0,
            excluded_fields: 0,
          },
          nodes: [],
        },
      }),
    );
    const result = deriveUiStateTransition({ before, after, action });
    if (!result.ok) throw result.error;
    const projected = uiStateTransitionResultSchema.parse(
      result.value.normalized_result,
    );
    expect(projected).toMatchObject({
      after: {
        accessibility: { status: "unknown" },
      },
      transition: {
        target_continuity: { status: "unknown" },
      },
      coverage: { same_target_state_pair: "unknown" },
    });
    expect(JSON.stringify(projected.after.accessibility)).not.toContain(
      '"items":[]',
    );
  });

  it("has retained and inline parity and rejects an unrelated Evidence operation", () => {
    const before = uiPageEvidence();
    const after = uiPageEvidence();
    const input = { before, after, action };
    const inline = deriveUiStateTransition(input);
    if (!inline.ok) throw inline.error;
    const retained = deriveUiStateTransition(
      {
        before: { kind: "retained-evidence", evidence_id: before.evidence_id },
        after: { kind: "retained-evidence", evidence_id: after.evidence_id },
        action,
      },
      (id) =>
        id === before.evidence_id
          ? before
          : id === after.evidence_id
            ? after
            : undefined,
    );
    if (!retained.ok) throw retained.error;
    expect(retained.value).toEqual(inline.value);
    const unrelated = uiRelatedEvidence();
    expect(
      deriveUiStateTransition({ before: unrelated, after, action }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["before"], reason: "invalid_value" }],
      },
    });
  });

  it("does not publish after cancellation and leaves a mismatched observation window unknown", () => {
    const before = uiPageEvidence();
    const after = uiPageEvidence();
    const mismatchedSession = uiSessionEvidence(
      uiSessionObservation({
        target: {
          target_id: "other-page",
          initial_url: "https://other.example.test/",
          final_url: null,
        },
      }),
    );
    const mismatched = deriveUiStateTransition({
      before,
      after,
      action,
      session: mismatchedSession,
    });
    if (!mismatched.ok) throw mismatched.error;
    const projected = uiStateTransitionResultSchema.parse(
      mismatched.value.normalized_result,
    );
    expect(projected.transition.session).toMatchObject({ status: "unknown" });

    const controller = new AbortController();
    controller.abort();
    expect(
      deriveUiStateTransition({ before, after, action }, undefined, {
        signal: controller.signal,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });

    const wrongPredicate = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "inspect_web_page",
        predicateType: "rea.not-a-page",
        parameters: {},
        result: before.normalized_result,
      },
    );
    expect(
      deriveUiStateTransition({ before: wrongPredicate, after, action }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["before"], reason: "invalid_value" }],
      },
    });
  });
});
