# Tasks

- [x] Confirm scope: static `.class`/JAR inspection, in-scope, no runtime/#2376 overlap.
- [x] Record spec and implementation plan.
- [x] Implement dependency-free class-file framing (bounded, `Result`-based).
- [x] Decode the five debug attributes with absent/malformed/partial/ambiguous modeling.
- [x] Normalize Evidence with deterministic ordering and examined coverage.
- [ ] Add application service: local-file and JAR-entry resolution, multi-release
      selection, parse-error mapping to `analysisErrorCore`, bounded reads, provenance.
- [ ] Add CLI/MCP contracts, catalog registration, and public workflow tests.
- [ ] Add owned `javac` `-g` / `-g:none` fixtures and the verification lane.
- [ ] Write the analyst-facing guide; run focused, static, and documentation checks.
- [ ] Resolve independent review findings and rerun relevant checks.
