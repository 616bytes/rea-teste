import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { parseJebMcpTimeoutMs } from "../config/environment.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseJebMcpEndpoint } from "./JebMcpEndpoint.js";

/** Check selected JEB settings without launching the engine, retaining the validated endpoint independently of readiness. */
export const inspectJebRegistration = (
  environment: Readonly<Record<string, string | undefined>>,
): DoctorProviderInspection => {
  const value = environment.REA_JEB_MCP_URL;
  const configured = value !== undefined && value.length > 0;
  const parsed = configured ? parseJebMcpEndpoint(value) : undefined;
  const valid = parsed?.ok === true;
  const requestTimeout = parseJebMcpTimeoutMs(
    environment.REA_JEB_MCP_TIMEOUT_MS,
  );
  const timeoutChecks: readonly DoctorProviderCheck[] = requestTimeout.ok
    ? []
    : [
        {
          name: "request-timeout",
          ok: false,
          code: "invalid_configuration",
          detail: requestTimeout.error.settings
            .map(({ setting, constraint }) => `${setting}: ${constraint}`)
            .join("; "),
          remediation:
            "Fix REA_JEB_MCP_TIMEOUT_MS or unset it to use the default request budget; see docs/jeb-analysis.md.",
          classification: "config_drift",
        },
      ];
  return {
    id: "jeb",
    configured,
    available: valid && requestTimeout.ok,
    providerVersion: null,
    registrationEnvironment:
      valid && configured && value !== undefined
        ? { REA_JEB_MCP_URL: value }
        : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid
          ? null
          : configured
            ? "invalid_configuration"
            : "not_configured",
        detail: valid
          ? "JEB MCP endpoint is valid. Upstream availability, compatibility, and project binding are checked when analysis starts; no JEB process was launched."
          : parsed !== undefined && !parsed.ok
            ? `JEB MCP endpoint is invalid: ${endpointConstraint(parsed.error)}.`
            : "JEB MCP endpoint is not configured.",
        remediation: valid
          ? null
          : "Set REA_JEB_MCP_URL to your running JEB MCP endpoint; see docs/jeb-analysis.md.",
        classification: configured ? "config_drift" : "missing_analysis_engine",
      },
      ...timeoutChecks,
    ],
  };
};

const endpointConstraint = (error: AnalysisError): string =>
  typeof error.cause === "string" && error.cause.length > 0
    ? error.cause
    : error.message;
