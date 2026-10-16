import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import {
  GHIDRA_PROJECT_FILE_SUFFIX,
  ghidraProgramPathSchema,
  type GhidraPersistentProject,
} from "../config/ghidraPersistentProject.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { isGhidraMipsSoftFloatTarget } from "./GhidraMipsProfile.js";
import { isGhidraPspTarget } from "./GhidraPspProfile.js";

/** `analysis_profile.parameters.import_mode` of a persistent-project session. */
export const GHIDRA_PERSISTENT_IMPORT_MODE = "persistent-project-read-only";
export const GHIDRA_PERSISTENT_PROJECT_FORMAT =
  "rea-ghidra-persistent-project-v1";
const PROJECT_RECORDED = "caller-project-recorded";

/** Caller-selected project and Program committed into the analysis profile. */
export const ghidraPersistentProjectCommitmentSchema = z.strictObject({
  format: z.literal(GHIDRA_PERSISTENT_PROJECT_FORMAT),
  /** Resolved `.gpr` path; analyzeHeadless opens the project beside it. */
  project_file: z.string().refine(isAbsolute, "Project path must be absolute"),
  configured_project_file: z
    .string()
    .refine(isAbsolute, "Project path must be absolute"),
  program: ghidraProgramPathSchema,
  /** The Program's recorded executable SHA-256 must equal the target digest. */
  identity: z.literal("program-executable-sha256-v1"),
});
export type GhidraPersistentProjectCommitment = z.infer<
  typeof ghidraPersistentProjectCommitmentSchema
>;

/** The persistent-project identity the bridge reports in its handshake. */
export const ghidraPersistentProjectReportSchema = z.strictObject({
  mode: z.literal(GHIDRA_PERSISTENT_IMPORT_MODE),
  program: z.string().min(1).max(4096),
  /** Ghidra's recorded "Executable SHA256"; null when the Program has none. */
  executable_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});
export type GhidraPersistentProjectReport = z.infer<
  typeof ghidraPersistentProjectReportSchema
>;

/** Why a target cannot be served from a persistent project, or null. */
export const ghidraPersistentProjectUnsupportedReason = (
  target: BinaryTarget,
  pinnedLanguage: boolean,
): string | null => {
  if (target.kind !== "executable")
    return "A persistent Ghidra project serves executable targets only.";
  if (
    target.format === "raw-binary" ||
    target.format === "dos-mz" ||
    target.format === "dos-com" ||
    isGhidraPspTarget(target) ||
    isGhidraMipsSoftFloatTarget(target) ||
    pinnedLanguage
  )
    return "This target's Ghidra profile requires REA's own import preparation (loader, language, or repair scripts), which a persistent project opened without import cannot establish. Unset REA_GHIDRA_PROJECT and REA_GHIDRA_PROGRAM to use the ephemeral import.";
  return null;
};

/** Resolve the configured project into an immutable profile commitment. */
export const resolveGhidraPersistentProject = async (
  configured: GhidraPersistentProject | undefined,
  target: BinaryTarget,
  pinnedLanguage: boolean,
): Promise<
  Result<
    GhidraPersistentProjectCommitment | undefined,
    AnalysisUnsupportedTargetError | ProviderAdapterError
  >
> => {
  if (configured === undefined) return ok(undefined);
  const unsupported = ghidraPersistentProjectUnsupportedReason(
    target,
    pinnedLanguage,
  );
  if (unsupported !== null)
    return err(
      new AnalysisUnsupportedTargetError(
        "resolve_analysis_profile",
        target.path,
        unsupported,
      ),
    );
  let projectFile: string;
  try {
    projectFile = await realpath(configured.projectFile);
    if (!projectFile.endsWith(GHIDRA_PROJECT_FILE_SUFFIX))
      throw new Error(
        `The resolved project marker is not a ${GHIDRA_PROJECT_FILE_SUFFIX} file`,
      );
    if (!(await stat(projectFile)).isFile())
      throw new Error("The project marker is not a regular file");
    const repository = `${projectFile.slice(0, -GHIDRA_PROJECT_FILE_SUFFIX.length)}.rep`;
    if (!(await stat(repository)).isDirectory())
      throw new Error("The project repository directory is missing");
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError("ghidra", "resolve_analysis_profile", {
        cause,
        diagnostics: {
          setting: "REA_GHIDRA_PROJECT",
          path: configured.projectFile,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
        userMessage:
          "REA_GHIDRA_PROJECT must name the .gpr file of an existing Ghidra project whose .rep directory sits beside it.",
      }),
    );
  }
  return ok({
    format: GHIDRA_PERSISTENT_PROJECT_FORMAT,
    project_file: projectFile,
    configured_project_file: configured.projectFile,
    program: configured.program,
    identity: "program-executable-sha256-v1",
  });
};

/**
 * Replace the ephemeral-import parameters with what this session can actually
 * claim: the caller's project, opened read-only and never re-analyzed.
 */
export const ghidraPersistentProjectParameters = (
  parameters: Readonly<Record<string, JsonValue>>,
  commitment: GhidraPersistentProjectCommitment,
): Record<string, JsonValue> => {
  const {
    analysis_options: _options,
    language_selection: _selection,
    entry_seed: _entrySeed,
    ...retained
  } = parameters;
  return {
    ...retained,
    import_mode: GHIDRA_PERSISTENT_IMPORT_MODE,
    persistent_project: { ...commitment },
    annotation_policy: "unsupported-read-only-project-v1",
    analyzer_preset: PROJECT_RECORDED,
    loader: PROJECT_RECORDED,
    language_id: PROJECT_RECORDED,
    compiler_spec_id: PROJECT_RECORDED,
    no_return_repair: "not-applied-persistent-project",
  };
};

/** Whether a committed project and the active configuration select the same Program. */
export const sameGhidraPersistentProject = (
  committed: GhidraPersistentProjectCommitment | undefined,
  configured: GhidraPersistentProject | undefined,
): boolean =>
  committed === undefined || configured === undefined
    ? committed === configured
    : committed.configured_project_file === configured.projectFile &&
      committed.program === configured.program;

/**
 * Fail closed unless the bridge opened the committed Program and Ghidra's
 * recorded executable digest equals the selected target.
 */
export const ghidraPersistentProjectFailure = (
  commitment: GhidraPersistentProjectCommitment | undefined,
  report: GhidraPersistentProjectReport | undefined,
  target: BinaryTarget,
  operation: AnalysisOperation,
): AnalysisUnsupportedTargetError | ProviderAdapterError | undefined => {
  if (commitment === undefined && report === undefined) return undefined;
  if (commitment === undefined || report === undefined)
    return new ProviderAdapterError("ghidra", operation, {
      diagnostics: {
        reason:
          commitment === undefined
            ? "The Ghidra session reported a persistent project that the profile did not commit."
            : "The Ghidra session did not report the committed persistent project.",
      },
    });
  if (report.program !== commitment.program)
    return new ProviderAdapterError("ghidra", operation, {
      diagnostics: {
        reason: `The Ghidra session opened ${report.program}, not the committed Program ${commitment.program}.`,
      },
    });
  if (report.executable_sha256 === target.sha256) return undefined;
  const recorded =
    report.executable_sha256 === null
      ? "records no executable SHA-256"
      : `records executable SHA-256 ${report.executable_sha256}`;
  return new AnalysisUnsupportedTargetError(
    operation,
    target.path,
    `The persistent Ghidra project Program ${commitment.program} in ${commitment.project_file} ${recorded}, but the selected target has SHA-256 ${target.sha256}. REA refuses to serve one artifact's analysis as another's.`,
    {
      remediationAction:
        "Open the executable this Program was imported from, or point REA_GHIDRA_PROJECT and REA_GHIDRA_PROGRAM at a Program imported from the selected target.",
    },
  );
};

/** Session limitations that keep project content distinct from this session's analysis. */
export const ghidraPersistentProjectLimitations = (
  commitment: GhidraPersistentProjectCommitment | undefined,
): readonly string[] =>
  commitment === undefined
    ? []
    : [
        `Ghidra opened Program ${commitment.program} from the caller-selected project ${commitment.project_file} read-only with -noanalysis; REA did not import or analyze the target in this session. The Program's recorded executable SHA-256 matched the selected target.`,
        "Functions, names, comments, data types, and other analysis state in the project were produced before this session by Ghidra analysis, scripts, or people. They are caller assertions, not Ghidra discoveries of this session.",
        "The project is never saved: in-memory changes are discarded on close and annotation operations are unavailable. Ghidra holds the project lock while the session is open, so another Ghidra instance cannot open it concurrently. Project edits made between sessions are not part of the analysis profile digest, so results are not replayed from snapshots.",
      ];
