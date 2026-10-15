"""Reference client for REA's local agent bridge (standard library only).

The bridge is a Unix socket that carries REA's MCP server as newline-delimited
JSON-RPC 2.0, after one hello line that proves possession of the launch token.
Launch the bridge, read the descriptor line it prints on stdout, then connect:

    client, process = launch_bridge(["node", "dist/agentBridge/main.js"])
    with client:
        print([tool["name"] for tool in client.list_tools()])

Closing the process's stdin stops the bridge. The token is a credential: keep it
in memory and do not log it.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from typing import Any

HELLO = "rea-agent-bridge"
PROTOCOL_VERSION = 1
MCP_PROTOCOL_VERSION = "2025-11-25"


class ReaBridgeError(Exception):
    """The bridge refused the connection or returned a JSON-RPC error."""


class ReaBridgeClient:
    def __init__(self, socket_path: str, token: str, timeout: float = 120.0):
        self._socket_path = socket_path
        self._token = token
        self._timeout = timeout
        self._socket: socket.socket | None = None
        self._reader: Any = None
        self._next_id = 0

    def __enter__(self) -> "ReaBridgeClient":
        self.connect()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self._timeout)
        sock.connect(self._socket_path)
        self._socket = sock
        self._reader = sock.makefile("rb")
        self._send(
            {"hello": HELLO, "version": PROTOCOL_VERSION, "token": self._token}
        )
        reply = self._read()
        if reply.get("error") is not None:
            raise ReaBridgeError(f"bridge refused the connection: {reply['error']}")
        if reply.get("hello") != HELLO or reply.get("version") != PROTOCOL_VERSION:
            raise ReaBridgeError("unexpected bridge hello")
        self.request(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "rea-agent-client", "version": "0.1.0"},
            },
        )
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._next_id += 1
        request_id = self._next_id
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        while True:
            reply = self._read()
            if "method" in reply:
                # Server notifications are ignored; server requests get an empty answer.
                if "id" in reply:
                    self._send({"jsonrpc": "2.0", "id": reply["id"], "result": {}})
                continue
            if reply.get("id") != request_id:
                continue
            if "error" in reply:
                raise ReaBridgeError(json.dumps(reply["error"]))
            return reply.get("result")

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            result = self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools.extend(result["tools"])
            cursor = result.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Return the MCP CallToolResult; `isError` and `_meta` are preserved."""
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def _send(self, message: dict[str, Any]) -> None:
        assert self._socket is not None
        self._socket.sendall(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    def _read(self) -> dict[str, Any]:
        line = self._reader.readline()
        if not line:
            raise ReaBridgeError("bridge closed the connection")
        return json.loads(line)


def launch_bridge(
    command: list[str], timeout: float = 120.0
) -> tuple[ReaBridgeClient, subprocess.Popen[bytes]]:
    """Start the bridge process and return an unconnected client for it."""
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    assert process.stdout is not None
    line = process.stdout.readline()
    if not line:
        process.kill()
        raise ReaBridgeError("bridge exited before printing its descriptor")
    descriptor = json.loads(line)["rea_agent_bridge"]
    return ReaBridgeClient(descriptor["socket_path"], descriptor["token"], timeout), process


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: rea_agent_client.py BRIDGE_COMMAND...", file=sys.stderr)
        return 2
    client, process = launch_bridge(argv[1:])
    try:
        with client:
            for tool in client.list_tools():
                print(tool["name"])
    finally:
        assert process.stdin is not None
        process.stdin.close()
        process.wait(timeout=30)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
