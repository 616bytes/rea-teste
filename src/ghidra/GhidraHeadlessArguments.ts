import { posix, win32 } from "node:path";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { GhidraAnalysisCache } from "./GhidraAnalysisCache.js";
import { GHIDRA_SEED_SCRIPT } from "./GhidraAnalysisSeeds.js";

/** Paths encoded into one bounded analyzeHeadless invocation. */
export interface GhidraHeadlessArgumentOptions {
  readonly analysisCache?: GhidraAnalysisCache;
  readonly platform?: NodeJS.Platform;
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly bridgeScriptPath: string;
  readonly descriptorPath: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
  readonly psp?: true;
  readonly mipsSoftFloat?: true;
  readonly dosMz?: true;
  readonly dosCom?: true;
  readonly rawBinary?: {
    readonly languageId: string;
    readonly compilerSpecId: string;
    readonly baseAddr: string;
  };
  readonly languageOverride?: GhidraLanguageOverride;
  /** Auto-analyzers disabled by the pre-analysis options script. */
  readonly disabledAnalyzers?: readonly string[];
  /** Canonical seed snapshot passed to the pre-analysis seed script. */
  readonly seedPath?: string;
}

export interface GhidraPostAnalysisScript {
  readonly name: string;
  readonly arguments: readonly string[];
}

export interface GhidraAnalysisPlan {
  readonly required: boolean;
  readonly postAnalysisScripts: readonly GhidraPostAnalysisScript[];
}

function validateImport(options: GhidraHeadlessArgumentOptions): void {
  const override = options.languageOverride;
  const rawBinary = options.rawBinary;
  if (
    options.psp === true &&
    (options.dosMz === true ||
      options.dosCom === true ||
      override !== undefined)
  )
    throw new Error(
      "A PSP ELF import cannot be combined with DOS or a generic Ghidra language override.",
    );
  if (options.psp === true && rawBinary !== undefined)
    throw new Error(
      "A PSP ELF import cannot be combined with a raw-binary import.",
    );
  if (
    options.mipsSoftFloat === true &&
    (options.psp === true ||
      options.dosMz === true ||
      options.dosCom === true ||
      rawBinary !== undefined)
  )
    throw new Error(
      "MIPS soft-float storage applies only to a generic MIPS ELF import.",
    );
  if (
    override !== undefined &&
    (options.dosMz === true || options.dosCom === true)
  )
    throw new Error(
      "A Ghidra language override cannot be combined with a DOS import.",
    );
  if (override !== undefined && rawBinary !== undefined)
    throw new Error(
      "A Ghidra language override cannot be combined with a raw-binary import.",
    );
  if (
    rawBinary !== undefined &&
    (options.dosMz === true || options.dosCom === true)
  )
    throw new Error(
      "A raw-binary import cannot be combined with a DOS import.",
    );
}

function loaderArguments(
  options: GhidraHeadlessArgumentOptions,
): readonly string[] {
  if (options.dosMz)
    return [
      "-loader",
      "MzLoader",
      "-processor",
      "x86:LE:16:Real Mode",
      "-cspec",
      "default",
    ];
  if (options.dosCom)
    return [
      "-loader",
      "BinaryLoader",
      "-loader-baseAddr",
      "1000:0100",
      "-processor",
      "x86:LE:16:Real Mode",
      "-cspec",
      "default",
    ];
  if (options.psp)
    return [
      "-loader",
      "PspElfLoader",
      "-processor",
      "Allegrex:LE:32:default",
      "-cspec",
      "default",
    ];
  if (options.rawBinary) {
    const raw = options.rawBinary;
    return [
      "-loader",
      "BinaryLoader",
      "-loader-baseAddr",
      raw.baseAddr,
      "-processor",
      raw.languageId,
      "-cspec",
      raw.compilerSpecId,
    ];
  }
  if (options.languageOverride) {
    const language = options.languageOverride;
    return [
      "-processor",
      language.languageId,
      ...(language.compilerSpecId === undefined
        ? []
        : ["-cspec", language.compilerSpecId]),
    ];
  }
  return [];
}

function preparationScripts(
  options: GhidraHeadlessArgumentOptions,
  script: (name: string) => string,
): readonly string[] {
  const args: string[] = [];
  if (options.dosCom)
    args.push("-preScript", script("ReaGhidraPrepareCom.java"));
  if (options.rawBinary)
    args.push(
      "-preScript",
      script("ReaGhidraPrepareRaw.java"),
      options.rawBinary.languageId,
      options.rawBinary.baseAddr,
    );
  // Import preparation precedes seeds; analyzer options are applied before auto-analysis.
  if (options.seedPath)
    args.push("-preScript", script(GHIDRA_SEED_SCRIPT), options.seedPath);
  if (options.disabledAnalyzers?.length)
    args.push(
      "-preScript",
      script("ReaGhidraAnalysisOptions.java"),
      options.disabledAnalyzers.join(","),
    );
  return args;
}

/** Work the bridge performs after its owned background analysis completes. */
export function ghidraAnalysisPlan(
  options: GhidraHeadlessArgumentOptions,
): GhidraAnalysisPlan {
  const cache = options.analysisCache;
  const scripts: GhidraPostAnalysisScript[] = [];

  if (cache?.archivePath === undefined) {
    if ((options.platform ?? process.platform) !== "win32")
      scripts.push({ name: "ReaGhidraNoReturnFix.java", arguments: [] });

    if (options.mipsSoftFloat)
      scripts.push({ name: "ReaGhidraMipsSoftFloat.java", arguments: [] });
  }

  if (cache !== undefined)
    scripts.push({
      name: "ReaGhidraAnalysisCache.java",
      arguments: [cache.descriptorPath],
    });

  return {
    required: cache?.archivePath === undefined,
    postAnalysisScripts: scripts,
  };
}

function importArguments(
  options: GhidraHeadlessArgumentOptions,
): readonly string[] {
  const archivePath = options.analysisCache?.archivePath;
  if (archivePath !== undefined) return ["-import", archivePath];

  return ["-import", options.targetPath, ...loaderArguments(options)];
}

/** Full analysis on a miss; reopen a verified complete database without repeating analysis on a hit. */
export function ghidraHeadlessArguments(
  options: GhidraHeadlessArgumentOptions,
): readonly string[] {
  validateImport(options);
  const paths =
    (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const directory = paths.dirname(options.bridgeScriptPath);
  const script = (name: string): string => paths.join(directory, name);
  const common = [
    "-readOnly",
    "-deleteProject",
    // The bridge owns analysis so it can serve procedure snapshots while the
    // analyzers run. Preparation scripts still execute before it starts.
    "-noanalysis",
    "-log",
    options.ghidraLogPath,
    "-scriptlog",
    options.scriptLogPath,
    "-scriptPath",
    directory,
  ];
  return [
    options.projectRoot,
    "rea-project",
    ...importArguments(options),
    ...common,
    ...(options.analysisCache?.archivePath === undefined
      ? preparationScripts(options, script)
      : []),
    // Absolute packaged script paths prevent scripts in the caller's directory from shadowing them.
    "-postScript",
    options.bridgeScriptPath,
    options.descriptorPath,
  ];
}
