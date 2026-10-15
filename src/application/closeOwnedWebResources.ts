import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

export interface CloseOwnedWebResourcesOptions {
  readonly providerId?: string;
  readonly operation?: string;
}

const extractCleanupDetails = (
  cause: unknown,
): { readonly reason: string; readonly resources: readonly string[] } => {
  if (cause instanceof AnalysisError) {
    return {
      reason: cause.cleanup?.reason ?? cause.message,
      resources: cause.cleanupResources,
    };
  }
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    return cause.cleanup;
  }
  if (cause instanceof AggregateError) {
    const nested = cause.errors.map(extractCleanupDetails);
    return {
      reason:
        nested
          .map(({ reason }) => reason)
          .filter(Boolean)
          .join("; ") || cause.message,
      resources: [...new Set(nested.flatMap(({ resources }) => resources))],
    };
  }
  return ArtifactReaderFailure.cleanupObservation(cause, "web-resource");
};

/** Attempt every web workflow cleanup owner and report all failures via tagged ProviderCleanupError. */
export const closeOwnedWebResources = async (
  close: readonly ((() => Promise<void>) | undefined)[],
  message: string,
  options?: CloseOwnedWebResourcesOptions,
): Promise<void> => {
  const results = await Promise.allSettled(
    close.flatMap((owner) =>
      owner === undefined ? [] : [Promise.resolve().then(owner)],
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 0) return;

  const observations = failures.map(extractCleanupDetails);
  const resources = [
    ...new Set(observations.flatMap(({ resources }) => resources)),
  ];
  const aggregateReason = observations
    .map(({ reason }) => reason)
    .filter(Boolean)
    .join("; ");

  throw new ProviderCleanupError(
    options?.providerId ?? "web",
    resources,
    {
      reason: aggregateReason || message,
      ...(failures.length === 1
        ? {}
        : {
            failures: failures.map((failure) =>
              failure instanceof Error ? failure.message : String(failure),
            ),
          }),
    },
    {
      message,
      cause:
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, message),
      operation: options?.operation ?? "close_web_resources",
    },
  );
};
