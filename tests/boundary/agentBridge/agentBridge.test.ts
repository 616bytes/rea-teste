import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { access, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentBridgeListener,
  type AgentBridgeConnection,
} from "../../../src/agentBridge/AgentBridgeListener.js";
import { serveAgentBridgeConnection } from "../../../src/agentBridge/serveAgentBridgeConnection.js";
import { createManagedBinarySession } from "../../../src/composition/binary.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const logger = pino({ enabled: false });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const startListener = async (
  serveConnection?: (socket: Socket) => Promise<AgentBridgeConnection>,
  helloTimeoutMs?: number,
) => {
  const session = createManagedBinarySession();
  const started = await AgentBridgeListener.start({
    logger,
    ...(helloTimeoutMs === undefined ? {} : { helloTimeoutMs }),
    serveConnection:
      serveConnection ??
      ((socket) =>
        serveAgentBridgeConnection(socket, {
          session,
          environment: {},
          delivery: createToolResultDelivery(undefined),
          logger,
          serverLogger: logger,
          writeStderr: () => undefined,
          loadOptionalProviders: async () => ({}),
        })),
  });
  if (!started.ok) throw new Error(started.error.message);
  const listener = started.value;
  cleanup.push(async () => {
    await listener.close();
    await session.close();
  });
  return listener;
};

/** Collect socket bytes as lines; resolves each wait in arrival order. */
const lineReader = (socket: Socket) => {
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let buffered = "";
  let ended = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (
      let index = buffered.indexOf("\n");
      index >= 0;
      index = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    }
  });
  socket.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });
  socket.on("error", () => undefined);
  return {
    next: (): Promise<string | null> =>
      new Promise((resolve) => {
        const line = lines.shift();
        if (line !== undefined) resolve(line);
        else if (ended) resolve(null);
        else waiting.push(resolve);
      }),
  };
};

const open = async (socketPath: string) => {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  cleanup.push(async () => void socket.destroy());
  return { socket, ...lineReader(socket) };
};

const hello = (token: string, version = 1) =>
  `${JSON.stringify({ hello: "rea-agent-bridge", version, token })}\n`;
const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "1.0.0" },
  },
})}\n`;

describe("agent bridge", () => {
  it("serves the production tool catalog after a pipelined hello", async () => {
    const listener = await startListener();
    const { descriptor } = listener;
    const peer = await open(descriptor.socket_path);
    // Hello and the first MCP request arrive in one write.
    peer.socket.write(hello(descriptor.token) + initialize);
    expect(JSON.parse((await peer.next()) ?? "")).toMatchObject({
      hello: "rea-agent-bridge",
      version: 1,
      carrier: "mcp-jsonrpc-ndjson",
    });
    expect(JSON.parse((await peer.next()) ?? "")).toMatchObject({
      id: 1,
      result: { serverInfo: expect.anything() },
    });
    peer.socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const listed = JSON.parse((await peer.next()) ?? "") as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.length).toBeGreaterThan(20);
    expect(listed.result.tools.map(({ name }) => name)).toContain(
      "binary_session",
    );
  });

  it("owns an owner-only socket directory and removes it on close", async () => {
    const listener = await startListener();
    const socketPath = listener.descriptor.socket_path;
    const directory = socketPath.slice(0, socketPath.lastIndexOf("/"));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await listener.close();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers wrong tokens and malformed hellos identically, without admitting them", async () => {
    const listener = await startListener();
    const { descriptor } = listener;
    for (const bytes of [
      hello("not-the-token"),
      "not json\n",
      `${JSON.stringify({ hello: "other", version: 1, token: descriptor.token })}\n`,
    ]) {
      const peer = await open(descriptor.socket_path);
      peer.socket.write(bytes);
      expect(JSON.parse((await peer.next()) ?? "")).toEqual({
        error: "unauthenticated",
      });
      expect(await peer.next()).toBeNull();
    }
    // None of the rejected peers took the slot.
    const peer = await open(descriptor.socket_path);
    peer.socket.write(hello(descriptor.token));
    expect(JSON.parse((await peer.next()) ?? "")).toMatchObject({
      hello: "rea-agent-bridge",
    });
  });

  it("reports an unsupported version only to an authenticated peer", async () => {
    const listener = await startListener();
    const { descriptor } = listener;
    const peer = await open(descriptor.socket_path);
    peer.socket.write(hello(descriptor.token, 2));
    expect(JSON.parse((await peer.next()) ?? "")).toEqual({
      error: "unsupported_version",
    });
  });

  it("drops silent and oversized peers", async () => {
    const listener = await startListener(undefined, 50);
    const silent = await open(listener.descriptor.socket_path);
    expect(await silent.next()).toBeNull();
    const oversized = await open(listener.descriptor.socket_path);
    oversized.socket.write("x".repeat(8192));
    expect(await oversized.next()).toBeNull();
  });

  it("admits one authenticated connection at a time and frees the slot on disconnect", async () => {
    const listener = await startListener();
    const { descriptor } = listener;
    const first = await open(descriptor.socket_path);
    first.socket.write(hello(descriptor.token));
    expect(JSON.parse((await first.next()) ?? "")).toMatchObject({
      hello: "rea-agent-bridge",
    });
    const second = await open(descriptor.socket_path);
    second.socket.write(hello(descriptor.token));
    expect(JSON.parse((await second.next()) ?? "")).toEqual({ error: "busy" });
    first.socket.destroy();
    // The slot frees once cleanup finishes; poll the observable admission.
    let admitted = false;
    for (let attempt = 0; attempt < 50 && !admitted; attempt += 1) {
      const third = await open(descriptor.socket_path);
      third.socket.write(hello(descriptor.token));
      const reply = JSON.parse((await third.next()) ?? "") as {
        hello?: string;
      };
      admitted = reply.hello === "rea-agent-bridge";
      if (!admitted) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(admitted).toBe(true);
  });

  it("holds the slot and retries when connection cleanup fails", async () => {
    let attempts = 0;
    let allowed = false;
    const listener = await startListener(async () => ({
      close: async () => {
        attempts += 1;
        if (!allowed) throw new Error("cleanup denied");
      },
    }));
    const { descriptor } = listener;
    const first = await open(descriptor.socket_path);
    first.socket.write(hello(descriptor.token));
    await first.next();
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = await open(descriptor.socket_path);
    refused.socket.write(hello(descriptor.token));
    expect(JSON.parse((await refused.next()) ?? "")).toEqual({ error: "busy" });
    expect(attempts).toBeGreaterThanOrEqual(2);
    allowed = true;
    const admitted = await open(descriptor.socket_path);
    admitted.socket.write(hello(descriptor.token));
    expect(JSON.parse((await admitted.next()) ?? "")).toMatchObject({
      hello: "rea-agent-bridge",
    });
  });
});

describe("agent bridge reference client", () => {
  const python = spawnSync("python3", ["--version"]).status === 0;
  it.runIf(python)("is drivable by the stdlib reference client", async () => {
    const listener = await startListener();
    const { descriptor } = listener;
    const script = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../../../bridge/agent", import.meta.url)))})`,
      "from rea_agent_client import ReaBridgeClient",
      "d = json.loads(sys.argv[1])",
      "with ReaBridgeClient(d['socket_path'], d['token'], 30) as c:",
      "    names = [t['name'] for t in c.list_tools()]",
      "    result = c.call_tool('binary_session')",
      "    print(json.dumps({'names': names, 'has_content': 'content' in result}))",
    ].join("\n");
    // Async spawn: the listener shares this event loop.
    const child = await promisify(execFile)(
      "python3",
      ["-I", "-c", script, JSON.stringify(descriptor)],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(child.stderr).toBe("");
    const out = JSON.parse(child.stdout) as {
      names: string[];
      has_content: boolean;
    };
    expect(out.names).toContain("binary_session");
    expect(out.has_content).toBe(true);
  });
});
