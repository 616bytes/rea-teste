# Verification

Executed on Windows x64 with Node 24.18.0, npm 11.16.0, and .NET SDK 8.0.416
(HostModel/runtime 8.0.22). Generated hosts were never executed.

- `tests/boundary/filesystem/dotnetBundleArtifacts.test.ts`: 20 passed. Admitted
  v1/v2/v6, plain and DEFLATE members, future types, Unicode, stored extents and
  source/member hashes. Refusals cover traversal/prefix conflicts, overlap,
  truncation, malformed UTF-8, unsupported version, byte limits, incorrect
  expansion, corrupt/trailing compressed data, forged entries, source changes,
  active cancellation, split markers, zero-pointer templates, short reads and
  read-failure/cancellation precedence, compressed-source I/O classification and
  borrowed descriptor ownership. ELF and thin Mach-O routing is synthetic
  header coverage on Windows, not Linux/macOS apphost producer verification.
- `tests/acceptance/dotnetBundleJourney.test.ts`: compiled CLI and real SDK
  stdio MCP inspection/extraction passed, including output schemas, byte-exact
  extracted content, source preservation and session close.
- The Microsoft HostModel generator emitted v1, v2, plain v6 and compressed v6.
  Each passed public CLI and stdio MCP inspection/extraction; extracted DLL and
  resource bytes matched their source files exactly. Separately, a framework-
  dependent .NET 8 `PublishSingleFile=true` SDK host passed CLI inspection.
- Shared graph construction, inventory snapshot, comparison, MCP artifact,
  reader cleanup, regular-root, MZ and extraction-format regressions passed.
  One POSIX-only regular-file assertion was skipped on Windows. Two existing
  `ArtifactOccurrenceIdentity.test.ts` POSIX mode assertions fail on Windows;
  both also failed on an isolated, unmodified `242e2b0` source snapshot with the
  same results. The final source tree then passed all 42 selected tests in an
  isolated WSL Ubuntu checkout with independent Linux dependencies, including
  both POSIX assertions and all 20 bundle boundary tests. No test assertions or
  platform selectors were weakened.
- `npm run check:ci`, `npm run docs:check` and `npm run verify:test-discovery`
  passed. The dedicated temporary-directory hygiene runner passed both new
  files (21 tests on the final implementation), with no owned residues.

The compiled CLI/MCP acceptance workflow took 8.4 seconds in a repeated run
with existing build artifacts and a fresh session/workspace. Model token usage,
CPU time and peak process-family memory were not measured. Marker detection
adds a streaming read pass for a native file without a bundle marker; no
performance improvement is claimed.

Linux/macOS apphost producer/runtime execution, target code execution,
decompilation and full arbitrary-bundle compatibility are outside this executed
verification. Current-head upstream CI remains a separate integration gate.
