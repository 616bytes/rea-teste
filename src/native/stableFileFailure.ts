import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/** One portable stable-file parser operation and its caller-visible budgets. */
export interface StableFileOperation {
  readonly operation: "inspect_pe_resources" | "inspect_packer_indicators";
  readonly providerId: string;
  readonly path: string;
  readonly limits: Readonly<Record<string, number>>;
  /** Format noun used in read failures, for example "PE image". */
  readonly subject: string;
}

const stableFileFailurePrimary = (
  cause: unknown,
  target: StableFileOperation,
  signal: AbortSignal | undefined,
): AnalysisError => {
  const { operation } = target;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      operation,
      target.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(operation, { cause });

  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        target.limits,
        { cause },
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
      return new AnalysisAccessDeniedError(operation, target.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected ${target.subject} could not be read (${cause.code}): ${target.path}.`,
        },
      ]);
  }

  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : `${target.subject} inspection failed.`,
    { cause },
  );
};

/** Map stable-read and parser failures to typed errors, retaining cleanup failures. */
export const stableFileFailure = (
  cause: unknown,
  target: StableFileOperation,
  signal: AbortSignal | undefined,
): AnalysisError => {
  const primary = stableFileFailurePrimary(cause, target, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    target.providerId,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: target.operation, cause },
  );
  return analysisErrorWithCleanupFailure(primary, cleanup, target.operation);
};
