import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { deriveUiStateTransitionWithSources } from "../application/uiStateTransition/UiStateTransitionService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { ok } from "../domain/result.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { recordSessionEvidenceSources } from "./sessionEvidence.js";
import {
  applicationValidatedInputSchema,
  toolRegistrationOptions,
} from "./toolRegistrationOptions.js";

/** Bind read-only UI-state derivation to the session's exact Evidence owner. */
export const registerUiStateTransitionTool = (
  server: EvidenceMcpServer,
  logger: Logger,
  evidenceById?: EvidenceLookup,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("derive_ui_state_transition");
  const registration = toolRegistrationOptions(contract);
  const handler = createEvidenceToolHandler(
    server,
    async (input, options) => {
      const result = deriveUiStateTransitionWithSources(
        input,
        evidenceById,
        options,
      );
      if (!result.ok) return result;
      const recorded = recordSessionEvidenceSources(
        recordEvidence,
        result.value.sources,
      );
      return recorded.ok ? ok(result.value.evidence) : recorded;
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    {
      ...registration,
      inputSchema: applicationValidatedInputSchema(registration.inputSchema),
    },
    handler(contract),
  );
};
