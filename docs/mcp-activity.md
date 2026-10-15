# MCP Operation Activity and Progress

REA records the start and completion of MCP tool calls in a local Activity Journal. This record includes the tool name, start timestamp, status, elapsed duration, and Evidence ID when available. Sensitive data such as caller arguments, credentials, and target file contents are strictly excluded.

## Lifecycle Statuses

- `running`: The tool is currently executing.
- `completed`: The tool finished successfully.
- `failed`: The tool finished with an error result.
- `cancelled`: The request was aborted or cancelled.
- `unknown`: Terminal state was indeterminate (e.g. abrupt disconnect).

## Terminal Dashboard

To query recent activity records:

```bash
rea activity --format json
```

To watch currently running and recent tasks in real time:

```bash
rea activity --watch
```

The live dashboard displays:

- Status and tool name
- Real elapsed runtime
- Estimated progress percentage based on historical runs (or a 30s default)
- Estimated time of arrival (ETA) / remaining time
- Completed tool duration

The default log location is `%LOCALAPPDATA%\rea\activity.jsonl` on Windows, and `~/.local/state/rea/activity.jsonl` on Linux/macOS. It can be overridden via `REA_ACTIVITY_LOG_PATH`.

The activity journal serves as local observability and diagnostics. It does not replace or alter analysis Evidence provenance or tool truth.

## MCP Standard Progress Notifications

When an MCP client supplies a `progressToken` in `_meta`, REA automatically emits continuous `notifications/progress` updates:

- **At start**: Emits `0/1` with a `Started REA tool: <name>` status.
- **During execution**: Emits monotonic progress updates every second with estimated percentage (`progress / 1`) and remaining duration (ETA) derived from median durations of past executions.
- **At completion**: Emits `1/1` indicating terminal completion and elapsed duration.

This allows progress-aware MCP clients (e.g. Claude Desktop, Cursor, Antigravity IDE) to display dynamic progress bars, elapsed time, and ETA indicators without active polling.
