import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createBinarySession } from "../composition/binary.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "../composition/optionalObservationProviders.js";
import { parseConfig } from "../config/parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createLogger } from "../logger.js";
import { openInitialTarget } from "../main/startup.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { createToolResultDelivery } from "../server/toolResult.js";
import type { RuntimeDependencies } from "../main/types.js";
import {
  AgentBridgeListener,
  formatAgentBridgeDescriptor,
} from "./AgentBridgeListener.js";
import { serveAgentBridgeConnection } from "./serveAgentBridgeConnection.js";

export interface AgentBridgeRuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => () => void;
  readonly createServer?: RuntimeDependencies["createServer"];
  readonly loadOptionalProviders?: RuntimeDependencies["loadOptionalProviders"];
}

const AGENT_BRIDGE_START_FAILED =
  "REA could not start its agent bridge. Run `rea doctor`, then restart it.";
const AGENT_BRIDGE_SHUTDOWN_FAILED =
  "REA could not close the agent bridge cleanly. End the REA process before starting it again.";

const runtimeDependencies = (): AgentBridgeRuntimeDependencies => ({
  env: process.env,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  // stdin EOF ties the bridge's lifetime to the launching agent process.
  registerShutdown: (handler) => {
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    process.stdin.once("end", handler);
    process.stdin.once("close", handler);
    process.stdin.resume();
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      process.stdin.off("end", handler);
      process.stdin.off("close", handler);
    };
  },
});

/**
 * Start the local agent bridge. The launcher reads one JSON descriptor line
 * from stdout, connects to the Unix socket, and sends the hello line. Closing
 * stdin shuts the bridge down.
 */
export const run = async (
  dependencies: AgentBridgeRuntimeDependencies = runtimeDependencies(),
): Promise<number> => {
  const environment = snapshotEnvironment(dependencies.env);
  const config = parseConfig(environment);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "agent-bridge" });
  const session = createBinarySession(config.value, logger, environment);
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    dependencies.writeStderr,
  );
  if (!opened.ok) return opened.exitCode;
  const delivery = createToolResultDelivery(config.value.mcpMaxResponseBytes);
  const loadOptionalProviders =
    dependencies.loadOptionalProviders ??
    (() =>
      loadOptionalObservationProviders(
        createOptionalObservationFactories(environment),
      ));
  const listener = await AgentBridgeListener.start({
    logger: serverLogger,
    serveConnection: (socket) =>
      serveAgentBridgeConnection(socket, {
        session,
        environment,
        delivery,
        logger,
        serverLogger,
        writeStderr: dependencies.writeStderr,
        loadOptionalProviders,
        ...(dependencies.createServer === undefined
          ? {}
          : { createServer: dependencies.createServer }),
      }),
  });
  if (!listener.ok) {
    serverLogger.error(
      { reason: listener.error.reason },
      listener.error.message,
    );
    dependencies.writeStderr(`${AGENT_BRIDGE_START_FAILED}\n`);
    const closed = await session.close();
    if (!closed.ok)
      dependencies.writeStderr(
        `${projectAnalysisError(closed.error).message}\n`,
      );
    return 1;
  }
  dependencies.writeStdout(
    formatAgentBridgeDescriptor(listener.value.descriptor),
  );
  // Each owner retries independently; a failed close is not forgotten.
  const owners = [
    { close: () => listener.value.close(), closed: false },
    {
      close: async () => {
        const closed = await session.close({ retainProviderDocuments: true });
        if (!closed.ok) throw closed.error;
      },
      closed: false,
    },
  ];
  let unregister = (): void => undefined;
  const shutdown = async (): Promise<void> => {
    const results = await Promise.allSettled(
      owners
        .filter(({ closed }) => !closed)
        .map(async (owner) => {
          await owner.close();
          owner.closed = true;
        }),
    );
    if (results.every((result) => result.status === "fulfilled")) unregister();
    else
      throw new AggregateError(
        results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        ),
        "Agent bridge shutdown failed",
      );
  };
  unregister = dependencies.registerShutdown(() => {
    shutdown().catch((cause: unknown) => {
      serverLogger.error(
        { error: cause instanceof Error ? cause.message : String(cause) },
        "Agent bridge shutdown rejected",
      );
      dependencies.setExitCode(1);
      dependencies.writeStderr(`${AGENT_BRIDGE_SHUTDOWN_FAILED}\n`);
    });
  });
  return 0;
};

/** Run the executable boundary without exposing an unexpected startup cause. */
export const runEntrypoint = async (
  start: () => Promise<number> = () => run(),
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  try {
    setExitCode(await start());
  } catch (cause: unknown) {
    void cause;
    writeStderr(`${AGENT_BRIDGE_START_FAILED}\n`);
    setExitCode(1);
  }
};

const isDirectEntrypoint = (
  entryPath: string | undefined,
  moduleUrl: string,
): boolean => {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === moduleUrl;
  } catch {
    return false;
  }
};

if (isDirectEntrypoint(CURRENT_ENTRYPOINT_PATH, import.meta.url)) {
  void runEntrypoint();
}
