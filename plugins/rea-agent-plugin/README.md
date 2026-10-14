# REA Reverse Engineering Plugin

A packaged agent plugin for **Claude Code** and **Codex**. It combines an evidence-first investigation skill with REA's MCP server configuration.

REA's upstream project already provides an interactive setup flow for Claude Code and Codex. This folder is an additional portable plugin package; it does not replace the main repository's existing setup tooling.

## Requirements

- Node.js version supported by REA and npm.
- Network access for the first `npx` package run.
- An authorized target for analysis.
- Depending on the target, optional analysis providers such as Hopper, Ghidra, IDA, JADX, adb, or other tools documented by REA.

The MCP configuration launches the published `rea-agents` npm package using `npx -y rea-agents@latest mcp`. That means it follows the published package, **not uncommitted changes in this GitHub fork**. To test source changes in this repository, use its development instructions and local CLI instead.

## Package contents

- `plugin.json`: portable Agent Plugins manifest.
- `.codex-plugin/plugin.json`: Codex-compatible manifest.
- `.claude-plugin/plugin.json`: Claude Code plugin manifest.
- `.mcp.json`: REA MCP server registration.
- `skills/reverse-engineer-anything/SKILL.md`: evidence-first investigation workflow.

## Use with Codex

Use the folder `plugins/rea-agent-plugin` as the plugin root in a supported Codex plugin/marketplace workflow. For local testing, add this folder as a plugin source/marketplace entry using the instructions for your installed Codex version, then enable **REA Reverse Engineering** and start a new session.

## Use with Claude Code

Add this directory as a local plugin marketplace/source according to the Claude Code plugin documentation, then install/enable `rea-reverse-engineering`. Restart Claude Code after installation and confirm the `rea` MCP server is available.

If you prefer REA's built-in setup, run:

```bash
npx rea-agents@latest setup
```

Choose Claude Code and/or Codex, review the exact configuration changes, approve them, and restart the selected agent. This path installs the workflow and registers the matching MCP server.

## Verify the connection

1. Start a new agent session.
2. Confirm the `rea` MCP server is listed and its tools are available.
3. Ask for a small, read-only analysis of a file or application you own or are authorized to inspect.
4. Confirm the report separates evidence, hypotheses, unknowns, and provider limitations.
5. If REA is missing, run the relevant readiness checks from the main repository's `docs/installation.md`; do not assume an analysis provider is installed just because MCP connected.

## Safety and license notes

Analyze only software and data you own or are authorized to examine. Runtime analysis may have side effects. Commercial tools remain subject to their own licenses. The plugin does not grant licenses to external tools or bypass access controls.
