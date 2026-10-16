import {
  prepareGhidraAnalysisCache,
  type GhidraAnalysisCache,
} from "./GhidraAnalysisCache.js";
import {
  ghidraAnalysisPlan,
  ghidraHeadlessArguments,
  type GhidraHeadlessArgumentOptions,
} from "./GhidraHeadlessArguments.js";
export {
  ghidraHeadlessArguments,
  type GhidraHeadlessArgumentOptions,
} from "./GhidraHeadlessArguments.js";
import { parseGhidraJavaProperties } from "./GhidraJavaProperties.js";
import {
  snapshotGhidraAnalysisSeeds,
  type GhidraSeedCommitment,
} from "./GhidraAnalysisSeeds.js";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { windowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";
import {
  quoteWindowsBatchToken,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { execFileOutputFailure } from "../process/ExecFileOutput.js";
import { boundedUtf8Text } from "../process/boundedUtf8Text.js";
import { redactCapturedTransportCredential } from "../process/ProviderDiagnosticRedaction.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  type ProcessCleanupResult,
} from "../process/ProcessOwnership.js";
import {
  type ProviderProcessLaunch,
  type SpawnedOwnedProviderProcess,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";
import { ghidraJavaLaunch } from "./GhidraJavaLaunch.js";
import type { GhidraTransportKind } from "./GhidraTransport.js";
import {
  snapshotGhidraExtensions,
  type GhidraExtension,
} from "./extensions/GhidraExtensions.js";

import {
  inspectGhidraPspExtension,
  type GhidraPspExtension,
} from "./GhidraPspExtension.js";

/** Private paths and identity material for one headless Ghidra import. */
export interface GhidraLaunchSession {
  readonly runtimeRoot: string;
  readonly transport: GhidraTransportKind;
  readonly endpointPath: string;
  readonly token: string;
  readonly runId: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
}

/** Process plus private log coordinates returned by a Ghidra launcher. */
export type GhidraLaunch = ProviderProcessLaunch & {
  readonly projectRoot: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
  readonly launchSupport?: readonly GhidraLaunchSupportDiagnostic[];
};

/** Same per-stream projection budget for helper warnings and failed commands. */
export const GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES = 8 * 1024;

/** Successful helper stderr, retained independently of the analysis JVM output. */
export type GhidraLaunchSupportDiagnostic = {
  readonly mode: "-envvars" | "-vmargs";
  readonly stderr: string;
  readonly stderr_bytes: number;
  readonly stderr_truncated: boolean;
};

/** Provider-owned capability that starts one isolated headless analysis. */
export interface GhidraLauncher {
  launch(
    session: GhidraLaunchSession,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>>;
}

/** Local launch failure retained as the cause of a provider-neutral error. */
export class GhidraLaunchError extends Error {
  readonly #partialLaunch: GhidraLaunch | undefined;
  readonly #capturedOutput: AnalysisCapturedOutput | undefined;
  readonly launchSupport: readonly GhidraLaunchSupportDiagnostic[];

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly partialLaunch?: GhidraLaunch;
      readonly capturedOutput?: AnalysisCapturedOutput;
      readonly launchSupport?: readonly GhidraLaunchSupportDiagnostic[];
    },
  ) {
    const { partialLaunch, capturedOutput, launchSupport, ...errorOptions } =
      options ?? {};
    super(message, errorOptions);
    this.name = "GhidraLaunchError";
    this.#partialLaunch = partialLaunch;
    this.#capturedOutput =
      capturedOutput === undefined ? undefined : { ...capturedOutput };
    this.launchSupport = (launchSupport ?? []).map((output) => ({ ...output }));
  }

  /** Process ownership retained for the client to retry an incomplete rollback. */
  get partialLaunch(): GhidraLaunch | undefined {
    return this.#partialLaunch;
  }

  /** Launcher command outcome retained when a launch command reported one. */
  get capturedOutput(): AnalysisCapturedOutput | undefined {
    return this.#capturedOutput === undefined
      ? undefined
      : { ...this.#capturedOutput };
  }
}

/**
 * Retain a failed launcher command's exit/signal and output in the shared
 * captured-output envelope. Bounds apply at projection; truncation there stays
 * explicit, matching the compiler-outcome diagnostics.
 */
const ghidraLaunchCommandOutput = (
  cause: unknown,
): AnalysisCapturedOutput | undefined => {
  const failure = execFileOutputFailure(cause);
  if (failure === undefined) return undefined;
  return {
    stdout: failure.stdout,
    stderr: failure.stderr,
    truncated: failure.outputTruncated,
    exit_code: typeof failure.code === "number" ? failure.code : null,
    signal: failure.signal,
  };
};

/** Static coordinates for an extracted Ghidra release and packaged script. */
export interface GhidraHeadlessLauncherOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly javaVmName?: string;
  readonly bridgeScriptPath: string;
  readonly platform?: NodeJS.Platform;
  readonly comSpec?: string;
  /** Select the admitted 16-bit real-mode MZ import instead of auto-detection. */
  readonly dosMz?: true;
  readonly dosCom?: true;
  readonly rawBinary?: {
    readonly languageId: string;
    readonly compilerSpecId: string;
    readonly baseAddr: string;
  };
  /** Explicit import language committed by the analysis profile. */
  readonly languageOverride?: GhidraLanguageOverride;
  /** Auto-analyzers disabled before default auto-analysis, as configured. */
  readonly disabledAnalyzers?: readonly string[];
  /** Caller seeds committed by the analysis profile, applied before analysis. */
  readonly analysisSeeds?: GhidraSeedCommitment;
  readonly analysisExtensions?: readonly GhidraExtension[];
  readonly pspExtension?: GhidraPspExtension;
  /** Remap typed float storage for the soft-float o32 ABI after analysis. */
  readonly mipsSoftFloat?: true;
  /** Spawn seam for provider-boundary lifecycle tests. */
  readonly spawnProcess?: typeof spawnOwnedProviderProcess;
  /** LaunchSupport probe seam for Java-free launcher fixtures. */
  readonly javaLaunch?: typeof ghidraJavaLaunch;
}

interface LaunchContext {
  readonly session: GhidraLaunchSession;
  readonly paths: ReturnType<typeof ghidraRuntimePaths>;
  readonly platform: NodeJS.Platform;
  readonly launchSupport: GhidraLaunchSupportDiagnostic[];
  readonly signal: AbortSignal | undefined;
}

interface PreparedAnalysisInputs {
  readonly seedPath?: string;
  readonly extensions: readonly GhidraExtension[];
  readonly cache?: GhidraAnalysisCache;
}

interface LaunchFailureState {
  readonly primary: GhidraLaunchError | AnalysisCancelledError;
  readonly capturedOutput: AnalysisCapturedOutput | undefined;
}

interface IncompleteRollback {
  readonly context: LaunchContext;
  readonly cause: unknown;
  readonly started: SpawnedOwnedProviderProcess;
  readonly failure: LaunchFailureState;
  readonly cleanupFailure: unknown;
}

/** Launch Ghidra without copying scripts into or modifying its installation. */
export class GhidraHeadlessLauncher implements GhidraLauncher {
  readonly options: GhidraHeadlessLauncherOptions;
  constructor(options: GhidraHeadlessLauncherOptions) {
    this.options = {
      ...options,
      environment: snapshotEnvironment(options.environment, options.platform),
    };
  }

  async launch(
    session: GhidraLaunchSession,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>> {
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const paths = ghidraRuntimePaths(session.runtimeRoot);
    const platform = this.options.platform ?? process.platform;
    let started: SpawnedOwnedProviderProcess | undefined;
    const launchSupport: GhidraLaunchSupportDiagnostic[] = [];
    const context: LaunchContext = {
      session,
      paths,
      platform,
      launchSupport,
      signal: options.signal,
    };
    try {
      await this.validatePsp(options.signal);
      const headlessArguments = await this.prepareArguments(context);
      const command = await this.inspectCommand(context, headlessArguments);

      started = await (this.options.spawnProcess ?? spawnOwnedProviderProcess)({
        command: command.command,
        arguments: command.arguments,
        runId: session.runId,
        // POSIX launches the inspected JVM directly; script wrappers cannot
        // preserve JVM property paths containing spaces as single arguments.
        expectedCommand: platform !== "win32" ? command.command : null,
        windowsVerbatimArguments: platform === "win32",
        platform,
        env: command.environment,
        hostEnvironment: {},
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const partialLaunch = ownedGhidraLaunch(
        started,
        paths,
        platform,
        launchSupport,
      );
      await this.writeOwnership(context, started, command.command);
      if (isAborted(options.signal)) {
        throw new AnalysisCancelledError("open_binary");
      }
      return ok(partialLaunch);
    } catch (cause: unknown) {
      return this.rollbackFailure(context, cause, started);
    }
  }

  private async validatePsp(signal?: AbortSignal): Promise<void> {
    const psp = this.options.pspExtension;
    if (psp !== undefined) {
      const installedRoot = await realpath(
        join(
          dirname(this.options.analyzeHeadlessPath),
          "..",
          "Ghidra",
          "Extensions",
          "ghidra-allegrex",
        ),
      );
      if (installedRoot !== psp.root)
        throw new GhidraLaunchError(
          "Allegrex profile does not belong to the selected Ghidra installation.",
        );
      const inspected = await inspectGhidraPspExtension(
        psp.root,
        psp.ghidra_version,
        signal,
      );
      if (inspected.sha256 !== psp.sha256)
        throw new GhidraLaunchError(
          "Installed Allegrex content changed since profile resolution; reopen the target to resolve a fresh profile.",
        );
    }
  }

  private async prepareArguments(
    context: LaunchContext,
  ): Promise<readonly string[]> {
    await this.prepareRuntime(context);
    const inputs = await this.snapshotAnalysisInputs(context);
    const options = this.buildHeadlessOptions(context, inputs);
    await this.writeSessionDescriptor(context, inputs.extensions, options);

    return ghidraHeadlessArguments(options);
  }

  private async prepareRuntime(context: LaunchContext): Promise<void> {
    const { paths, platform } = context;
    await createGhidraRuntimeDirectories(
      paths,
      platform,
      await ghidraConfigReleaseDirectory(this.options.analyzeHeadlessPath),
    );
  }

  private async snapshotAnalysisInputs(
    context: LaunchContext,
  ): Promise<PreparedAnalysisInputs> {
    const { session, signal } = context;
    const seedPath =
      this.options.analysisSeeds === undefined
        ? undefined
        : await snapshotGhidraAnalysisSeeds(
            this.options.analysisSeeds,
            session.runtimeRoot,
          );
    const extensions = await snapshotGhidraExtensions(
      this.options.analysisExtensions ?? [],
      session.runtimeRoot,
    );
    if (isAborted(signal)) throw new AnalysisCancelledError("open_binary");

    const cache = await prepareGhidraAnalysisCache(
      session,
      this.options,
      signal,
    );

    return {
      ...(seedPath === undefined ? {} : { seedPath }),
      extensions,
      ...(cache === undefined ? {} : { cache }),
    };
  }

  private buildHeadlessOptions(
    context: LaunchContext,
    inputs: PreparedAnalysisInputs,
  ): GhidraHeadlessArgumentOptions {
    const { session, paths, platform } = context;
    return {
      ...(inputs.cache === undefined ? {} : { analysisCache: inputs.cache }),
      platform,
      ...(this.options.pspExtension === undefined
        ? {}
        : { psp: true as const }),
      ...(this.options.mipsSoftFloat === undefined
        ? {}
        : { mipsSoftFloat: this.options.mipsSoftFloat }),
      projectRoot: paths.projectRoot,
      targetPath: session.targetPath,
      bridgeScriptPath: this.options.bridgeScriptPath,
      descriptorPath: paths.descriptorPath,
      ghidraLogPath: paths.ghidraLogPath,
      scriptLogPath: paths.scriptLogPath,
      ...(this.options.dosCom === undefined
        ? {}
        : { dosCom: this.options.dosCom }),
      ...(this.options.dosMz === undefined
        ? {}
        : { dosMz: this.options.dosMz }),
      ...(this.options.rawBinary === undefined
        ? {}
        : { rawBinary: this.options.rawBinary }),
      ...(this.options.languageOverride === undefined
        ? {}
        : { languageOverride: this.options.languageOverride }),
      ...(inputs.seedPath === undefined ? {} : { seedPath: inputs.seedPath }),
      ...(this.options.disabledAnalyzers === undefined
        ? {}
        : { disabledAnalyzers: this.options.disabledAnalyzers }),
    };
  }

  private async writeSessionDescriptor(
    context: LaunchContext,
    extensions: readonly GhidraExtension[],
    headlessOptions: GhidraHeadlessArgumentOptions,
  ): Promise<void> {
    const { session, paths, platform } = context;
    const analysis = ghidraAnalysisPlan(headlessOptions);
    await writeGhidraRuntimeFile(
      paths.descriptorPath,
      `${JSON.stringify({
        transport: session.transport,
        endpoint_path: session.endpointPath,
        token: session.token,
        run_id: session.runId,
        target_sha256: session.targetSha256,
        provider_version: session.providerVersion,
        profile_digest: session.profileDigest,
        analysis: {
          required: analysis.required,
          post_scripts: analysis.postAnalysisScripts.map((script) => ({
            name: script.name,
            arguments: script.arguments,
          })),
        },
        ...(extensions.length === 0 ? {} : { analysis_extensions: extensions }),
      })}\n`,
      platform,
    );
  }

  private async inspectCommand(
    context: LaunchContext,
    headlessArguments: readonly string[],
  ): Promise<Awaited<ReturnType<typeof ghidraJavaLaunch>>> {
    const scriptCommand = this.buildHeadlessScriptCommand(
      context,
      headlessArguments,
    );
    const environment = this.buildLaunchEnvironment(context, scriptCommand);

    if (context.platform === "win32") return { ...scriptCommand, environment };

    return this.inspectJavaCommand(context, headlessArguments, environment);
  }

  private buildHeadlessScriptCommand(
    context: LaunchContext,
    headlessArguments: readonly string[],
  ): ReturnType<typeof ghidraHeadlessCommand> {
    return ghidraHeadlessCommand({
      environment: this.options.environment,
      platform: context.platform,
      analyzeHeadlessPath: this.options.analyzeHeadlessPath,
      arguments: headlessArguments,
      ...(this.options.comSpec === undefined
        ? {}
        : { comSpec: this.options.comSpec }),
    });
  }

  private buildLaunchEnvironment(
    context: LaunchContext,
    scriptCommand: ReturnType<typeof ghidraHeadlessCommand>,
  ): Readonly<NodeJS.ProcessEnv> {
    return ghidraLaunchEnvironment(
      context.paths,
      this.options.javaHome,
      context.platform,
      scriptCommand.command,
      this.options.environment,
    );
  }

  private inspectJavaCommand(
    context: LaunchContext,
    headlessArguments: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
  ): Promise<Awaited<ReturnType<typeof ghidraJavaLaunch>>> {
    const { paths, platform, signal } = context;
    const javaHome = this.options.javaHome;
    if (javaHome === undefined)
      throw new GhidraLaunchError(
        "POSIX Ghidra requires its inspected JDK home",
      );

    return (this.options.javaLaunch ?? ghidraJavaLaunch)({
      platform,
      analyzeHeadlessPath: this.options.analyzeHeadlessPath,
      javaHome,
      ...(this.options.javaVmName === undefined
        ? {}
        : { javaVmName: this.options.javaVmName }),
      homeRoot: paths.homeRoot,
      tempRoot: paths.tempRoot,
      arguments: headlessArguments,
      environment,
      onStderr: (mode, stderr) =>
        this.captureLaunchSupport(context, mode, stderr),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private captureLaunchSupport(
    context: LaunchContext,
    mode: GhidraLaunchSupportDiagnostic["mode"],
    stderr: string,
  ): void {
    if (stderr === "") return;

    const bytes = Buffer.byteLength(stderr);
    const redacted = redactCapturedTransportCredential(
      { text: stderr, bytes, observedBytes: bytes },
      context.session.token,
      "[REDACTED]",
    );
    const bounded = boundedUtf8Text(
      redacted,
      GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
    );
    context.launchSupport.push({
      mode,
      stderr: bounded.text,
      stderr_bytes: bytes,
      stderr_truncated: bounded.truncated,
    });
  }

  private async writeOwnership(
    context: LaunchContext,
    started: SpawnedOwnedProviderProcess,
    command: string,
  ): Promise<void> {
    const { session, paths, platform } = context;
    await writeGhidraRuntimeFile(
      paths.ownershipPath,
      `${JSON.stringify({
        run_id: session.runId,
        transport: session.transport,
        endpoint_path: session.endpointPath,
        pid: started.ownership.leaderPid,
        process_group_id: started.ownership.processGroupId,
        parent_pid: process.pid,
        ownership_kind:
          platform === "win32" ? "windows-job-object" : "posix-process-group",
        launcher: command,
        headless_script: this.options.analyzeHeadlessPath,
        created_at: new Date().toISOString(),
      })}\n`,
      platform,
    );
  }

  private async rollbackFailure(
    context: LaunchContext,
    cause: unknown,
    started: SpawnedOwnedProviderProcess | undefined,
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>> {
    const failure = this.describeLaunchFailure(context, cause);
    if (started === undefined) return err(failure.primary);

    const cleanupFailure = await this.cleanupFailedLaunch(started, context);
    if (cleanupFailure === undefined) return err(failure.primary);

    return err(
      this.incompleteRollbackError({
        context,
        cause,
        started,
        failure,
        cleanupFailure,
      }),
    );
  }

  private describeLaunchFailure(
    context: LaunchContext,
    cause: unknown,
  ): LaunchFailureState {
    const { launchSupport, signal } = context;
    const capturedOutput = ghidraLaunchCommandOutput(cause);
    const launchFailure = new GhidraLaunchError(
      "Ghidra headless launch failed",
      {
        cause,
        launchSupport,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
    const primary = isAborted(signal)
      ? new AnalysisCancelledError("open_binary", { cause: launchFailure })
      : launchFailure;

    return { primary, capturedOutput };
  }

  private async cleanupFailedLaunch(
    started: SpawnedOwnedProviderProcess,
    context: LaunchContext,
  ): Promise<unknown | undefined> {
    try {
      const cleanup = await cleanupStartedProcess(started, context.platform);
      if (!cleanup.cleaned)
        return new Error(
          `Ghidra process cleanup was incomplete: ${cleanup.reason}`,
        );
    } catch (failure: unknown) {
      return failure;
    }
    return undefined;
  }

  private incompleteRollbackError({
    context,
    cause,
    started,
    failure,
    cleanupFailure,
  }: IncompleteRollback): GhidraLaunchError {
    const { paths, platform, launchSupport, signal } = context;
    const partialLaunch = ownedGhidraLaunch(
      started,
      paths,
      platform,
      launchSupport,
    );
    const message = isAborted(signal)
      ? failure.primary.message
      : `Ghidra headless launch failed: ${cause instanceof Error ? cause.message : String(cause)}`;

    return new GhidraLaunchError(
      `${message}; process cleanup remains incomplete`,
      {
        cause: new AggregateError(
          [failure.primary, cleanupFailure],
          "Ghidra launch rollback did not release its process",
          { cause: failure.primary },
        ),
        partialLaunch,
        launchSupport,
        ...(failure.capturedOutput === undefined
          ? {}
          : { capturedOutput: failure.capturedOutput }),
      },
    );
  }
}

const ownedGhidraLaunch = (
  spawned: SpawnedOwnedProviderProcess,
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
  launchSupport: readonly GhidraLaunchSupportDiagnostic[],
): GhidraLaunch => ({
  ...ownedGhidraProcess(spawned, platform),
  projectRoot: paths.projectRoot,
  ghidraLogPath: paths.ghidraLogPath,
  scriptLogPath: paths.scriptLogPath,
  ...(launchSupport.length === 0 ? {} : { launchSupport: [...launchSupport] }),
});

const ownedGhidraProcess = (
  spawned: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Pick<
  Extract<ProviderProcessLaunch, { readonly ownsProcessLifetime: true }>,
  "process" | "ownsProcessLifetime" | "ownership" | "cleanup"
> => ({
  process: spawned.process,
  ownsProcessLifetime: true,
  ownership: spawned.ownership,
  cleanup: () => cleanupStartedProcess(spawned, platform),
});

/** Exact executable and argv passed to shell-free process creation. */
export interface GhidraHeadlessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

/** Build a direct POSIX launch or a conservatively quoted Windows batch call. */
export const ghidraHeadlessCommand = (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly arguments: readonly string[];
  readonly comSpec?: string;
}): GhidraHeadlessCommand => {
  if (options.platform !== "win32")
    return {
      command: options.analyzeHeadlessPath,
      arguments: [...options.arguments],
    };
  const command = ghidraBatchStep(() =>
    windowsBatchCommand({
      environment: options.environment,
      batchPath: options.analyzeHeadlessPath,
      arguments: options.arguments,
      ...(options.comSpec === undefined ? {} : { comSpec: options.comSpec }),
    }),
  );
  if ((command.arguments.at(-1)?.length ?? 0) > 30_000)
    throw new GhidraLaunchError(
      "Windows Ghidra command exceeds the P0 length limit",
    );
  return command;
};

/** Keep Ghidra's launch error type and P0 wording for shared batch checks. */
const ghidraBatchStep = <T>(step: () => T): T => {
  try {
    return step();
  } catch (cause: unknown) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    throw new GhidraLaunchError(
      cause.reason === "metacharacter"
        ? "Windows Ghidra P0 paths cannot contain command-interpreter metacharacters"
        : cause.message,
      { cause },
    );
  }
};

const cleanupStartedProcess = (
  started: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Promise<ProcessCleanupResult> =>
  started.cleanup !== undefined
    ? started.cleanup()
    : platform === "win32"
      ? cleanupWindowsProcessTree(started.ownership.leaderPid)
      : cleanupOwnedProcessGroup(started.ownership);

const ghidraRuntimePaths = (runtimeRoot: string) => ({
  projectRoot: join(runtimeRoot, "project"),
  homeRoot: join(runtimeRoot, "home"),
  tempRoot: join(runtimeRoot, "tmp"),
  cacheRoot: join(runtimeRoot, "cache"),
  configRoot: join(runtimeRoot, "config"),
  dataRoot: join(runtimeRoot, "data"),
  descriptorPath: join(runtimeRoot, "session.json"),
  ownershipPath: join(runtimeRoot, "ownership.json"),
  ghidraLogPath: join(runtimeRoot, "ghidra.log"),
  scriptLogPath: join(runtimeRoot, "script.log"),
});

/**
 * Ghidra's launch support resolves its JDK before the headless run and then
 * persists that choice under `<config>/ghidra/<release directory>`. Inside
 * REA's Windows private runtime a child JVM cannot create those directories
 * itself, so startup aborted with "Failed to create directory" and reported
 * that no supported JDK was found. Create the release directory while this
 * process still owns the runtime, leaving Ghidra only a file write inside it.
 */
const ghidraConfigReleaseDirectory = async (
  analyzeHeadlessPath: string,
): Promise<string> => {
  const installRoot = dirname(dirname(analyzeHeadlessPath));
  try {
    const properties = await readFile(
      join(installRoot, "Ghidra", "application.properties"),
      "latin1",
    );
    const parsed = parseGhidraJavaProperties(properties);
    if (!parsed.ok) return basename(installRoot);
    const version = parsed.value.get("application.version");
    const release = parsed.value.get("application.release.name");
    return version === undefined ||
      release === undefined ||
      release.length === 0
      ? basename(installRoot)
      : `ghidra_${version}_${release}`;
  } catch (cause: unknown) {
    // An unreadable properties file leaves the release coordinate unknown; the
    // conventional extraction directory carries the same name.
    void cause;
    return basename(installRoot);
  }
};

const createGhidraRuntimeDirectories = async (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
  configReleaseDirectory: string,
): Promise<void> => {
  if (platform === "win32") {
    const runtime = windowsPrivateRuntime(dirname(paths.projectRoot));
    for (const path of [
      paths.projectRoot,
      paths.homeRoot,
      paths.tempRoot,
      paths.cacheRoot,
      paths.configRoot,
      paths.dataRoot,
    ])
      runtime.mkdir(basename(path));
    // Each level needs its parent first: the native owner opens every existing
    // component and creates only the final one.
    const configRoot = basename(paths.configRoot);
    runtime.mkdir(win32.join(configRoot, "ghidra"));
    runtime.mkdir(win32.join(configRoot, "ghidra", configReleaseDirectory));
    return;
  }
  await Promise.all(
    [
      paths.projectRoot,
      paths.homeRoot,
      paths.tempRoot,
      paths.cacheRoot,
      paths.configRoot,
      paths.dataRoot,
      join(paths.configRoot, "ghidra", configReleaseDirectory),
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
};

const writeGhidraRuntimeFile = async (
  path: string,
  content: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  if (platform === "win32") {
    windowsPrivateRuntime(dirname(path)).writeFile(basename(path), content);
    return;
  }
  await writeFileAtomic(path, content, { encoding: "utf8", mode: 0o600 });
};

const ghidraLaunchEnvironment = (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  javaHome: string | undefined,
  platform: NodeJS.Platform,
  executable: string,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  return {
    ...ghidraJavaEnvironment(javaHome, selectedEnvironment, platform),
    ...ghidraHeadlessJavaOptions(paths.homeRoot, paths.tempRoot, platform),
    HOME: paths.homeRoot,
    TMPDIR: paths.tempRoot,
    ...(platform === "win32"
      ? {
          // Batch FOR /F launches another command interpreter through ComSpec.
          // Use the same executable with the spelling consumed by cmd.exe.
          ComSpec: executable.replaceAll("/", "\\"),
          USERPROFILE: paths.homeRoot,
          APPDATA: paths.configRoot,
          LOCALAPPDATA: paths.cacheRoot,
          TEMP: paths.tempRoot,
          TMP: paths.tempRoot,
        }
      : {}),
    XDG_CACHE_HOME: paths.cacheRoot,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_DATA_HOME: paths.dataRoot,
  };
};

/** Encode provider-owned JVM paths for the platform launcher that consumes them. */
export const ghidraHeadlessJavaOptions = (
  homeRoot: string,
  tempRoot: string,
  platform: NodeJS.Platform,
): Pick<
  NodeJS.ProcessEnv,
  "JDK_JAVA_OPTIONS" | "GHIDRA_HEADLESS_JAVA_OPTIONS"
> => {
  const options = [`-Duser.home=${homeRoot}`, `-Djava.io.tmpdir=${tempRoot}`];
  if (platform === "win32")
    return {
      JDK_JAVA_OPTIONS: [...options, "-XX:-UsePerfData"]
        .map((option) => ghidraBatchStep(() => quoteWindowsBatchToken(option)))
        .join(" "),
      GHIDRA_HEADLESS_JAVA_OPTIONS: "",
    };
  // POSIX launches the JVM directly, so these properties travel as separate
  // argv items instead of the shell-split analyzeHeadless option list.
  return { JDK_JAVA_OPTIONS: "", GHIDRA_HEADLESS_JAVA_OPTIONS: "" };
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
