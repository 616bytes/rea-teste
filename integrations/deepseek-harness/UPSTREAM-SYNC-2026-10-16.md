# Upstream synchronization (2026-10-16)

## Provenance
- Upstream: `morluto/rea@d72d856f58d4747c5eb4307426e80d20934e017c` (222 upstream commits since the common ancestor).
- Original fork: `xxxxxwater/rea@9967f8a7294102a319d593e34707c15143073625` (49 unique commits since the same ancestor).
- Original fork preserved at `backup/main-pre-upstream-20261016`.
- Integration branch: `sync/morluto-main-20261016`.
- This is a **two-parent merge commit** with both original Git histories preserved.

## Conflict resolution
- Upstream REA core application and analysis code stays current.
- The 22 non-overlapping fork-added files are retained verbatim, including `integrations/deepseek-harness/` plugin sources, local package lockfile, scripts, tests, and `.github/workflows/dsh-bundle.yml`.
- The 23 overlapping Markdown/configuration files are merged by applying the existing fork changes atop upstream, retaining current upstream content and the original DSH documentation.
- `knip.json` and `turbo.json` retain their plugin-specific configuration.

## Release guardrails
- DSH Desktop plugin `0.2.1` is still a **candidate**, not a qualified production release.
- Installation, activation and standalone Node requirements still apply; this source merge does not modify device configurations or publish a release.
- Validate GitHub Actions, plugin tests, package integrity, and relevant REA core tests before deploying.
