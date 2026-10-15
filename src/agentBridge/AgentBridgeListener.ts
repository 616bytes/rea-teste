import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

/** Version of the hello exchange that precedes the carried MCP stream. */
export const AGENT_BRIDGE_PROTOCOL_VERSION = 1;

const HELLO = "rea-agent-bridge";
const CARRIER = "mcp-jsonrpc-ndjson";
const MAX_HELLO_BYTES = 4096;
const DEFAULT_HELLO_TIMEOUT_MS = 2000;
const MAX_PENDING_HANDSHAKES = 8;
const SOCKET_NAME = "s";

const helloSchema = z
  .object({
    hello: z.literal(HELLO),
    version: z.number().int(),
    token: z.string(),
  })
  .strict();

/** Connection coordinates handed only to the process that launched the bridge. */
export interface AgentBridgeDescriptor {
  readonly version: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  readonly socket_path: string;
  /** Transport authentication credential; never log or persist it. */
  readonly token: string;
}

/** One accepted connection's cleanup owner. */
export interface AgentBridgeConnection {
  /** Retryable: a rejected close leaves the owner responsible for the retry. */
  close(): Promise<void>;
}

export interface AgentBridgeListenerOptions {
  readonly logger: Logger;
  /** Bind an authenticated socket to a server whose stream starts at the next byte. */
  readonly serveConnection: (socket: Socket) => Promise<AgentBridgeConnection>;
  readonly helloTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

export interface AgentBridgeStartFailure {
  readonly reason:
    | "unsupported_platform"
    | "private_root_unavailable"
    | "listen_failed";
  readonly message: string;
  readonly cause?: unknown;
}

type HelloReadFailure = "closed" | "timeout" | "oversize";

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/** Read one bounded hello line; bytes after it stay queued for the carried stream. */
const readHelloLine = (
  socket: Socket,
  timeoutMs: number,
): Promise<Result<string, HelloReadFailure>> =>
  new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const settle = (result: Result<string, HelloReadFailure>): void => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("close", onClose);
      resolve(result);
    };
    const onClose = (): void => settle(err("closed"));
    const onReadable = (): void => {
      for (
        let chunk: Buffer | null = socket.read() as Buffer | null;
        chunk !== null;
        chunk = socket.read() as Buffer | null
      ) {
        buffered = Buffer.concat([buffered, chunk]);
        const newline = buffered.indexOf(0x0a);
        if ((newline < 0 ? buffered.length : newline) > MAX_HELLO_BYTES)
          return settle(err("oversize"));
        if (newline >= 0) {
          const rest = buffered.subarray(newline + 1);
          if (rest.length > 0) socket.unshift(rest);
          return settle(ok(buffered.subarray(0, newline).toString("utf8")));
        }
      }
    };
    const timer = setTimeout(() => settle(err("timeout")), timeoutMs);
    socket.on("readable", onReadable);
    socket.once("close", onClose);
    onReadable();
  });

interface ActiveConnection {
  readonly socket: Socket;
  owner: AgentBridgeConnection | undefined;
  cleanupFailed: boolean;
  done: Promise<void>;
}

/**
 * Owns REA's local agent bridge: an owner-only Unix socket that carries one
 * authenticated MCP stream at a time. The hello line is the only bridge-owned
 * protocol; every byte after it belongs to the carried MCP server.
 */
export class AgentBridgeListener {
  #active: ActiveConnection | undefined;
  #closing: Promise<void> | undefined;
  readonly #pending = new Set<Socket>();
  readonly #expected: Buffer;

  private constructor(
    readonly descriptor: AgentBridgeDescriptor,
    private readonly server: Server,
    private readonly root: PrivateRuntimeRoot,
    private readonly options: AgentBridgeListenerOptions,
  ) {
    this.#expected = digest(descriptor.token);
    server.on("connection", (socket) => {
      void this.#accept(socket);
    });
  }

  static async start(
    options: AgentBridgeListenerOptions,
  ): Promise<Result<AgentBridgeListener, AgentBridgeStartFailure>> {
    const platform = options.platform ?? process.platform;
    if (platform === "win32")
      return err({
        reason: "unsupported_platform",
        message:
          "The agent bridge needs an owner-only Unix socket directory, which is unverified on Windows.",
      });
    let root: PrivateRuntimeRoot;
    try {
      root = await PrivateRuntimeRoot.create({ prefix: "rea-agent-bridge-" });
    } catch (cause: unknown) {
      return err({
        reason: "private_root_unavailable",
        message:
          "The agent bridge could not create a private socket directory.",
        cause,
      });
    }
    const socketPath = join(root.path, SOCKET_NAME);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (cause: unknown) {
      server.close();
      await root.close().catch(() => undefined);
      return err({
        reason: "listen_failed",
        message: "The agent bridge could not listen on its Unix socket.",
        cause,
      });
    }
    server.on("error", (cause) =>
      options.logger.error(
        { error: cause.message },
        "Agent bridge server error",
      ),
    );
    return ok(
      new AgentBridgeListener(
        {
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
          socket_path: socketPath,
          token: randomBytes(32).toString("base64url"),
        },
        server,
        root,
        options,
      ),
    );
  }

  async #accept(socket: Socket): Promise<void> {
    const { logger } = this.options;
    socket.on("error", (cause) =>
      logger.debug({ error: cause.message }, "Agent bridge socket error"),
    );
    if (
      this.#closing !== undefined ||
      this.#pending.size >= MAX_PENDING_HANDSHAKES
    )
      return void socket.destroy();
    this.#pending.add(socket);
    const line = await readHelloLine(
      socket,
      this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    );
    this.#pending.delete(socket);
    if (!line.ok) {
      logger.warn({ reason: line.error }, "Agent bridge handshake failed");
      return void socket.destroy();
    }
    const parsed = safeParseJson(line.value);
    const hello = parsed.ok ? helloSchema.safeParse(parsed.value) : undefined;
    // Malformed and unauthenticated peers get the same answer and no detail.
    if (
      hello === undefined ||
      !hello.success ||
      !timingSafeEqual(this.#expected, digest(hello.data.token))
    ) {
      logger.warn({ reason: "unauthenticated" }, "Agent bridge peer rejected");
      return this.#reject(socket, "unauthenticated");
    }
    if (hello.data.version !== AGENT_BRIDGE_PROTOCOL_VERSION)
      return this.#reject(socket, "unsupported_version");
    if (this.#active?.cleanupFailed === true) await this.#release(this.#active);
    if (this.#active !== undefined) return this.#reject(socket, "busy");
    this.#claim(socket);
  }

  #reject(socket: Socket, reason: string): void {
    socket.end(`${JSON.stringify({ error: reason })}\n`);
  }

  #claim(socket: Socket): void {
    const { logger } = this.options;
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    const active: ActiveConnection = {
      socket,
      owner: undefined,
      cleanupFailed: false,
      done: Promise.resolve(),
    };
    this.#active = active;
    socket.write(
      `${JSON.stringify({
        hello: HELLO,
        version: AGENT_BRIDGE_PROTOCOL_VERSION,
        carrier: CARRIER,
      })}\n`,
    );
    active.done = (async () => {
      try {
        active.owner = await this.options.serveConnection(socket);
        logger.info("Agent bridge connection opened");
      } catch (cause: unknown) {
        logger.error(
          { error: cause instanceof Error ? cause.message : String(cause) },
          "Agent bridge could not serve the connection",
        );
        socket.destroy();
      }
      await closed;
      await this.#release(active);
    })();
  }

  /** Release the slot only once the owner's cleanup succeeded. */
  async #release(active: ActiveConnection): Promise<void> {
    active.socket.destroy();
    try {
      await active.owner?.close();
      if (this.#active === active) this.#active = undefined;
      active.cleanupFailed = false;
    } catch (cause: unknown) {
      active.cleanupFailed = true;
      this.options.logger.error(
        { error: cause instanceof Error ? cause.message : String(cause) },
        "Agent bridge connection cleanup failed; the slot stays held for retry",
      );
    }
  }

  /** Stop accepting, end the active connection and remove the socket directory. */
  close(): Promise<void> {
    this.#closing ??= this.#close().catch((cause: unknown) => {
      this.#closing = undefined;
      throw cause;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    for (const socket of this.#pending) socket.destroy();
    const active = this.#active;
    if (active !== undefined) {
      active.socket.destroy();
      await active.done;
      if (active.cleanupFailed) await this.#release(active);
    }
    await stopped;
    const failures: unknown[] = [];
    if (this.#active?.cleanupFailed === true)
      failures.push(new Error("Agent bridge connection cleanup failed"));
    await this.root.close().catch((cause: unknown) => failures.push(cause));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Agent bridge cleanup failed");
  }
}

/** One-line JSON the launcher reads from stdout to reach the bridge. */
export const formatAgentBridgeDescriptor = (
  descriptor: AgentBridgeDescriptor,
): string => `${JSON.stringify({ rea_agent_bridge: descriptor })}\n`;
