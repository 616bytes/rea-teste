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
import type { DexWorkError } from "../domain/dex/dexDebugMetadata.js";
import type { DexFileParseError } from "../domain/dex/dexFile.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { DEX_LIMITS, DEX_PROVIDER_IDENTITY } from "./DexFileRelease.js";

const OPERATION = "inspect_dex_debug_metadata";

const inputError = (
  reason: "invalid_format" | "invalid_value",
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: ["path"], reason, message },
  ]);

/** Map a tagged DEX parse failure to the shared analysis error algebra. */
export const mapDexParseError = (
  error: DexFileParseError,
  path: string,
): AnalysisError => {
  switch (error.kind) {
    case "bad-magic":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        "The selected file does not begin with the DEX magic (dex\\n0NN).",
        {
          remediationAction:
            "Select a .dex file, or pass entry to select a classesN.dex inside an APK/ZIP.",
        },
      );
    case "compact-dex":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        "This is a compact dex (cdex) extracted from a vdex; it is a device-optimized format.",
        {
          remediationAction:
            "Provide a canonical .dex (e.g. from the APK), not an on-device odex/vdex/cdex.",
        },
      );
    case "reverse-endian":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        "This DEX declares the reverse-endian tag, which ART itself rejects; it is not read.",
      );
    case "unsupported-version":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `DEX format version ${error.version} is not supported (reads 035, 037-040).`,
      );
    case "bad-header":
      return inputError(
        "invalid_format",
        `Malformed DEX header: ${error.detail}.`,
      );
    case "truncated":
      return inputError(
        "invalid_format",
        `DEX ended before a structure completed at byte ${String(error.offset)}.`,
      );
    case "budget-exceeded":
      return inputError(
        "invalid_value",
        `Declared ${error.resource} count (${String(error.declared)}) exceeds the remaining ${String(error.remaining)} bytes at byte ${String(error.offset)}.`,
      );
    case "invalid-index":
      return inputError(
        "invalid_value",
        `DEX offset ${String(error.index)} is outside the file bound ${String(error.bound)}.`,
      );
  }
};

/** Preserve lifecycle failures and distinguish cancellation, access, integrity and limits. */
export const dexFileFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const cleanup =
    cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
      ? { cleanup: cause.cleanup }
      : {};
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
    return new AnalysisCancelledError(OPERATION, { cause, ...cleanup });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      reason,
      { max_input_bytes: DEX_LIMITS.inputBytes },
      {
        cause,
        ...cleanup,
        remediationAction:
          "The size budget is fixed; select a smaller artifact.",
      },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, reason, {
      cause,
      ...cleanup,
    });
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
      cause,
      ...cleanup,
    });
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" ||
      cause.code === "ENOTDIR" ||
      cause.code === "ELOOP")
  )
    return new AnalysisInputError(OPERATION, { cause, ...cleanup }, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: `No regular file can be read at the selected path (${String(cause.code)}): ${path}.`,
      },
    ]);
  // A typed reader failure (format, path, io, unavailable) describes the
  // selected artifact, so it stays a caller-facing input error.
  if (cause instanceof ArtifactReaderFailure)
    return new AnalysisInputError(OPERATION, { cause, ...cleanup }, [
      { path: ["path"], reason: "invalid_value", message: reason },
    ]);
  // Anything else (e.g. a RangeError) is an adapter defect, never blamed on
  // the caller's input.
  return new ProviderAdapterError(DEX_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    ...cleanup,
    diagnostics: { path, reason },
  });
};

/** Map a refused summary/detail to the shared error algebra. */
export const mapDexWorkError = (error: DexWorkError): AnalysisError => {
  switch (error.kind) {
    case "cancelled":
      return new AnalysisCancelledError(OPERATION);
    case "work-budget-exceeded":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "cpu",
        `Decoding the selected DEX debug metadata needs more than ${String(error.limit)} debug opcodes; refused rather than run unbounded.`,
        { max_debug_opcodes: error.limit },
        {
          remediationAction:
            "Select one member with entry, or one class with class_descriptor.",
        },
      );
    case "output-budget-exceeded":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        `The class detail would serialise to about ${String(error.projectedBytes)} bytes, over the ${String(error.limit)}-byte output budget; refused before building it.`,
        { maximum_output_bytes: error.limit },
      );
  }
};
