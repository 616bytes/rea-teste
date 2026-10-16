import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
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

/**
 * Map a tagged DEX parse failure to the shared analysis error algebra. `path`
 * names the member (`archive!entry` inside an APK/ZIP); `limitations` are facts
 * about members already read that the refusal must still carry.
 */
export const mapDexParseError = (
  error: DexFileParseError,
  path: string,
  limitations: readonly string[] = [],
): AnalysisError => {
  const context = limitations.length === 0 ? "" : ` ${limitations.join(" ")}`;
  switch (error.kind) {
    case "bad-magic":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `${path} does not begin with the DEX magic (dex\\n0NN).${context}`,
        {
          remediationAction:
            "Select a .dex file, or pass entry to select a classesN.dex inside an APK/ZIP.",
        },
      );
    case "compact-dex":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `${path} is a compact dex (cdex) extracted from a vdex; it is a device-optimized format.${context}`,
        {
          remediationAction:
            "Provide a canonical .dex (e.g. from the APK), not an on-device odex/vdex/cdex.",
        },
      );
    case "reverse-endian":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `${path} declares the reverse-endian tag, which ART itself rejects; it is not read.${context}`,
      );
    case "unsupported-version":
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `${path}: DEX format version ${error.version} is not supported (reads 035, 037-040).${context}`,
      );
    case "bad-header":
      return inputError(
        "invalid_format",
        `${path}: malformed DEX header: ${error.detail}.${context}`,
      );
    case "truncated":
      return inputError(
        "invalid_format",
        `${path}: DEX ended before a structure completed at byte ${String(error.offset)}.${context}`,
      );
    case "budget-exceeded":
      return inputError(
        "invalid_value",
        `${path}: declared ${error.resource} count (${String(error.declared)}) exceeds the remaining ${String(error.remaining)} bytes at byte ${String(error.offset)}.${context}`,
      );
    case "invalid-index":
      return inputError(
        "invalid_value",
        `${path}: DEX offset ${String(error.index)} is outside the file bound ${String(error.bound)}.${context}`,
      );
  }
};

/** Preserve lifecycle failures and distinguish cancellation, access, integrity and limits. */
export const dexFileFailure = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  // A failed descriptor close keeps the read's primary failure (or
  // cancellation) and binds its cleanup lease, so close() retries it.
  const error =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? withCleanupFacts(
          primaryFileFailure(cause.fileCleanupFailure.outcome.cause, path),
          cause,
        )
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? withCleanupFacts(
            new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
            cause,
          )
        : primaryFileFailure(cause, path);
  bindArtifactFileCleanup(cause, error);
  return error;
};

/** Attach a failed close as a cleanup fact to a primary failure. */
const withCleanupFacts = (
  primary: AnalysisError,
  cause: ArtifactReaderFailure,
): AnalysisError =>
  cause.cleanup === undefined
    ? primary
    : analysisErrorWithCleanupFailure(
        primary,
        new ProviderCleanupError(
          DEX_PROVIDER_IDENTITY.id,
          cause.cleanup.resources,
          { reason: cause.cleanup.reason },
          { cause, operation: OPERATION },
        ),
        OPERATION,
      );

const primaryFileFailure = (cause: unknown, path: string): AnalysisError => {
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

/**
 * Map a refused summary/detail to the shared error algebra. `limitations` are
 * facts about the members already read (e.g. unread trailing bytes) that a
 * refusal must still carry.
 */
export const mapDexWorkError = (
  error: DexWorkError,
  label: string,
  limitations: readonly string[] = [],
): AnalysisError => {
  const context = limitations.length === 0 ? "" : ` ${limitations.join(" ")}`;
  switch (error.kind) {
    case "cancelled":
      return new AnalysisCancelledError(OPERATION);
    case "work-budget-exceeded":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "cpu",
        `Decoding the debug metadata of ${label} needs more than ${String(error.limit)} work units (proportional to its size); a well-formed DEX never does, so it was refused rather than run unbounded.${context}`,
        { max_work_units: error.limit },
      );
    case "malformed-class-data":
      return new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["class_descriptor"],
          reason: "invalid_value",
          message: `${label}: the selected class's class_data at byte ${String(error.classDataOff)} cannot be read; its methods' debug metadata is unknown.${context}`,
        },
      ]);
    case "unreadable-class-identity":
      return new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["class_descriptor"],
          reason: "invalid_value",
          message: `${label}: ${String(error.count)} class_def entr${error.count === 1 ? "y has" : "ies have"} an unreadable type identity, so whether this DEX member defines the class (once) is unknown, not absent.${context}`,
        },
      ]);
    case "duplicate-class-definition":
      return new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["class_descriptor"],
          reason: "invalid_value",
          message: `${label}: ${String(error.count)} class_def entries declare the class in one DEX member; the DEX is malformed and the definition is ambiguous.${context}`,
        },
      ]);
    case "output-budget-exceeded":
      return new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        `${label}: the class detail would serialise to about ${String(error.projectedBytes)} bytes, over the ${String(error.limit)}-byte output budget; refused before building it.${context}`,
        { maximum_output_bytes: error.limit },
      );
  }
};
