import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import type { NeExecutablePort } from "../../application/binaryDiagnostics/NeExecutablePort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_NE_FILE_BYTES,
  MAX_INSPECT_NE_TABLE_ROWS,
  type InspectNeExecutableInput,
} from "../../domain/native/neExecutable.js";
import { err, ok } from "../../domain/result.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { NE_EXECUTABLE_PROVIDER } from "../../application/InvestigationProviders.js";
import { parseNeExecutable } from "./NeExecutableParser.js";

/** Portable parser over one bounded, identity-checked regular file. */
export class NeExecutableProvider implements NeExecutablePort {
  readonly identity = NE_EXECUTABLE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(input: InspectNeExecutableInput, options?: ExecutionOptions) {
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
        await parseNeExecutable(
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
      return err(neExecutableFailure(cause, input, options?.signal));
    }
  }
}

/**
 * Remediation for a caller-selected budget refusal. At the schema ceiling
 * there is no value left to raise the bound to, so the advice names the
 * ceiling instead of an impossible raise.
 */
export const neInputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectNeExecutableInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_NE_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_NE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_rows >= MAX_INSPECT_NE_TABLE_ROWS
      ? `The image exceeds the ${String(MAX_INSPECT_NE_TABLE_ROWS)}-row table ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_rows above ${String(input.max_rows)} or select a smaller artifact; the limit is the caller-selected table row budget.`;

const neExecutableFailurePrimary = (
  cause: unknown,
  input: InspectNeExecutableInput,
  signal: AbortSignal | undefined,
) => {
  const operation = "inspect_ne_executable";
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      operation,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(operation, { cause });

  if (cause instanceof ArtifactReaderFailure) {
    // An input byte budget is a file-size bound, not a memory constraint, and
    // a row budget is a capacity bound. Report what was actually exceeded.
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_rows: input.max_rows,
        },
        {
          cause,
          // Both bounds are caller-selected and deterministic for the same
          // input, so waiting for an active analysis cannot help.
          ...(cause.boundary === undefined || cause.boundary === "memory"
            ? {}
            : {
                retryable: false,
                remediationAction: neInputBudgetRemediation(
                  cause.boundary,
                  input,
                ),
              }),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }

  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected NE image could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }

  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error ? cause.message : "NE artifact inspection failed.",
    { cause },
  );
};

const neExecutableFailure = (
  cause: unknown,
  input: InspectNeExecutableInput,
  signal: AbortSignal | undefined,
) => {
  const primary = neExecutableFailurePrimary(cause, input, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    NE_EXECUTABLE_PROVIDER.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: "inspect_ne_executable", cause },
  );
  return analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    "inspect_ne_executable",
  );
};
