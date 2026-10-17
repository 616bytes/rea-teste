# Binary Ninja provider

REA adapts the MCP server built into the Binary Ninja GUI into its native analysis tools. It connects as an MCP client to a file you already opened in Binary Ninja, binds that file to the selected target by digest, and calls only read-only built-in `bn_*` tools. REA does not install, update, license, or launch Binary Ninja, and it never opens, saves, closes, renames, retypes, or comments on anything in your analysis.

The GUI MCP server ships with Binary Ninja **6.0 and later** in every GUI edition, including Personal, and runs on native Windows. Earlier releases and third-party plugins named `binary_ninja_mcp` expose a different protocol and are not supported. The headless `binaryninja_mcp` stdio server is not used by this adapter.

## Start the Binary Ninja MCP server

1. In Binary Ninja, enable the `ui.mcp.enabled` setting and restart.
2. Open the original executable you want REA to analyze, and wait for initial analysis to finish.
3. Select **Plugins > MCP > Start Server**. **Plugins > MCP > Copy Connection Info** shows the exact URL and any `Authorization` header.

The documented default endpoint is `http://127.0.0.1:24642/mcp`. When you set `ui.mcp.token`, Binary Ninja requires `Authorization: Bearer <token>`.

## Register the server with REA

Write the connection details to a JSON file and point `REA_BINARY_NINJA_MCP_CONFIG` at it:

```json
{
  "url": "http://127.0.0.1:24642/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

Omit `headers` when no token is configured. A client-style `{ "mcpServers": { "binaryninja-gui": { ... } } }` file naming exactly one server is also accepted. The URL must use `127.0.0.1` or `[::1]` without credentials, a query, or a fragment. Optional `timeoutMs` (default `300000`) bounds each request, and optional `maxInputBytes` (default 256 MiB) bounds the identity check described below.

```bash
export REA_BINARY_NINJA_MCP_CONFIG=/absolute/path/to/binary-ninja-mcp.json
export REA_ANALYSIS_PROVIDER=binary-ninja
rea function /absolute/path/to/program main --json
rea decompile /absolute/path/to/program 0x401000 --json
```

On Windows PowerShell:

```powershell
$env:REA_BINARY_NINJA_MCP_CONFIG = 'C:\analysis\binary-ninja-mcp.json'
$env:REA_ANALYSIS_PROVIDER = 'binary-ninja'
rea function 'C:\samples\program.exe' main --json
```

Select the provider once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider binary-ninja`, or MCP's `open_binary.provider_id`. Without `REA_BINARY_NINJA_MCP_CONFIG` the provider reports `not_configured`, so `auto` selection is unaffected. `rea doctor --provider binary-ninja --json` validates the registration without connecting; server availability and the open file are checked when analysis starts.

To use it from an agent, add the registration path to REA's own MCP entry, keeping the token in the separate file:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@<version-with-binary-ninja>", "mcp"],
      "env": {
        "REA_ANALYSIS_PROVIDER": "binary-ninja",
        "REA_BINARY_NINJA_MCP_CONFIG": "/absolute/path/to/binary-ninja-mcp.json"
      }
    }
  }
}
```

## Target binding

Open the **original input** in both Binary Ninja and REA, not a `.bndb` database. REA finds the one open file whose path equals the selected target, then reads that file's Raw view through `bn_memory_read` in 64 KiB pieces and requires its SHA-256 to match the target. A file opened twice, an absent file, or different bytes fail with recovery guidance; open the file and retry in the same session. Inputs larger than `maxInputBytes` are refused rather than partially verified.

REA admits PE, ELF, and thin Mach-O executables. Universal Mach-O files are refused because the Raw view holds the whole file; extract a slice with `lipo -thin` and open it in both tools. Managed .NET assemblies belong to REA's managed-code tools.

Binary Ninja keeps one **active BinaryView** per MCP server, shared by every MCP client of that instance. REA selects the target's recommended analysis view before each request and checks after the request that it is still selected, failing rather than attributing replies from a switched view. Analysis must be idle. When REA closes, it restores the view that was active before it started, on a best-effort basis. REA's close releases only its MCP connection.

## Coverage and evidence

The adapter provides procedure inventory and search, string inventory and search, procedure resolution, Pseudo C, assembly, raw instruction lines, callers, callees, address references, the admitted document, and a function dossier. Inventories follow Binary Ninja's `nextOffset` pagination and fail if a total changes while paging.

- **Names** are matched exactly by REA against Binary Ninja's function list. They are never passed to Binary Ninja's expression evaluator, so `main+4` is a missing name rather than an address.
- **Strings** are decoded from the exact bytes Binary Ninja reports, by string type. Previews Binary Ninja truncated are read in full. UTF-16 and UTF-32 strings are decoded only for little-endian architectures; others are omitted with a limitation.
- **Callees** reached through import slots are named from the symbol at the slot. Callees with neither a function nor a symbol are omitted and reported as partial coverage.
- **Address references** combine data references to the exact address with the direct call sites of a function that starts there. Binary Ninja MCP does not expose other code references into an address, such as a `lea` of a string, so every `xrefs` result is marked as possibly incomplete and trace workflows keep a residual unknown.

Complete body ranges, typed reference edges, comments, referenced strings and names, basic blocks, and source locals are unavailable; empty dossier facets mean **unknown**, not observed absence. `provider.version` identifies the REA adapter; the Binary Ninja build is not reported by the MCP server, and `serverInfo` is recorded separately. Results are live and never replayed from snapshots. Binary Ninja MCP does not yet forward cancellation, so a cancelled REA request stops waiting without interrupting work Binary Ninja already started.

## Verification

Adapter tests replay the protocol of Binary Ninja 6.0's GUI MCP server through a recording fixture and a loopback HTTP server, including authorization, protocol negotiation, pagination, escaping, identity mismatch, view switching, and selection restore. They do not establish real engine behavior.

`npm run verify:binary-ninja -- --target /absolute/path/to/program --procedure NAME` runs the production CLI and MCP server against a running Binary Ninja with the target open. It checks CLI/MCP parity for the function dossier, inventories, search, Pseudo C, assembly, instructions, callers, callees and xrefs, contract-valid results, invalid input, close, restoration of a previously selected view, and that the input is unchanged. Add `--second-procedure NAME --second-marker TEXT` to verify function switching, `--expected-string TEXT` and `--expected-xref 0xSOURCE` for independent string and reference oracles, and `--report PATH` for private local diagnostics.

The initial real workflow used Binary Ninja Personal 6.0.10601 on Windows 10 x64 with the GUI MCP server (`binaryninja_ui_mcp` 0.1.0) and the shipped Windows `notepad.exe`, with procedure `wWinMain`, second procedure `wWinMainCRTStartup` (marker `__scrt_common_main_seh`), expected string `Software\Microsoft\Notepad`, and expected reference `0x140023ec1` taken from the disassembly of `__scrt_common_main_seh`. All checks passed. Linux, macOS, other Binary Ninja releases, token-protected servers, and ELF or Mach-O targets remain unverified against a real engine.
