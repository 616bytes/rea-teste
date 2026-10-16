import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { reviewedObligation } from "../../../src/application/ReconstructionObligationLedger.fixture.js";

const execute = promisify(execFile);

/** Run the ledger CLI and parse its JSON report whether it succeeds or fails. */
const runLedgerCli = async (input: unknown): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      !(cause instanceof Error) ||
      !("stdout" in cause) ||
      typeof cause.stdout !== "string"
    )
      throw cause;
    return JSON.parse(cause.stdout);
  }
};

const fixtureRecord = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "observe", parameters: { label }, result: { label } },
  );

describe("reconstruction obligation ledger CLI parity", () => {
  it("reports non-canonical authenticated bundles as caller input", async () => {
    const canonical = createEvidenceBundle([
      fixtureRecord("first"),
      fixtureRecord("second"),
    ]);
    expect(
      await runLedgerCli({
        evidence_bundle: canonical,
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      }),
    ).toMatchObject({
      normalized_result: { status: "unknown", summary: { total: 0 } },
    });
    expect(
      await runLedgerCli({
        evidence_bundle: {
          ...canonical,
          records: [...canonical.records].reverse(),
        },
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      }),
    ).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      details: {
        operation: "build_reconstruction_obligation_ledger",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining(
              "Evidence bundle manifests are not canonical",
            ),
          }),
        ],
      },
    });
  }, 20_000);

  it("reports a cited review Evidence record that is absent as caller input", async () => {
    const absentEvidenceId = `ev_${"a".repeat(64)}`;
    const report = await runLedgerCli({
      evidence_bundle: createEvidenceBundle([]),
      reviewed_obligations: [
        reviewedObligation("obl.review.absent", absentEvidenceId),
      ],
      manifest: { bindings: [], contradictions: [] },
    });
    expect(report).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      details: {
        operation: "build_reconstruction_obligation_ledger",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining(
              `Reviewed obligation Evidence is missing: ${absentEvidenceId}`,
            ),
          }),
        ],
      },
    });
  }, 20_000);

  it("reports a duplicated Evidence record as caller input", async () => {
    const canonical = createEvidenceBundle([fixtureRecord("duplicated")]);
    const report = await runLedgerCli({
      evidence_bundle: {
        ...canonical,
        records: [...canonical.records, canonical.records[0]],
      },
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    expect(report).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      details: {
        operation: "build_reconstruction_obligation_ledger",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining(
              "Evidence bundle contains duplicate record IDs",
            ),
          }),
        ],
      },
    });
  }, 20_000);

  it("builds the same Evidence-backed empty ledger through the CLI", async () => {
    const report = await runLedgerCli({
      evidence_bundle: createEvidenceBundle([]),
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    expect(report).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      predicate_type: "rea.reconstruction-obligation-ledger",
      normalized_result: {
        schema: "ReconstructionObligationLedger",
        status: "unknown",
        summary: { total: 0 },
      },
    });
  }, 20_000);
});
