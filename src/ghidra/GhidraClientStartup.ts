import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionErrorOptions,
  GhidraSessionFailureKind,
} from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";

const ANALYSIS_POLL_INTERVAL_MS = 250;

/** Inputs needed to complete the post-connection bridge handshake. */
export interface GhidraStartupHandshakeOptions {
  readonly deadline: ProviderStartupDeadline;
  readonly request: (
    method: string,
    params: JsonValue,
    options: GhidraRequestOptions,
  ) => Promise<Result<JsonValue, GhidraSessionError>>;
  readonly parseSessionInfo: (
    value: JsonValue,
  ) => Result<GhidraSessionInfo, GhidraSessionError>;
  readonly failure: (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options?: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode">,
  ) => GhidraSessionError;
  readonly startupTimeoutMs: number;
}

/** Poll the authenticated bridge until its owned analysis lifecycle is ready. */
export async function completeGhidraStartupHandshake(
  options: GhidraStartupHandshakeOptions,
): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
  while (!options.deadline.signal.aborted) {
    const ping = await requestSessionInfo(options);
    if (!ping.ok) return ping;

    if (ping.value.analysis_timed_out)
      return err(
        options.failure(
          "analysis_timeout",
          "Ghidra auto-analysis reached its per-file deadline",
        ),
      );
    if (ping.value.analysis_complete) return ping;

    const waited = await options.deadline.wait(ANALYSIS_POLL_INTERVAL_MS);
    if (waited === "aborted") break;
  }

  return err(interruptionFailure(options));
}

async function requestSessionInfo(
  options: GhidraStartupHandshakeOptions,
): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
  const ping = await options.request(
    "ping",
    {},
    {
      signal: options.deadline.signal,
      timeoutMs: options.deadline.remainingMs(),
    },
  );
  if (!ping.ok) {
    return err(
      options.deadline.signal.aborted
        ? interruptionFailure(options)
        : ping.error,
    );
  }

  return options.parseSessionInfo(ping.value);
}

const interruptionFailure = (
  options: GhidraStartupHandshakeOptions,
): GhidraSessionError =>
  options.deadline.interruption === "cancelled"
    ? options.failure("cancelled", "Ghidra startup was cancelled")
    : options.failure("timeout", "Ghidra startup deadline elapsed", undefined, {
        timeoutMs: options.startupTimeoutMs,
      });
