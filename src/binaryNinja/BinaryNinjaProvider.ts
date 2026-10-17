import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type {
  AnalysisClient,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  binaryNinjaConfigurationError,
  readBinaryNinjaConfiguration,
  type BinaryNinjaConfiguration,
} from "./BinaryNinjaConfiguration.js";
import {
  createBinaryNinjaMcpConnection,
  type BinaryNinjaMcpConnection,
} from "./BinaryNinjaMcpConnection.js";
import {
  BINARY_NINJA_PROVIDER_IDENTITY,
  binaryNinjaCapabilities,
} from "./BinaryNinjaProviderCapabilities.js";
import { BinaryNinjaSessionClient } from "./BinaryNinjaSessionClient.js";

/** Bring-your-own Binary Ninja GUI MCP candidate; discovery performs no connection. */
export class BinaryNinjaProvider implements AnalysisProviderCandidate {
  #registration:
    | Result<BinaryNinjaConfiguration, ConfigurationError>
    | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly connectionFactory: (
      config: BinaryNinjaConfiguration,
    ) => BinaryNinjaMcpConnection = createBinaryNinjaMcpConnection,
  ) {}

  identity() {
    return BINARY_NINJA_PROVIDER_IDENTITY;
  }

  capabilities() {
    return binaryNinjaCapabilities();
  }

  inspectAvailability(): ProviderAvailability {
    const config = this.#configuration();
    return config.ok
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {
            configured: true,
            transport: "http",
            live_connection_probed: false,
          },
        }
      : {
          status: "unavailable",
          code:
            this.config.binaryNinjaMcpConfigPath === undefined
              ? "not_configured"
              : "open_options_invalid",
          reason: config.error.message,
          diagnostics: { configured: false, live_connection_probed: false },
        };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason:
          "Binary Ninja MCP integration admits the original executable open in the GUI, not analysis databases or archives.",
        diagnostics,
      };
    if (target.format === "pe" && target.managed)
      return {
        status: "unsupported",
        code: "managed_target_unsupported",
        reason:
          "Binary Ninja does not decompile managed .NET code. Use REA's managed-code tools instead.",
        diagnostics,
      };
    if (
      target.format !== "pe" &&
      target.format !== "elf" &&
      target.format !== "mach-o"
    )
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          target.format === "mach-o-universal"
            ? "Binary Ninja's Raw view holds the whole universal file, so REA cannot verify which slice the GUI loaded. Extract the slice with lipo -thin and open the thin file in both Binary Ninja and REA."
            : `REA's Binary Ninja adapter admits PE, ELF and thin Mach-O executables, not ${target.format} inputs.`,
        diagnostics,
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }

  async resolveAnalysisProfile(
    _target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError("binary-ninja:profile"));
    const config = this.#configuration();
    if (!config.ok) return config;
    // Header values carry credentials and never enter the commitment.
    const { headers, ...settings } = config.value;
    return ok({
      profile: createAnalysisProfile(BINARY_NINJA_PROVIDER_IDENTITY, {
        version_scope: "rea-binary-ninja-adapter",
        engine_version: null,
        mode: "attached-gui",
        compatibility_profile: "binary-ninja-gui-mcp",
        database_revision: null,
        cache_policy: "live",
        registration_digest: createHash("sha256")
          .update(
            canonicalize({
              ...settings,
              header_names: Object.keys(headers).sort(),
            }) ?? "",
          )
          .digest("hex"),
      }),
    });
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const config = this.#configuration();
    if (!config.ok)
      return {
        execute: async () => err(config.error),
        close: async () => ok(null),
      };
    return new BinaryNinjaSessionClient(
      config.value,
      target,
      this.connectionFactory(config.value),
      profile,
    );
  }

  #configuration() {
    this.#registration ??=
      this.config.binaryNinjaMcpConfigPath === undefined
        ? err(
            binaryNinjaConfigurationError(
              "Set REA_BINARY_NINJA_MCP_CONFIG to a Binary Ninja GUI MCP JSON registration; see docs/binary-ninja.md.",
            ),
          )
        : readBinaryNinjaConfiguration(this.config.binaryNinjaMcpConfigPath);
    return this.#registration;
  }
}
