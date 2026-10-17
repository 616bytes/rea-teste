import { expect, it, vi } from "vitest";

import { analysisViewLayoutEvidence } from "../../../tests/fixtures/analysisView.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { javascriptApplicationAnalysisResultSchema } from "../javascript/javascriptApplicationAnalysis.js";
import { binaryLayoutSchema } from "../native/binaryLayout.js";
import { analysisViewJavaScriptAnalysis } from "../../../tests/fixtures/analysisView.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const sealedJavaScriptParent = (): AnalysisViewParent => ({
  evidenceId: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
  operation: "analyze_javascript_application",
  // Imported Evidence seals its payload but carries no producer graph proof, so
  // this is the exact shape that used to revalidate on every page.
  normalizedResult: freezeJsonSnapshot(analysisViewJavaScriptAnalysis()),
  sealedResult: true,
  limitations: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.limitations,
});

const sealedLayoutParent = (): AnalysisViewParent => {
  const evidence = analysisViewLayoutEvidence();
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: freezeJsonSnapshot(evidence.normalized_result),
    sealedResult: true,
    limitations: evidence.limitations,
  };
};

const summaryView = { kind: "summary" } as const;

it("reuses one validated JavaScript interpretation across pages of a sealed parent", () => {
  const parent = sealedJavaScriptParent();
  const parse = vi.spyOn(javascriptApplicationAnalysisResultSchema, "parse");
  try {
    const first = projectAnalysisView(parent, summaryView);
    if (!first.ok) throw first.error;
    expect(parse).toHaveBeenCalledTimes(1);
    for (let page = 0; page < 3; page += 1) {
      const next = projectAnalysisView(parent, summaryView);
      if (!next.ok) throw next.error;
      expect(next.value).toEqual(first.value);
    }
    // The sealed parent keeps its completed interpretation; no page revalidates.
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

it("reuses one validated layout interpretation across pages of a sealed parent", () => {
  const parent = sealedLayoutParent();
  const parse = vi.spyOn(binaryLayoutSchema, "safeParse");
  try {
    const first = projectAnalysisView(parent, summaryView);
    if (!first.ok) throw first.error;
    expect(parse).toHaveBeenCalledTimes(1);
    for (let page = 0; page < 3; page += 1) {
      const next = projectAnalysisView(parent, summaryView);
      if (!next.ok) throw next.error;
      expect(next.value).toEqual(first.value);
    }
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

it("validates an unsealed parent on every page", () => {
  const parent: AnalysisViewParent = {
    ...sealedJavaScriptParent(),
    sealedResult: false,
  };
  const parse = vi.spyOn(javascriptApplicationAnalysisResultSchema, "parse");
  try {
    for (let page = 0; page < 3; page += 1) {
      const result = projectAnalysisView(parent, summaryView);
      if (!result.ok) throw result.error;
    }
    expect(parse).toHaveBeenCalledTimes(3);
  } finally {
    parse.mockRestore();
  }
});

it("does not reuse a caller's freeze hint without the snapshot proof", () => {
  const parent: AnalysisViewParent = {
    ...sealedJavaScriptParent(),
    // Frozen by hand, never registered by freezeJsonSnapshot.
    normalizedResult: Object.freeze(analysisViewJavaScriptAnalysis()) as never,
    sealedResult: true,
  };
  const parse = vi.spyOn(javascriptApplicationAnalysisResultSchema, "parse");
  try {
    for (let page = 0; page < 2; page += 1) {
      const result = projectAnalysisView(parent, summaryView);
      if (!result.ok) throw result.error;
    }
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});

it("never caches a rejected interpretation", () => {
  const invalid = freezeJsonSnapshot({
    ...analysisViewJavaScriptAnalysis(),
    root_artifact_sha256: "not-a-digest",
  }) as never;
  const parent: AnalysisViewParent = {
    ...sealedJavaScriptParent(),
    normalizedResult: invalid,
  };
  const parse = vi.spyOn(javascriptApplicationAnalysisResultSchema, "parse");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = projectAnalysisView(parent, summaryView);
      expect(result.ok).toBe(false);
    }
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});

it("keeps a different sealed source out of another source's interpretation", () => {
  const first = sealedJavaScriptParent();
  const second: AnalysisViewParent = {
    ...sealedJavaScriptParent(),
    normalizedResult: freezeJsonSnapshot(analysisViewJavaScriptAnalysis()),
  };
  const parse = vi.spyOn(javascriptApplicationAnalysisResultSchema, "parse");
  try {
    const a = projectAnalysisView(first, summaryView);
    const b = projectAnalysisView(second, summaryView);
    if (!a.ok) throw a.error;
    if (!b.ok) throw b.error;
    // Two distinct sealed sources each validate once.
    expect(parse).toHaveBeenCalledTimes(2);
    expect(a.value).toEqual(b.value);
  } finally {
    parse.mockRestore();
  }
});
