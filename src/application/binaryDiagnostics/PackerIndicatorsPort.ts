import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPackerIndicatorsInput,
  PackerIndicators,
} from "../../domain/native/packerIndicators.js";
import type { Result } from "../../domain/result.js";

/** Stable read and static PE/ELF packer indicators, without execution. */
export interface PackerIndicatorsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  inspect(
    input: InspectPackerIndicatorsInput,
    options?: ExecutionOptions,
  ): Promise<Result<PackerIndicators, AnalysisError>>;
}
