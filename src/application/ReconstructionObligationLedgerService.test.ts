import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  proofEvidence,
  request,
  reviewedObligation,
} from "./ReconstructionObligationLedger.fixture.js";
import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "./ReconstructionObligationLedgerService.js";

/** Resolve a raw request and validate its ledger Evidence, as both adapters do. */
const validate = (input: unknown) => {
  const parsed = resolveReconstructionObligationLedgerRequest(input);
  if (!parsed.ok) throw parsed.error;
  return buildReconstructionObligationLedgerEvidenceValidated(parsed.value);
};

describe("reconstruction obligation ledger caller-input classification", () => {
  it("reports a cited review Evidence record that is absent as caller input", () => {
    const absentEvidenceId = `ev_${"a".repeat(64)}`;
    const result = validate(
      request([proofEvidence("present")], {
        reviewed_obligations: [
          reviewedObligation("obl.review.absent", absentEvidenceId),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a caller-input failure");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      issues: [
        expect.objectContaining({
          reason: "invalid_value",
          message: `Reviewed obligation Evidence is missing: ${absentEvidenceId}`,
        }),
      ],
    });
  });

  it("reports a duplicated Evidence record as caller input", () => {
    const canonical = createEvidenceBundle([proofEvidence("duplicated")]);
    const result = validate({
      evidence_bundle: {
        ...canonical,
        records: [...canonical.records, canonical.records[0]],
      },
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a caller-input failure");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      issues: [
        expect.objectContaining({
          reason: "invalid_value",
          message: "Evidence bundle contains duplicate record IDs",
        }),
      ],
    });
  });

  it("keeps a non-canonical authenticated bundle classified as caller input", () => {
    const canonical = createEvidenceBundle([
      proofEvidence("first"),
      proofEvidence("second"),
    ]);
    const result = validate({
      evidence_bundle: {
        ...canonical,
        records: [...canonical.records].reverse(),
      },
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a caller-input failure");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      issues: [
        expect.objectContaining({
          message: expect.stringContaining(
            "Evidence bundle manifests are not canonical",
          ),
        }),
      ],
    });
  });
});
