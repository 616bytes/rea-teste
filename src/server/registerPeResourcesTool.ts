import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import type { PackerIndicatorsService } from "../application/binaryDiagnostics/PackerIndicatorsService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

type StableFileService = Pick<
  PeResourcesService | PackerIndicatorsService,
  "inspect"
>;

const registerStableFileTool = (
  name: "inspect_pe_resources" | "inspect_packer_indicators",
  server: EvidenceMcpServer,
  service: StableFileService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract(name);
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};

/** Register the explicit-file PE resource workflow and retain its complete Evidence. */
export const registerPeResourcesTool = (
  server: EvidenceMcpServer,
  service: PeResourcesService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void =>
  registerStableFileTool(
    "inspect_pe_resources",
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );

/** Register static PE/ELF packer identification and retain its complete Evidence. */
export const registerPackerIndicatorsTool = (
  server: EvidenceMcpServer,
  service: PackerIndicatorsService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void =>
  registerStableFileTool(
    "inspect_packer_indicators",
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
