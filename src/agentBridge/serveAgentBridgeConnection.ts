import type { Socket } from "node:net";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type { Logger } from "pino";

import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";
import type { BinarySession } from "../application/binary/BinarySession.js";
import type { RuntimeDependencies } from "../main/types.js";
import { startMcpTransport } from "../main/transport.js";
import type { ToolResultDelivery } from "../server/toolResult.js";
import type { AgentBridgeConnection } from "./AgentBridgeListener.js";

export interface AgentBridgeConnectionContext {
  readonly session: BinarySession;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly delivery: ToolResultDelivery;
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly writeStderr: (text: string) => void;
  readonly loadOptionalProviders: () => Promise<OptionalProviderLoadResult>;
  readonly createServer?: RuntimeDependencies["createServer"];
}

/**
 * Serve the production MCP server over one authenticated bridge socket. The
 * agent sees the same tools, Evidence and session semantics as stdio MCP; only
 * the carrier differs. The shared session outlives the connection.
 */
export const serveAgentBridgeConnection = async (
  socket: Socket,
  context: AgentBridgeConnectionContext,
): Promise<AgentBridgeConnection> => {
  const started = await startMcpTransport(
    {
      env: context.environment,
      serve: (factory, options) =>
        serveStdio(factory, {
          ...options,
          transport: new StdioServerTransport(socket, socket),
        }),
      writeStderr: context.writeStderr,
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
      ...(context.createServer === undefined
        ? {}
        : { createServer: context.createServer }),
    },
    context.session,
    {
      environment: context.environment,
      delivery: context.delivery,
      logger: context.logger,
      serverLogger: context.serverLogger,
      loadOptionalProviders: context.loadOptionalProviders,
    },
  );
  if (!started.ok)
    throw new Error("The MCP transport could not start on the bridge socket");
  // Each owner is retried independently; one that closed is never closed again.
  const owners = [
    { close: () => started.handle.close(), closed: false },
    { close: started.closeAndroid, closed: false },
    { close: started.closeOptionalProviders, closed: false },
  ];
  return {
    close: async () => {
      const results = await Promise.allSettled(
        owners
          .filter(({ closed }) => !closed)
          .map(async (owner) => {
            await owner.close();
            owner.closed = true;
          }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Agent bridge cleanup failed");
    },
  };
};
