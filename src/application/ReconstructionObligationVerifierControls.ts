import type { Evidence } from "../domain/evidence.js";
import { digestSchema } from "../domain/digests.js";
import type { ReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";
import type { ReconstructionObligationCandidate } from "./ReconstructionObligationCandidates.js";
import { evidenceAuthoritySupportsProof } from "./ReconstructionObligationAuthority.js";
import { addObligationDiagnostic as addDiagnostic } from "./ReconstructionObligationLedgerDiagnostics.js";

type Binding = NonNullable<ReconstructionObligation["binding"]>;
type Verifier = NonNullable<Binding["verifier"]>;
type Control = NonNullable<Verifier["negative_controls"]>[number];
type Diagnostic = ReconstructionObligation["diagnostics"][number];

interface ControlContext {
  readonly candidate: ReconstructionObligationCandidate;
  readonly binding: Binding;
  readonly verifier: Verifier;
  readonly positiveEvidence: Evidence | undefined;
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly diagnostics: Diagnostic[];
}

/** A failed control counts only when its result authenticates the declared defect. */
export const evaluateVerifierControls = (context: ControlContext): void => {
  const { verifier, diagnostics } = context;
  const controls = verifier.negative_controls ?? [];
  if (controls.length === 0) {
    addDiagnostic(
      diagnostics,
      "unchallenged-verifier",
      "No failing negative control demonstrates that this verifier can reject a deliberately wrong candidate.",
    );
    return;
  }
  if (verifier.implementation_sha256 === undefined) {
    addDiagnostic(
      diagnostics,
      "unchallenged-verifier",
      "Negative controls require the verifier implementation digest in the binding and its Evidence.",
    );
    return;
  }
  const outcomes = controls.map((control) => evaluateControl(context, control));
  if (!outcomes.includes("failed"))
    addDiagnostic(
      diagnostics,
      "unchallenged-verifier",
      "No authenticated failing negative control demonstrates that this verifier can reject a deliberately wrong candidate.",
    );
};

const evaluateControl = (
  context: ControlContext,
  control: Control,
): "failed" | "unverified" => {
  const { candidate, verifier, evidence, diagnostics } = context;
  const candidateIssue = controlCandidateIssue(context, control);
  if (candidateIssue !== null) {
    addDiagnostic(diagnostics, "invalid-control-candidate", candidateIssue);
    return "unverified";
  }
  const result = evidence.get(control.result_evidence_id);
  if (result === undefined) {
    addDiagnostic(
      diagnostics,
      "missing-control-result",
      `Negative control result Evidence is absent: ${control.result_evidence_id}.`,
    );
    return "unverified";
  }
  if (control.status !== "pass" && control.status !== "fail")
    return "unverified";
  const authenticated = evidenceAuthoritySupportsProof(
    result,
    verifier.authority,
    {
      obligationId: candidate.obligation_id,
      verifierId: verifier.verifier_id,
      claimId: verifier.claim_id,
      verifierSha256: verifier.implementation_sha256 ?? "",
      passed: control.status === "pass",
      defect: control.defect,
      ...(control.status === "fail"
        ? { failureKind: "behavior-mismatch" }
        : {}),
      ...(control.candidate.kind === "fixture"
        ? { fixtureId: control.candidate.fixture_id }
        : { candidateSha256: control.candidate.sha256 }),
    },
  );
  if (!authenticated) {
    addDiagnostic(
      diagnostics,
      "weak-control-evidence",
      `Negative control ${control.candidate.kind} result lacks comparable authenticated ${verifier.authority} Evidence for its declared outcome.`,
    );
    return "unverified";
  }
  if (control.status === "fail") return "failed";
  addDiagnostic(
    diagnostics,
    "vacuous-verifier",
    `Verifier also passes the deliberately wrong ${control.candidate.kind} candidate.`,
  );
  return "unverified";
};

const controlCandidateIssue = (
  context: ControlContext,
  control: Control,
): string | null => {
  const { candidate, binding, positiveEvidence } = context;
  if (control.candidate.kind === "fixture") {
    const fixtureId = control.candidate.fixture_id;
    return binding.fixtures.some(({ fixture_id: id }) => id === fixtureId)
      ? "A negative control must identify a different fixture from the passing reconstruction."
      : null;
  }
  const positiveResult = positiveEvidence?.normalized_result;
  const positiveCandidateSha256Value =
    typeof positiveResult === "object" &&
    positiveResult !== null &&
    !Array.isArray(positiveResult)
      ? positiveResult.candidate_sha256
      : undefined;
  const parsedPositiveCandidate = digestSchema.safeParse(
    positiveCandidateSha256Value,
  );
  if (!parsedPositiveCandidate.success)
    return "An artifact control requires a valid positive candidate SHA-256 in verifier result Evidence.";
  return control.candidate.sha256 === binding.owner.owner_sha256 ||
    control.candidate.sha256 === candidate.target.artifact_sha256 ||
    control.candidate.sha256 === parsedPositiveCandidate.data
    ? "A negative control must identify a different artifact from the passing reconstruction or original artifact."
    : null;
};
