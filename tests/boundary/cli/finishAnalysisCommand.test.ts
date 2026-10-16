import { expect, it } from "vitest";

import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { scriptCaptureEvidenceFixture } from "../../fixtures/webScriptCapture.js";

it.each([false, true])(
  "reports producer cleanup recovery only when its owner resolves the error: %s",
  async (ownerReleased) => {
    const evidence = scriptCaptureEvidenceFixture();
    const original = new ProviderCleanupError(
      "fixture-provider",
      ["producer-resource"],
      { reason: "original cleanup failure" },
      { operation: "inspect_web_page", partialObservation: evidence },
    );
    const result = await finishAnalysisCommand(
      async () => err(original),
      {
        close: async () => {
          if (ownerReleased) original.resolveCleanup();
        },
      },
      "fixture-provider",
      "inspect_web_page",
    );
    expect(result).toMatchObject({
      code: ownerReleased ? "execution_failure" : "cleanup_incomplete",
      details: {
        diagnostics: { reason: "original cleanup failure" },
        partial_observation: evidence,
      },
    });
    if (ownerReleased) expect(result).not.toHaveProperty("details.resources");
    else
      expect(result).toMatchObject({
        details: { resources: ["producer-resource"] },
      });
  },
);

it("returns completed partial Evidence when cancellation arrives during close", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () => ok(evidence),
    {
      close: async () => {
        controller.abort(new Error("cancelled during close"));
      },
    },
    "fixture-provider",
    "capture_browser_scenario",
    undefined,
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "cancelled",
    details: { partial_observation: { evidence_id: evidence.evidence_id } },
  });
});

it("preserves the primary operation error when cancellation arrives during close", async () => {
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () =>
      err(new AnalysisOutputError("inspect_web_page", "primary failure")),
    {
      close: async () => {
        controller.abort();
      },
    },
    "fixture-provider",
    "inspect_web_page",
    undefined,
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "unreadable_output",
    details: {
      reason: "primary failure",
      operation: "inspect_web_page",
    },
  });
});
