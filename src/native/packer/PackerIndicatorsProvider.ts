import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { PackerIndicatorsPort } from "../../application/binaryDiagnostics/PackerIndicatorsPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { InspectPackerIndicatorsInput } from "../../domain/native/packerIndicators.js";
import { err, ok } from "../../domain/result.js";
import { PACKER_INDICATORS_PROVIDER } from "../../application/InvestigationProviders.js";
import { stableFileFailure } from "../stableFileFailure.js";
import { parsePackerIndicators } from "./PackerIndicatorParser.js";

/** Read-only packer indicators over one bounded, identity-checked regular file. */
export class PackerIndicatorsProvider implements PackerIndicatorsPort {
  readonly identity = PACKER_INDICATORS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(
    input: InspectPackerIndicatorsInput,
    options?: ExecutionOptions,
  ) {
    try {
      const snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      return ok(
        parsePackerIndicators(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          options?.signal,
        ),
      );
    } catch (cause) {
      return err(
        stableFileFailure(
          cause,
          {
            operation: "inspect_packer_indicators",
            providerId: PACKER_INDICATORS_PROVIDER.id,
            path: input.path,
            limits: { max_file_bytes: input.max_file_bytes },
            subject: "PE or ELF image",
          },
          options?.signal,
        ),
      );
    }
  }
}
