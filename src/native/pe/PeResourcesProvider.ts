import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { PeResourcesPort } from "../../application/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { InspectPeResourcesInput } from "../../domain/native/peResources.js";
import { err, ok } from "../../domain/result.js";
import { PE_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import { stableFileFailure } from "../stableFileFailure.js";
import { parsePeResources } from "./PeResourceParser.js";

/** Portable parser over one bounded, identity-checked regular file. */
export class PeResourcesProvider implements PeResourcesPort {
  readonly identity = PE_RESOURCES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
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
        await parsePeResources(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          options?.signal,
        ),
      );
    } catch (cause) {
      return err(
        stableFileFailure(
          cause,
          {
            operation: "inspect_pe_resources",
            providerId: PE_RESOURCES_PROVIDER.id,
            path: input.path,
            limits: {
              max_file_bytes: input.max_file_bytes,
              max_entries: input.max_entries,
            },
            subject: "PE image",
          },
          options?.signal,
        ),
      );
    }
  }
}
