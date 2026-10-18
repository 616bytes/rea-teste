import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { artifactFilePrimaryFailure } from "../artifacts/ArtifactFileOperation.js";
import { fileURLToPath } from "node:url";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisClientContext,
  type AnalysisOperation,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import {
  ghidraSeedCommitmentSchema,
  ghidraSeedFailure,
  ghidraSeedLimitations,
} from "./GhidraAnalysisSeeds.js";
import {
  ghidraPinnedLanguage,
  ghidraProfileDisabledAnalyzers,
  ghidraProfileLanguageOverride,
  sameGhidraDisabledAnalyzers,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import { ghidraPinnedMipsLanguage } from "./GhidraMipsProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import {
  providerRetryAction,
  type ProviderOperationHealth,
} from "../domain/providerOperationHealth.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "pino";
import { GhidraClient } from "./GhidraClient.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import {
  isGhidraFunctionOperation,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "./GhidraFunctionValues.js";
import {
  isGhidraInventoryOperation,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "./GhidraInventoryValues.js";
import {
  ghidraInstallationDiagnostics,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import {
  isGhidraPspTarget,
  GHIDRA_PSP_LIMITATIONS,
} from "./GhidraPspProfile.js";
import { ghidraPspExtensionSchema } from "./GhidraPspExtension.js";
import {
  GHIDRA_MIPS_SOFT_FLOAT_STORAGE,
  ghidraMipsSoftFloatFailure,
  ghidraMipsRelocatableLimitations,
  ghidraMipsSharedLimitations,
  ghidraMipsSoftFloatLimitations,
  isGhidraMipsSoftFloatTarget,
} from "./GhidraMipsProfile.js";
import { ghidraRiscvLimitations } from "./GhidraRiscvProfile.js";
import { ghidraPePdbLimitations } from "./GhidraPeProfile.js";
import { unverifiedGhidraBuildLimitation } from "./GhidraReleasePolicy.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";
import type { NativeAotPeResult } from "../domain/native/nativeAotPe.js";
import { GhidraNativeAotSnapshotOwner } from "./GhidraNativeAotSnapshotOwner.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  healthLimitations,
  windowsP0Limitations,
  limitationsFor,
} from "./GhidraProviderCapabilities.js";
import {
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  type GhidraSessionError,
} from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";
import { ghidraExtensionFailure } from "./extensions/GhidraExtensionFailures.js";
import {
  ghidraExtensionSchema,
  validateGhidraExtensionProfile,
  ghidraExtensionLimitations,
} from "./extensions/GhidraExtensions.js";
import { inspectWindowsNativeReadiness } from "../process/WindowsAuthority.js";
import { ghidraRawBinaryLanguage } from "./GhidraRawBinaryLanguage.js";

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close"> &
  Partial<
    Pick<
      GhidraClient,
      | "callToolIfReady"
      | "operationHealthSnapshot"
      | "runtimeLineage"
      | "readTargetSnapshot"
      | "hashTargetSnapshot"
      | "attestDosTargetSnapshot"
    >
  >;

type GhidraProviderClientInstance = ReturnType<GhidraProviderClientFactory>;

/** Build one AnalysisClient for an admitted Ghidra target and profile. */
export const createGhidraProviderClient = (input: {
  readonly config: AppConfig;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly clientFactory: GhidraProviderClientFactory;
  readonly admission: GhidraClientAdmission;
  readonly context?: AnalysisClientContext;
  readonly installation: GhidraInstallationInspection;
  readonly signal: AbortSignal;
}): Result<AnalysisClient, AnalysisError> => {
  const { config, logger, clientFactory, context, installation } = input;
  const { target, profile } = input.admission;
  const prerequisites = ghidraClientPrerequisites(profile, installation);
  if (!prerequisites.ok) return err(prerequisites.error);
  const committedProfile = prerequisites.value.profile;
  const psp = isGhidraPspTarget(target);
  const pspExtension = psp
    ? ghidraPspExtensionSchema.safeParse(
        committedProfile.parameters.psp_extension,
      )
    : null;
  if (
    pspExtension !== null &&
    (!pspExtension.success ||
      committedProfile.parameters.language_id !== "Allegrex:LE:32:default" ||
      committedProfile.parameters.loader !== "PspElfLoader")
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the supported PSP profile and installed Allegrex extension before opening the session.",
        },
      }),
    );
  const softFloat = isGhidraMipsSoftFloatTarget(target);
  if (
    softFloat !==
    (committedProfile.parameters.mips_soft_float_storage ===
      GHIDRA_MIPS_SOFT_FLOAT_STORAGE)
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the soft-float MIPS storage policy into the analysis profile before opening the session.",
        },
      }),
    );
  const extensionProfile = ghidraExtensionSchema
    .array()
    .safeParse(committedProfile.parameters.analysis_extensions ?? []);
  if (
    !extensionProfile.success ||
    (config.ghidraNativeAotJar !== undefined &&
      extensionProfile.data.length === 0)
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve the configured Ghidra extensions into an analysis profile before opening the session.",
        },
      }),
    );
  const extensions = extensionProfile.data;
  const seedProfile = ghidraSeedCommitmentSchema
    .optional()
    .safeParse(committedProfile.parameters.analysis_seeds);
  if (
    !seedProfile.success ||
    (config.ghidraSeedFile === undefined) !== (seedProfile.data === undefined)
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "Resolve REA_GHIDRA_SEED_FILE into an analysis profile before opening the session.",
        },
      }),
    );
  const seeds = seedProfile.data;
  const parameterLanguage = ghidraProfileLanguageOverride(
    committedProfile.parameters,
  );
  const pinnedLanguage = ghidraPinnedMipsLanguage(committedProfile.parameters);
  const targetLanguage = ghidraPinnedLanguage(target);
  if (pinnedLanguage !== undefined && targetLanguage === undefined)
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed profile pins a MIPS language that the current target does not establish; reopen an admitted target to resolve a new profile.",
        },
      }),
    );
  // Provider-pinned profiles declare their language through the same
  // parameter slot caller-configured profiles use, so only an environment
  // override conflicts with the legacy pin; the slot itself carries it.
  if (
    pinnedLanguage !== undefined &&
    config.ghidraLanguageOverride !== undefined
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed legacy MIPS profile pins its import language; REA_GHIDRA_LANGUAGE_ID/REA_GHIDRA_COMPILER_SPEC_ID cannot be combined with it. Reopen the target without the override.",
        },
      }),
    );
  if (
    !sameGhidraLanguageOverride(
      parameterLanguage,
      config.ghidraLanguageOverride ?? targetLanguage,
    )
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed analysis profile and REA_GHIDRA_LANGUAGE_ID/REA_GHIDRA_COMPILER_SPEC_ID differ; reopen the target to resolve a new profile.",
        },
      }),
    );
  // Both caller-selected and provider-pinned languages use the validated
  // committed slot; the profile cannot supply its own applicability proof.
  const importLanguage = parameterLanguage;
  const disabledAnalyzers = ghidraProfileDisabledAnalyzers(
    committedProfile.parameters,
  );
  if (
    !sameGhidraDisabledAnalyzers(
      disabledAnalyzers,
      config.ghidraDisabledAnalyzers,
    )
  )
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: {
          reason:
            "The committed analysis profile and REA_GHIDRA_DISABLED_ANALYZERS differ; reopen the target to resolve a new profile.",
        },
      }),
    );

  const invalidProfile = validateGhidraExtensionProfile(
    extensions,
    config,
    target,
    installation.platform,
  );
  if (invalidProfile !== null)
    return err(
      new ProviderAdapterError("ghidra", "open_binary", {
        diagnostics: { reason: invalidProfile },
      }),
    );
  let extensionFailure: AnalysisError | undefined;
  // Replaced by the reported outcome once the session handshake is checked.
  const seedLimitations: string[] = [...ghidraSeedLimitations(seeds)];
  const pdbLimitations: string[] = [];
  // Replaced by the reported storage outcome once the handshake is checked.
  const softFloatLimitations: string[] = [
    ...ghidraMipsSoftFloatLimitations(softFloat),
  ];
  const rawLanguage =
    target.format === "raw-binary"
      ? ghidraRawBinaryLanguage(target.architecture)
      : undefined;
  const targetLimitations = [
    ...(target.format === "dos-mz"
      ? [
          "DOS MZ uses 16-bit x86 real mode with the Ghidra load segment 0x1000. Returned addresses are linear byte coordinates; they do not identify a unique segment:offset alias.",
          "Static DOS analysis does not emulate BIOS, DOS interrupts, device ports, or self-modifying unpacking code. Packed targets require a separately identified unpacked artifact for original-program analysis; appended overlays are not the initialized load module.",
        ]
      : []),
    ...(target.format === "raw-binary"
      ? [
          "Headerless raw-binary analysis uses the caller-supplied architecture and entry address; file offset 0 is mapped at that address. Headers are not discovered from file bytes.",
          "Little-endian generic Ghidra languages are used for x86, x86_64, arm, arm64, NMOS 6502, and 65816; m68k uses the big-endian 68000 default language, which decodes the 68040 superset. Big-endian ARM, Thumb-only, Cortex-M, 65C02, separate 68020/68030/CPU32/ColdFire variants, and other processor variants are unsupported in this increment. 65816 requires a community processor extension.",
          "Static analysis does not emulate reset vectors, memory-mapped I/O, or firmware boot sequences.",
        ]
      : []),
    ...(target.architecture === "mips" ? (target.mips.limitations ?? []) : []),
    ...(committedProfile.parameters.mips_abi_basis ===
    "inferred-o32-assumption-v1"
      ? [
          "The ELF header declares no ABI field and no ABI flags record was observed; o32 calling conventions are an analysis assumption of this lane, not a declared fact.",
          "Floating-point ABI semantics are unverified for this recordless legacy admission.",
        ]
      : []),
    ...ghidraMipsRelocatableLimitations(target),
    ...ghidraMipsSharedLimitations(target),
    ...ghidraRiscvLimitations(target),
  ];
  const providerLimitations =
    installation.platform === "win32"
      ? windowsP0Limitations
      : installation.platform === "darwin"
        ? [
            "macOS sessions require a matching executable Ghidra native decompiler; REA checks for it but does not build native components or change Gatekeeper quarantine state.",
          ]
        : [];
  if (input.signal.aborted)
    return err(
      new AnalysisCancelledError("create_analysis_client", {
        cause: input.signal.reason,
        diagnostics: ghidraInstallationDiagnostics(installation),
      }),
    );
  const client = clientFactory({
    startupTimeoutMs: config.ghidraStartupTimeoutMs,
    platform: installation.platform,
    launcher: new GhidraHeadlessLauncher({
      environment: input.environment,
      analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
      configurationDirectoryName:
        prerequisites.value.configurationDirectoryName,
      javaHome: prerequisites.value.javaHome,
      ...(installation.javaVmName === undefined
        ? {}
        : { javaVmName: installation.javaVmName }),
      bridgeScriptPath: fileURLToPath(
        new URL(
          `../../bridge/ghidra/${GHIDRA_BRIDGE_SOURCES.bridge}`,
          import.meta.url,
        ),
      ),
      ...(pspExtension?.success === true
        ? { pspExtension: pspExtension.data }
        : {}),
      ...(softFloat ? { mipsSoftFloat: true as const } : {}),
      ...(target.format === "dos-mz" ? { dosMz: true } : {}),
      ...(target.format === "dos-com" ? { dosCom: true } : {}),
      ...(rawLanguage === undefined || target.format !== "raw-binary"
        ? {}
        : {
            rawBinary: {
              languageId: rawLanguage.languageId,
              compilerSpecId: rawLanguage.compilerSpecId,
              baseAddr: target.entryPoint,
            },
          }),
      ...(importLanguage === undefined
        ? {}
        : { languageOverride: importLanguage }),
      ...(config.ghidraDisabledAnalyzers === undefined
        ? {}
        : { disabledAnalyzers: config.ghidraDisabledAnalyzers }),
      ...(seeds === undefined ? {} : { analysisSeeds: seeds }),
      platform: installation.platform,
      ...(extensions.length === 0 ? {} : { analysisExtensions: extensions }),
    }),
    targetPath:
      installation.platform === "win32"
        ? (target.sourcePath ?? target.path)
        : target.path,
    targetSha256: target.sha256,
    transport:
      installation.platform === "win32"
        ? "authenticated-loopback-tcp"
        : "unix-socket",
    providerVersion: prerequisites.value.providerVersion,
    profileDigest: committedProfile.digest,
    ...(["dos-mz", "dos-com"].includes(target.format)
      ? {
          expectedLanguageId: "x86:LE:16:Real Mode",
          expectedCompilerSpecId: "default",
        }
      : rawLanguage === undefined
        ? importLanguage === undefined
          ? {}
          : {
              expectedLanguageId: importLanguage.languageId,
              ...(importLanguage.compilerSpecId === undefined
                ? {}
                : { expectedCompilerSpecId: importLanguage.compilerSpecId }),
            }
        : {
            expectedLanguageId: rawLanguage.languageId,
            expectedCompilerSpecId: rawLanguage.compilerSpecId,
          }),
    ...(psp
      ? {
          expectedLanguageId: "Allegrex:LE:32:default",
          expectedCompilerSpecId: "default",
        }
      : {}),
    ...(context === undefined ? {} : { runId: context.runId }),
    logger: logger.child({ layer: "ghidra-bridge" }),
  });
  // Startup failures retain installation guidance; only a previously running
  // provider can be described as lost and reopened.
  let providerStarted = false;
  const lostProviderHealth = (): ProviderOperationHealth | undefined =>
    providerStarted ? client.operationHealthSnapshot?.() : undefined;
  const checkSessionObservations = async (
    operation: AnalysisOperation,
    info: GhidraSessionInfo,
  ): Promise<AnalysisError | undefined> => {
    if (target.format === "pe") {
      pdbLimitations.splice(
        0,
        pdbLimitations.length,
        ...ghidraPePdbLimitations(target, info.pdb),
      );
    }
    const softFloatReason = ghidraMipsSoftFloatFailure(
      softFloat,
      info.mips_soft_float_storage,
    );
    extensionFailure =
      ghidraExtensionFailure(
        extensions,
        info.analysis_extensions ?? [],
        operation,
      ) ??
      ghidraSeedFailure(seeds, info.analysis_seeds, operation) ??
      (softFloatReason === undefined
        ? undefined
        : new ProviderAdapterError("ghidra", operation, {
            diagnostics: { reason: softFloatReason },
          }));
    if (extensionFailure === undefined && info.analysis_seeds !== undefined)
      seedLimitations.splice(
        0,
        seedLimitations.length,
        ...ghidraSeedLimitations(seeds, info.analysis_seeds),
      );
    if (extensionFailure === undefined)
      softFloatLimitations.splice(
        0,
        softFloatLimitations.length,
        ...ghidraMipsSoftFloatLimitations(
          softFloat,
          info.mips_soft_float_storage,
        ),
      );
    if (extensionFailure === undefined) return undefined;
    const closed = await client.close();
    return closed.ok
      ? extensionFailure
      : analysisErrorWithCleanupFailure(
          extensionFailure,
          closed.error,
          operation,
        );
  };
  const releaseLimitation = unverifiedGhidraBuildLimitation(
    prerequisites.value.providerVersion,
  );
  const sessionLimitations = (): readonly string[] => [
    ...providerLimitations,
    ...targetLimitations,
    ...(psp ? GHIDRA_PSP_LIMITATIONS : []),
    ...seedLimitations,
    ...pdbLimitations,
    ...softFloatLimitations,
    ...(releaseLimitation === undefined ? [] : [releaseLimitation]),
    ...ghidraExtensionLimitations(extensions),
  ];
  return ok({
    identity: GHIDRA_PROVIDER_IDENTITY,
    async open() {
      if (input.signal.aborted)
        return err(
          new AnalysisCancelledError("open_binary", {
            cause: input.signal.reason,
          }),
        );
      const started = await client.start();
      if (!started.ok) return started;
      providerStarted = true;
      const session = await checkSessionObservations(
        "open_binary",
        started.value,
      );
      if (session !== undefined) return err(session);
      return ok({
        ...started.value,
        limitations: sessionLimitations(),
      });
    },
    async execute(operation, input) {
      if (input.signal?.aborted === true)
        return err(
          new AnalysisCancelledError(operation, {
            cause: input.signal.reason,
          }),
        );
      const result = await client.callTool(operation, input);
      if (!result.ok) return result;
      const session = await checkSessionObservations(
        operation,
        result.value.session,
      );
      if (session !== undefined) return err(session);
      return ok({
        ...result.value,
        limitations: sessionLimitations(),
      });
    },
    async close() {
      return client.close();
    },
  });
};
