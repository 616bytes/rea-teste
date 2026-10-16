# Unreal MCP (upstream reference)

Source: [Epic's Unreal MCP documentation](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor),
Unreal Engine 5.8; checked 2026-10-15. Documentation review only; no Unreal Editor
session was run.

Unreal MCP is Epic's experimental editor automation server, running inside the
editor process. It can inspect and modify editor state. Its plugin identifier is
`ModelContextProtocol`.

## Connect

1. Enable **Unreal MCP** and **All Toolsets**, then restart. **Toolset Registry**
   is enabled as a dependency.
2. Enable **Auto Start Server** in the Model Context Protocol editor preferences,
   or start it from the editor console:

   ```text
   ModelContextProtocol.StartServer
   ```

3. Generate client configuration from that console:

   ```text
   ModelContextProtocol.GenerateClientConfig <Client|All>
   ```

4. Launch the client from the configuration's project/workspace root. The default
   endpoint is `http://127.0.0.1:8000/mcp`, using Streamable HTTP. Consult the source
   for supported clients and configuration overwrite behavior.

## Discovery and execution

Default discovery exposes `list_toolsets`, `describe_toolset`, and `call_tool`.
Disabling Tool Search advertises individual tools. Python/C++ toolsets use
reflection; `ModelContextProtocol.RefreshTools` refreshes registration.

Calls execute serially on the game thread. Keep the endpoint local; authentication
is absent. Cooked builds require explicit tool registration.

## REA relationship

This reference does not represent an implemented REA provider. REA's own interfaces
are documented in [MCP contracts](mcp-contracts.md) and [tool design](tool-design.md).

See the [MCP ecosystem survey](mcp-ecosystem.md) for other application servers.
