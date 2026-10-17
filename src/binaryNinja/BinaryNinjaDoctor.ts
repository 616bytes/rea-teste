import type { DoctorProviderInspection } from "../application/Doctor.js";
import { readBinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";

/** Check the registration without connecting, and retain only the configuration file reference. */
export const inspectBinaryNinjaRegistration = (
  path: string | undefined,
): DoctorProviderInspection => {
  const parsed =
    path === undefined ? undefined : readBinaryNinjaConfiguration(path);
  const valid = parsed?.ok === true;
  return {
    id: "binary-ninja",
    configured: path !== undefined,
    available: valid,
    providerVersion: null,
    registrationEnvironment:
      valid && path !== undefined ? { REA_BINARY_NINJA_MCP_CONFIG: path } : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid
          ? null
          : path === undefined
            ? "not_configured"
            : "invalid_configuration",
        detail: valid
          ? "Binary Ninja MCP registration is valid. Server availability, the open file, and its identity are checked when analysis starts; no connection was made."
          : parsed !== undefined && !parsed.ok
            ? parsed.error.message
            : "Binary Ninja MCP registration is not configured.",
        remediation: valid
          ? null
          : "Set REA_BINARY_NINJA_MCP_CONFIG to your Binary Ninja GUI MCP registration JSON; see docs/binary-ninja.md.",
        classification:
          path === undefined ? "missing_analysis_engine" : "config_drift",
      },
    ],
  };
};
