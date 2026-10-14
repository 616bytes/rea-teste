# REA plugin validation

Run the package checks from the repository root:

```bash
node plugins/rea-agent-plugin/scripts/validate-plugin.mjs
```

The validator checks that the three plugin manifests and MCP configuration are valid JSON, that the manifest names and versions agree, that referenced files exist, that the MCP entry point uses the expected published `rea-agents` package, and that the skill has its required metadata and sections.

GitHub Actions runs the same validator for pull requests and pushes that change the plugin package or its workflow.

## What this does not prove

A passing validation is a static package check, not a full integration test. It does not install Claude Code or Codex, launch the remote npm package, verify provider availability, or prove that an analysis works end-to-end. Those checks must be run in the actual clients and documented separately.
