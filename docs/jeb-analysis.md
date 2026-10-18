# JEB instrumentation and analysis

REA exposes JEB-backed project, unit, and decompilation inspection through the CLI and MCP, served by JEB's own MCP interface. JEB is a bring-your-own engine: REA never installs it, launches it, or opens its project databases itself.

## Bring-your-own engine

Start a JEB client that serves MCP and point REA at it:

- Default endpoint: `http://127.0.0.1:8425/mcp`. Override with `REA_JEB_MCP_URL` (absolute `http`/`https` URL with literal host `127.0.0.1` or `[::1]`; redirects, remote hosts, credentials, query strings, and fragments are rejected rather than silently dropped).
- In the JEB GUI client, start the MCP server from the _File_ menu (or via the VIBRE assistant).
- **Linux Community Edition (CE), verified route:** JEB 5.48.0 can start its MCP server directly in headless mode using `./jeb_linux.sh -c --mcp`. Use the JDK supported by the installation and consult `./jeb_linux.sh -c --help` for the available options, including input selection with `--infile`. The documented default MCP endpoint is `http://localhost:8425/mcp`; when connecting REA, use `http://127.0.0.1:8425/mcp` because `REA_JEB_MCP_URL` rejects `localhost`. The direct-launch verification described here is limited to the tested Linux x86-64 CE build; it does not establish equivalent behavior on other platforms or for untested analysis types.
- **GUI and programmatic alternatives:** The MCP server can also be started from the JEB GUI or through the documented `JebMcpServerInstance` API. Earlier licensed-build results should not be generalized to every launcher or build. REA does not install JEB, launch the engine, or open its project databases itself.
  For setup registration, set `REA_JEB_MCP_URL` in the REA process environment
  before running `rea setup`. The approved setup plan preserves the exact selected
  URL after validating its syntax. That validation does not establish that the
  JEB service is reachable or that a project is open; use the existing
  `inspect-jeb-client` command for a read-only service query.

MCP `binary_session` probes the live JEB service and its advertised tool catalog.
Availability is reported per operation: a reachable headless client can support
inspection and decompilation while refusing `open_jeb_project`. Catalog discovery
uses one 60-second deadline across connection and pagination; a responsive server
cannot keep discovery running indefinitely by returning more pages.

Each upstream tool call has an absolute 60-second request deadline by default.
Set `REA_JEB_MCP_TIMEOUT_MS` to a positive decimal number of milliseconds to
select a different per-request budget, for example `REA_JEB_MCP_TIMEOUT_MS=300000`
for a five-minute decompilation. This budget starts after discovery and applies
to each individual `tools/call`; it does not extend the separate catalog deadline
or establish one end-to-end deadline across a whole CLI or MCP operation. A
request that reaches its budget returns a typed timeout, while caller
cancellation remains a cancellation.

Verified against JEB 5.48.0 (Linux x64, licensed build) serving `jeb-mcp-server` 1.3.0 over streamable HTTP.

## Operations

| MCP tool / CLI command                      | Purpose                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_jeb_client` / `inspect-jeb-client` | Engine version, GUI or headless mode, startup time                                                                              |
| `open_jeb_project` / `open-jeb-project`     | Open or create a project from an artifact or `.jdb2` on the engine host; returns input-file SHA-256 digests and top-level units |
| `list_jeb_units` / `list-jeb-units`         | Page units by stable path and type (`filter`, `parent-unit-path`, `index`, `count`)                                             |
| `decompile_jeb_item` / `decompile-jeb-item` | Decompile one type or method to engine pseudo-code                                                                              |

All four are read-only with respect to the target file; only `open_jeb_project` changes engine-side project state, and Evidence records the endpoint, the caller-selected parameters, and the engine-reported digests. Mutation workflows the engine also offers (renames, comments, `save_project`, `close_project`) are intentionally not exposed yet.

**Engine coverage note (verified):** JEB 5.48.0 headless MCP instances do not advertise `open_project` — the target must be selected when the engine client starts (`--infile` on the programmatic launcher, or the GUI's file opening). REA preserves that refusal with the engine's reason instead of failing silently; `open_jeb_project` completes only against engine builds that advertise the tool, such as GUI clients.

## Semantics

- Paths in `open_jeb_project` are resolved by the JEB process, not by REA; REA does not require the artifact to exist locally.
- The engine caps `list_units` pages at 100; a full page is reported as `coverage: "partial"` because more units may exist. An empty remainder is `complete` only when fewer units than requested were returned.
- When `decompile_jeb_item` omits `unit_path`, the engine implicitly selects the project's first code unit; REA reports `unit_path: null` and a limitation instead of guessing the effective unit.
- Engine refusals (`success: false` envelopes) are preserved as unsupported-target errors carrying the engine's own message, for example a nonexistent item address.
- Successfully parsed client information is reused for the lifetime of the MCP connection, including when the engine omits its version. Explicit client inspection and availability probes refresh it.
- An unreachable endpoint is a provider-availability failure with recovery guidance; REA does not retry or spawn the engine.

Real-engine verification lives in the JEB lane described in [testing.md](testing.md); mock transport tests do not establish real-engine compatibility.
