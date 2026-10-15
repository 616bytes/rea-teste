import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { clusterArtifactFamilies } from "../domain/artifactFamilyClustering.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { resolveArtifactFamilyClusteringEvidence } from "../application/artifacts/ArtifactFamilyClusteringEvidence.js";
import { recordDerivedEvidence } from "./recordDerivedEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../application/InvestigationProviders.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Register Evidence-backed deterministic artifact family clustering. */
export const registerArtifactFamilyClusteringTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"cluster_artifacts">>,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  const evidenceById = (evidenceId: string) =>
    session.evidenceForAnalysis?.(evidenceId) ??
    session.evidenceById(evidenceId);
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const members = input.members.map((member) => {
                const supplied = parseEvidence(member.evidence);
                const resolved = resolveArtifactFamilyClusteringEvidence(
                  supplied,
                  evidenceById,
                );
                if (!resolved.ok) throw resolved.error;
                return { label: member.label, evidence: resolved.value };
              });
              const clustering = clusterArtifactFamilies(members, {
                ...(input.shared_member_minimum === undefined
                  ? {}
                  : { sharedMemberMinimum: input.shared_member_minimum }),
                offset: input.offset,
                limit: input.limit,
              });
              return { members, clustering };
            },
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const { members, clustering } = computed.value;
          for (const member of members) {
            const recorded = session.recordEvidence(member.evidence);
            if (!recorded.ok)
              return server.delivery.toCallToolResult(recorded, contract);
          }
          const memberEvidenceIds = members.map(
            (member) => member.evidence.evidence_id,
          );
          const evidence = createEvidence(
            undefined,
            ARTIFACT_COMPARISON_PROVIDER,
            {
              predicateType: "rea.artifact-family-clustering",
              operation: contract.name,
              parameters: {
                member_evidence_ids: memberEvidenceIds,
                shared_member_minimum:
                  clustering.coverage.shared_member_minimum,
                // The retained record states its own page, so reopening this
                // Evidence never implies a wider family list than it holds.
                offset: clustering.coverage.families_offset,
                limit: clustering.coverage.families_limit,
              },
              result: jsonValueSchema.parse(clustering),
              confidence: "derived",
              authority: "analyst-inference",
              limitations: clustering.limitations,
              evidenceLinks: memberEvidenceIds,
            },
          );
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            // Unplaced members stay visible in the result itself; no residual
            // unknown is opened until a workflow needs one to be tracked.
            recordDerivedEvidence(session, evidence, undefined),
          );
        },
      ),
  );
};
