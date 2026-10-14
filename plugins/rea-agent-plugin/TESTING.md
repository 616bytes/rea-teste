# REA plugin validation and integration testing

## Static package validation

Run from the repository root:

```bash
node plugins/rea-agent-plugin/scripts/validate-plugin.mjs
```

The validator checks that manifests and MCP configuration are valid JSON, that plugin names and versions agree, that required files exist, that the MCP entry point uses the expected published `rea-agents` package, and that every bundled skill has a `SKILL.md` with matching frontmatter metadata.

GitHub Actions runs the same static validation for pull requests and pushes that change the plugin package or its workflow.

## Real-client integration checklist

Run these checks manually in supported, current versions of Claude Code and Codex. Record the exact versions and outputs; do not mark an item passed without running it.

- [ ] Install or load the plugin using the documented workflow for the client version.
- [ ] Confirm the plugin and both bundled skills are discoverable.
- [ ] Confirm the `rea` MCP server starts and exposes its tools.
- [ ] Run a small read-only analysis against a file or application you own or are authorized to inspect.
- [ ] Confirm the report distinguishes confirmed evidence, hypotheses, unknowns, and provider limitations.
- [ ] In a REA checkout, ask the agent to read `AGENTS.md` and `CONTRIBUTING.md`, inspect git status, and propose a small change before editing.
- [ ] Verify the agent preserves unrelated work, adds focused tests when appropriate, and reports commands/results accurately.
- [ ] Verify the agent does not mark a PR ready, attest to human review, merge, or bypass repository checks.
- [ ] Record failures, environment details, and any provider-specific prerequisites.

## What static validation does not prove

A passing static check is not a full integration test. It does not install Claude Code or Codex, launch the remote npm package, verify provider availability, prove that an analysis works end-to-end, or prove that an agent can create branches or PRs with the user's credentials. Those checks depend on the real client, local environment, installed providers, and granted permissions.
