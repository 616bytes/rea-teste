import { setTimeout as delay } from "node:timers/promises";

/**
 * Windows sharing (32) and lock (33) conflicts are the only kernel codes the
 * native authority treats as a transient, retryable conflict. Every other
 * failure (permission, missing allocation evidence, opaque text) is a real
 * defect and must not be retried.
 */
const TRANSIENT_WIN32_SHARING_CODES = new Set([32, 33]);

const isTransientSharingConflict = (cause) =>
  typeof cause === "object" &&
  cause !== null &&
  cause.code === "ERR_REA_WINDOWS_NATIVE" &&
  TRANSIENT_WIN32_SHARING_CODES.has(cause.win32Code);

/**
 * Retry an owned cleanup that failed with a proven transient Windows
 * sharing/lock conflict. The producer already retains ownership after a failed
 * close, so a bounded retry lets a just-exited child release its handle before
 * the verifier reports a false cleanup failure. Any other failure propagates
 * unchanged, and the last cause surfaces once the budget is exhausted.
 */
export async function retryTransientCleanup(task, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 100;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (cause) {
      if (attempt >= attempts || !isTransientSharingConflict(cause))
        throw cause;
      if (delayMs > 0) await delay(delayMs);
    }
  }
}

/** Attempt every owned cleanup and retain the primary verification failure. */
export async function closeVerifierResources(tasks, primaryError) {
  const failures = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      primaryError === undefined ? failures : [primaryError, ...failures],
      "Verifier cleanup failed",
    );
}
