import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { deriveUiStateTransition } from "../application/uiStateTransition/UiStateTransitionService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
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
    (input, options) =>
      Promise.resolve(deriveUiStateTransition(input, evidenceById, options)),
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
