# REA Reverse Engineering Plugin

A packaged agent plugin for **Claude Code** and **Codex**. It combines evidence-first software investigation with a repository-contribution workflow.

REA's upstream project already provides an interactive setup flow for Claude Code and Codex. This folder is an additional portable plugin package; it does not replace the main repository's existing setup tooling.

## What agents can do

The bundled skills support two connected workflows:

- **Investigate software:** gather evidence about an authorized application's behavior, structure, dependencies, and implementation constraints.
- **Contribute to the REA repository:** understand repository instructions, frame an issue, inspect code, plan a scoped fix, add tests/docs, run checks, and prepare a reviewable handoff.

See [AGENT_WORKFLOW.md](./AGENT_WORKFLOW.md) for the recommended end-to-end loop. Use [the task contract](./templates/agent-task.md) to assign work and [the handoff template](./templates/agent-handoff.md) to report results consistently.

The plugin does not grant GitHub permissions, credentials, filesystem access, branch-push rights, or merge authority. Actual operations depend on the connected agent's tools and permissions. Repository policy remains authoritative: a human must review and own the final diff and readiness decision.

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
- `skills/rea-repository-contributor/SKILL.md`: repository contribution workflow for coding agents.
- `templates/agent-task.md`: reusable task contract.
- `templates/agent-handoff.md`: consistent implementation report.
- `scripts/validate-plugin.mjs`: static package validator.
- `AGENT_WORKFLOW.md`: end-to-end agent workflow and authority boundaries.
- `TESTING.md`: validation scope and limitations.

## Automated package checks

From the repository root, run:

```bash
node plugins/rea-agent-plugin/scripts/validate-plugin.mjs
```

The same static validation runs through GitHub Actions when the plugin package or its workflow changes. A passing check does **not** replace the real installation and end-to-end checks described below and in [TESTING.md](./TESTING.md).

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
2. Confirm the plugin and both skills are discoverable.
3. Confirm the `rea` MCP server is listed and its tools are available.
4. Ask for a small, read-only analysis of a file or application you own or are authorized to inspect.
5. For repository work, ask the agent to summarize `AGENTS.md` and `CONTRIBUTING.md`, propose a tiny test-backed change, and report exactly which checks it actually ran.
6. If REA is missing, run the relevant readiness checks from the main repository's `docs/installation.md`; do not assume an analysis provider is installed just because MCP connected.

## Safety and license notes

Analyze only software and data you own or are authorized to examine. Runtime analysis may have side effects. Commercial tools remain subject to their own licenses. The plugin does not grant licenses to external tools or bypass access controls.
