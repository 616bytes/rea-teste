import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { ApkSigningBlockError } from "../domain/apkSignature/apkSigningBlock.js";
import { APK_SIGNATURE_LIMITS } from "./ApkSignatureRelease.js";

const OPERATION = "inspect_apk_signature";

const inputError = (message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: ["path"], reason: "invalid_value", message },
  ]);

/** Map a tagged signing-block framing failure to the shared analysis error algebra. */
export const mapApkBlockError = (
  error: ApkSigningBlockError,
  path: string,
): AnalysisError => {
  switch (error.kind) {
    case "not-a-zip":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `The selected file is not a ZIP/APK (${error.detail}).`,
        { remediationAction: "Select a local .apk/.zip/.aab archive." },
      );
    case "zip64-unsupported":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `This archive uses a Zip64 structure this reader does not decode (${error.detail}).`,
      );
    case "truncated":
      return inputError(
        `Archive ended before a structure completed at byte ${String(error.offset)}.`,
      );
    case "malformed-block":
      return inputError(
        `Malformed APK Signing Block at byte ${String(error.offset)}: ${error.detail}.`,
      );
    case "budget-exceeded":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        `APK Signing Block declares more ${error.resource} than the ${String(error.declared)} limit.`,
        { maximum_pairs: error.declared },
      );
  }
};

/** Preserve lifecycle failures and distinguish cancellation, access, integrity and limits. */
export const apkSignatureFailure = (
  cause: unknown,
  path: string,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
    return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      reason,
      { max_input_bytes: APK_SIGNATURE_LIMITS.inputBytes },
      {
        cause,
        remediationAction:
          "The size budget is fixed; select a smaller archive.",
      },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, reason, { cause });
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
      cause,
    });
  return new AnalysisInputError(OPERATION, { cause }, [
    { path: ["path"], reason: "invalid_value", message: reason },
  ]);
};
