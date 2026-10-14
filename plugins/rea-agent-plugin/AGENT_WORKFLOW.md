# Agent participation workflow

This plugin bundles two complementary skills:

- `reverse-engineer-anything`: gather evidence about software behavior and structure.
- `rea-repository-contributor`: turn an authorized task into a scoped, tested, reviewable contribution to the REA codebase.

## Recommended agent loop

1. **Orient:** read the repository's `AGENTS.md`, `CONTRIBUTING.md`, architecture docs, issue, and current git status.
2. **Frame:** state the problem, observable outcome, scope, constraints, evidence, and acceptance criteria.
3. **Investigate:** reproduce the issue where possible and trace the source boundary and consumers.
4. **Plan:** present a small implementation plan and identify any scope approval or human decision needed.
5. **Implement:** change only the agreed scope; preserve user work and add focused regression tests.
6. **Verify:** run the smallest meaningful checks, then broaden them when justified. Record exact commands and outcomes.
7. **Handoff:** summarize files changed, evidence, tests, failures, limitations, and remaining decisions.
8. **Prepare review:** when authorized and supported by available tools, use a focused branch and draft PR. Leave human readiness declarations unchecked.

## What the agent can do

With suitable local tools, repository access, and user authorization, an agent can inspect source, explain architecture, investigate issues, implement scoped changes, add tests and docs, run checks, and prepare a reviewable branch or draft PR.

The plugin does not itself grant GitHub permissions, credentials, local filesystem access, branch-push access, or permission to merge. The connected agent's tools and access policy determine which operations are actually possible.

## What remains human-owned

The human owner must review the final diff, understand the change, verify the claims, complete author-readiness declarations, and decide when to request maintainer review. Agents must not attest to human review, mark their own work ready, merge PRs, change branch protections, or bypass required checks.

## Failure handling

If a command fails, report the exact command, exit status if available, and relevant sanitized output. Do not retry destructive operations blindly. If the environment cannot run a check, label it `NOT RUN` or `BLOCKED`; source inspection is not runtime verification.
