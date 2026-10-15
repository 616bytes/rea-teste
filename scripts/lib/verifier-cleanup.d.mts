/** Options bounding an owned cleanup retry for a transient conflict. */
export interface TransientCleanupRetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
}

/**
 * Retry an owned cleanup that failed with a proven transient Windows
 * sharing/lock conflict; any other failure propagates unchanged.
 */
export function retryTransientCleanup<T>(
  task: () => T | Promise<T>,
  options?: TransientCleanupRetryOptions,
): Promise<T>;

/** Attempt every owned cleanup and retain the primary verification failure. */
export function closeVerifierResources(
  tasks: readonly (() => void | Promise<void>)[],
  primaryError?: unknown,
): Promise<void>;
