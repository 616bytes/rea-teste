import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sourceWindowsNativeLoader = new URL(
  "../../src/windows/WindowsNativeLoader.ts",
  import.meta.url,
).href;
const sourceWindowsProcess = new URL(
  "../../src/windows/WindowsOwnedProcess.ts",
  import.meta.url,
).href;

/** Import source modules through one tsx namespace, without a generated dist tree. */
async function importWindowsSources(load) {
  const { register } = await import("tsx/esm/api");
  const scope = register({
    namespace: `rea-exclusive-${process.pid}-${Math.random().toString(36).slice(2)}`,
  });
  try {
    return await load((url) => scope.import(url, import.meta.url));
  } finally {
    await scope.unregister();
  }
}

/** Load the source owner without requiring a generated dist tree. */
export async function loadWindowsOwnedProcessClass() {
  return importWindowsSources(async (importSource) => {
    const source = await importSource(sourceWindowsProcess);
    return source.WindowsOwnedProcess;
  });
}

/**
 * Ask the package-owned loader whether Windows native controls are available.
 * The owner class is loaded only alongside a verified authority; nothing is
 * downloaded or installed, and an unavailable result keeps the loader's reason.
 */
export async function loadWindowsCommandOwnership() {
  return importWindowsSources(async (importSource) => {
    const loader = await importSource(sourceWindowsNativeLoader);
    const loaded = loader.systemWindowsNativeAuthority();
    if (!loaded.available) return loaded;
    const source = await importSource(sourceWindowsProcess);
    return { ...loaded, WindowsOwnedProcess: source.WindowsOwnedProcess };
  });
}

/** Explain the reduced supervision used when no native owner is available. */
export function describeUnownedWindowsCommand(lockName, reason) {
  return [
    reason,
    `The ${lockName} command runs without Windows Job Object ownership: the command lock is released when the command leader exits, and cancellation stops only that leader, so descendants it leaves behind are not covered. Restore the artifact as described in native/windows/README.md#restore-the-artifact-in-a-source-checkout to reinstate owned supervision.`,
  ].join("\n");
}

/** Start an owned Windows command while preserving cross-spawn's shim rules. */
export function createWindowsOwnedCommand(options) {
  const {
    WindowsOwnedProcess,
    command,
    arguments: arguments_,
    cwd,
    environment,
    authority,
  } = options;
  // This pinned private parser is cross-spawn's own resolution and cmd-shim
  // boundary. Keep its compatibility coupling here instead of copying its rules.
  const parse = require("cross-spawn/lib/parse");
  const parsed = parse(command, arguments_, { cwd, env: environment });
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.command !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((argument) => typeof argument === "string") ||
    typeof parsed.options !== "object" ||
    parsed.options === null ||
    (parsed.options.windowsVerbatimArguments !== undefined &&
      typeof parsed.options.windowsVerbatimArguments !== "boolean")
  )
    throw new TypeError(
      "cross-spawn returned an unsupported Windows command shape",
    );
  // cross-spawn keeps the user's spelling in `command` for a resolved .exe
  // (for example bare `node`), while `file` is the PATH-resolved executable.
  // The native boundary intentionally requires an absolute application path.
  const executable =
    parsed.command === command && typeof parsed.file === "string"
      ? parsed.file
      : parsed.command;
  return new WindowsOwnedProcess(
    executable,
    parsed.args,
    cwd,
    environment,
    parsed.options.windowsVerbatimArguments === true,
    {
      protocolStdin: true,
      ...(authority === undefined ? {} : { authority }),
    },
  );
}

/** Own a native command until its exact Job Object close event. */
export function superviseWindowsOwnedProcess(
  child,
  { retryIntervalMs = 1_000, onCleanupDiagnostic = () => {} } = {},
) {
  const childStdin = child.stdin ?? undefined;
  let jobClosed = false;
  let stdinClosed = childStdin === undefined;
  let settled = false;
  let closeResult;
  let hasFirstError = false;
  let firstError;
  let retryTimer;
  let cleanupInFlight = false;
  let lastCleanupFailure;
  let reportedCleanupFailure = false;

  const finished = new Promise((resolveResult, reject) => {
    child.on("error", handleError);
    child.once("close", (code, signal) => {
      jobClosed = true;
      closeResult = { code, signal };
      clearTimeout(retryTimer);
      child.off("error", handleError);
      finishWhenClosed(resolveResult, reject);
    });
    childStdin?.on("error", handleError);
    childStdin?.once("close", () => {
      stdinClosed = true;
      childStdin.off("error", handleError);
      finishWhenClosed(resolveResult, reject);
    });
  });

  function finishWhenClosed(resolveResult, reject) {
    if (!jobClosed || !stdinClosed || settled) return;
    settled = true;
    if (reportedCleanupFailure) {
      onCleanupDiagnostic({ type: "cleanup-recovered" });
      reportedCleanupFailure = false;
      lastCleanupFailure = undefined;
    }
    if (hasFirstError) reject(firstError);
    else resolveResult(closeResult);
  }

  function handleError(cause) {
    if (!hasFirstError) {
      hasFirstError = true;
      firstError = cause;
    }
    requestCleanup();
  }

  function scheduleRetry() {
    if (jobClosed || retryTimer !== undefined) return;
    // Keep this timer referenced: until Job Object close, it is the supervisor's
    // live ownership observer even after IPC disconnect or stdin EOF.
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requestCleanup();
    }, retryIntervalMs);
  }

  function reportFailure(reason) {
    if (jobClosed) return;
    if (reportedCleanupFailure && lastCleanupFailure === reason) return;
    lastCleanupFailure = reason;
    reportedCleanupFailure = true;
    onCleanupDiagnostic({ type: "cleanup-failed", reason });
  }

  function requestCleanup() {
    if (jobClosed || cleanupInFlight) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    cleanupInFlight = true;
    let cleanup;
    try {
      cleanup = child.cleanup();
    } catch (cause) {
      reportFailure(cause instanceof Error ? cause.message : String(cause));
      cleanupInFlight = false;
      scheduleRetry();
      return;
    }
    void Promise.resolve(cleanup)
      .then((result) => {
        if (!result.cleaned) {
          reportFailure(
            result.reason ?? "Windows Job Object cleanup did not complete",
          );
          return;
        }
        if (!jobClosed)
          reportFailure(
            "Windows Job Object cleanup reported success before its close event",
          );
      })
      .catch((cause) => {
        reportFailure(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        cleanupInFlight = false;
        scheduleRetry();
      });
  }

  return { finished, requestCleanup };
}
