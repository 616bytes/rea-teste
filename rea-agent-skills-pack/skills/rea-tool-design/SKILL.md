---
name: rea-tool-design
description: Design or change REA investigation tools, CLI/MCP contracts, provider capabilities, and Evidence semantics.
---

# REA tool design

From an active REA checkout, read `docs/tool-design.md` at the repository root
for tool boundaries, contract semantics, provider ownership, and discoverability.
If this skill is installed without a checkout, use the [upstream tool-design guide](https://github.com/morluto/rea/blob/main/docs/tool-design.md).
Inspect the current contract and nearest existing tool relevant to the analyst
question; source, documentation, and live catalogs may describe different versions.

For a design request, return the proposed boundary, input/result shape, Evidence
semantics, nearest alternative, and verification approach. Implement when
requested, preserving the user's scope and existing authorization.

For implementation or verification, consult `docs/testing.md` in the active REA
checkout for affected consumer/provider lanes and `CONTRIBUTING.md` for
generated-file ownership. When no checkout is available, use the [upstream testing guide](https://github.com/morluto/rea/blob/main/docs/testing.md) and [contribution guide](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md). Read provider/workflow guides only as the task requires.
