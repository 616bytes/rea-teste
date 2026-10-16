import { describe, expect } from "vitest";

import { reviewedObligation } from "../../../src/application/ReconstructionObligationLedger.fixture.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const runLedger = (cli: TestCli, input: unknown) =>
  cli.run({
    arguments: [
      "build-reconstruction-obligation-ledger",
      JSON.stringify(input),
      "--json",
    ],
  });

const fixtureRecord = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "observe", parameters: { label }, result: { label } },
  );

const callerInputFailure = (message: string) => ({
  code: "invalid_request",
  category: "invalid_input",
  retryable: true,
  details: {
    operation: "build_reconstruction_obligation_ledger",
    issues: [
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ],
  },
});

describe("reconstruction obligation ledger CLI parity", () => {
  cliTest(
    "reports non-canonical authenticated bundles as caller input",
    async ({ cli }) => {
      const canonical = createEvidenceBundle([
        fixtureRecord("first"),
        fixtureRecord("second"),
      ]);
      const input = {
        evidence_bundle: canonical,
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      };
      const accepted = await runLedger(cli, input);
      expect(accepted.exitCode).toBe(0);
      expect(accepted.json).toMatchObject({
        normalized_result: { status: "unknown", summary: { total: 0 } },
      });
      const rejected = await runLedger(cli, {
        ...input,
        evidence_bundle: {
          ...canonical,
          records: [...canonical.records].reverse(),
        },
      });
      expect(rejected.exitCode).toBe(1);
      expect(rejected.json).toMatchObject(
        callerInputFailure("Evidence bundle manifests are not canonical"),
      );
    },
    20_000,
  );

  cliTest(
    "reports a cited review Evidence record that is absent as caller input",
    async ({ cli }) => {
      const absentEvidenceId = `ev_${"a".repeat(64)}`;
      const result = await runLedger(cli, {
        evidence_bundle: createEvidenceBundle([]),
        reviewed_obligations: [
          reviewedObligation("obl.review.absent", absentEvidenceId),
        ],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(
        callerInputFailure(
          `Reviewed obligation Evidence is missing: ${absentEvidenceId}`,
        ),
      );
    },
    20_000,
  );

  cliTest(
    "reports a duplicated Evidence record as caller input",
    async ({ cli }) => {
      const canonical = createEvidenceBundle([fixtureRecord("duplicated")]);
      const result = await runLedger(cli, {
        evidence_bundle: {
          ...canonical,
          records: [...canonical.records, ...canonical.records],
        },
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(
        callerInputFailure("Evidence bundle contains duplicate record IDs"),
      );
    },
    20_000,
  );

  cliTest(
    "builds the same Evidence-backed empty ledger through the CLI",
    async ({ cli }) => {
      const result = await runLedger(cli, {
        evidence_bundle: createEvidenceBundle([]),
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        operation: "build_reconstruction_obligation_ledger",
        predicate_type: "rea.reconstruction-obligation-ledger",
        normalized_result: {
          schema: "ReconstructionObligationLedger",
          status: "unknown",
          summary: { total: 0 },
        },
      });
    },
    20_000,
  );
});
