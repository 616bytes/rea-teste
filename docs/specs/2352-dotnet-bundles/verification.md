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

## Follow-up boundary review (2026-10-14)

Review of the complete change found two error-classification gaps, reproduced
with failing regressions before fixing the producing boundary:

- A manifest string crossing the metadata cache boundary mislabeled source
  I/O failure as invalid UTF-8. Byte acquisition now sits outside the decoder's
  error handler, retaining the original source failure.
- Cancellation during descriptor admission escaped as a native AbortError,
  which the provider would classify as I/O. The bundle reader now normalizes
  cancellation after retaining any failed admission's cleanup owner.

The existing tests covered compressed-source I/O, pre-cancelled calls and
in-stream cancellation, but not these acquisition boundaries. New regressions
cover both failures. Nonzero configuration locations are checked against the
file table, and the shared owned-reader cleanup suite now includes bundles.

With these fixes, ten selected Windows files passed 71 tests with one existing
POSIX FIFO skip, including the compiled CLI/stdio MCP journey. An independent
WSL Ubuntu checkout with Linux dependencies passed all 57 tests in eight
selected files, including the FIFO and POSIX mode assertions. The four existing
Microsoft HostModel producer fixtures again passed public CLI/MCP inspection,
extraction, DLL/resource byte comparisons and source preservation.

A final Windows temporary-directory hygiene run passed all 30 tests across
the bundle boundary, owned-reader cleanup and CLI/MCP journey files, leaving
no owned residues. This includes two additional regressions ensuring that
unbundled PE/ELF hosts retain native identity and refuse empty extraction.

## PR preparation after upstream synchronization (2026-10-15)

Merged immutable upstream `59f528f0e5bfd780e314e929db9ebf1ad65c1303`.
The executed source revision was `a53f791d3cf8397c48a5bb7db73fdf69319f2e06`;
the subsequent verification-record commit changes documentation only.

- Windows `npm run test:focused -- <selected paths>`: 92 passed, one existing
  POSIX FIFO skip across ten files. Selected the bundle boundary, owned-reader
  cleanup, inventory descriptor cleanup, regular root, MZ inventory, comparison,
  inventory snapshot, graph construction, artifact MCP and bundle journey suites.
- Independent WSL Ubuntu source checkout, Linux Node 24.18.0 and independent
  locked dependencies: 67 passed across eight files. Selected the first seven
  filesystem suites above and `ArtifactOccurrenceIdentity.test.ts`, including
  the POSIX mode and FIFO checks. The initial offline dependency installation
  lacked an upstream-added package; cached-first installation completed before
  executing these tests.
- Microsoft HostModel v1, v2, plain v6 and compressed v6 again passed the public
  CLI/stdio MCP workflow with byte-equal DLL/resources and unchanged hosts.
- `node scripts/verify-test-temp-hygiene.mjs` on bundle boundary, owned-reader
  cleanup and bundle journey with `--maxWorkers=1`: 30 passed, no owned residues.
- `npm run check:ci`: passed against the synchronized production code.

Windows uses process-scoped Git ownership configuration for this exact checkout
and `TURBO_ENV_MODE=loose`; global Git configuration and project checks are
unchanged. Upstream CI and the human author's readiness declaration remain
separate pending gates.

## Scan-to-materialize identity review (2026-10-15)

A new regression replaced the host after inventory with another bundle whose
members were byte-identical but whose native host bytes differed. The initial
test failed: extraction succeeded and linked the output to the old root digest.
Earlier replacement tests covered changes after the reader had opened its
descriptor, but not this gap between inventory and extraction.

Extraction now verifies the complete host digest against its inventory snapshot
using the same descriptor it later reads for members, before creating an output
directory. The existing reader checks continue to reject later descriptor/path
changes. This adds one full-host read pass to extraction. The regression now
rejects the replacement with an integrity failure and verifies that no output
directory was created.

The selected bundle boundary, owned-reader cleanup and compiled CLI/stdio MCP
acceptance suites passed 31 tests. `npm run check:ci` passed typecheck, lint,
formatting, metadata, duplication, TODO, module-boundary and architecture
checks. `npm run docs:check` passed, including five README consistency tests.
The temporary-directory hygiene run passed the same 31 tests with no owned
residues. Upstream CI on `fb46280a` passed 33 execution jobs but failed its
Linux real-browser job at a service-worker page-state timeout, so the required
summary failed too. The browser workflow and verifier are unchanged by this PR.
With the version-matched Windows native artifact restored from that CI run,
`npm run verify:browser` passed twice on the same source revision with real
Chrome 155, including the service-worker scenario. This does not resolve the
Linux CI failure; GitHub rejected a rerun of the upstream job with HTTP 403.

Microsoft HostModel from SDK 8.0.416 generated v1, v2, plain v6 and compressed
v6 hosts again. All four passed public CLI inspection and extraction; extracted
assembly/resource SHA-256 values matched their source files, and each host's
SHA-256 was unchanged. The generated hosts were not executed. The compiled
stdio MCP acceptance suite above uses a synthetic bundle; the real-producer MCP
workflow was last run before this fix.

## Automated review follow-up (2026-10-15)

Two regressions failed against PR head `9f1391e` before the local fixes. First,
the parser accepted a 257-part path and a manifest with 251,000 total path
parts. Source inspection and a smaller retained-tree measurement showed how
distinct prefixes allocate a node and `Map` per part. Existing tests bounded
metadata bytes, entry count and expanded bytes, but not the memory expansion
from path structure. The path registry now rejects paths above 256 parts and
stops before allocating more than 250,000 path-tree nodes. A distinct-prefix
regression triggers the node limit, while a shared-prefix regression verifies
that many members under the same deep directory remain admissible. These are
REA resource policies, not Microsoft format limits.

Second, public CLI inspection identified a bundle but returned no `next_probes`
or `unexplored_branches`. The inspection projection now suggests extraction
into a fresh owned directory followed by separate inspection of candidate
files, without treating bundle declarations as verified assembly types. The
existing acceptance test had checked classification and extraction separately,
but not the inspection report's follow-up guidance.
For a directory containing a bundle, select the host file before extraction:
extracting the directory itself copies its files without unpacking nested hosts.

On the working tree based on `9f1391e`, `npm run test:focused --
src/artifacts/ArtifactPaths.test.ts
tests/boundary/filesystem/dotnetBundleArtifacts.test.ts
tests/acceptance/dotnetBundleJourney.test.ts` passed 38 tests, including a
compiled public CLI limit error and CLI/stdio MCP inspection parity.
`npm run check:ci` and `npm run docs:check` passed.

Microsoft HostModel from SDK 8.0.416 then generated v1, v2, plain v6 and
compressed v6 Windows x64 hosts. The compiled public CLI inspected and
extracted all four. Each inspection classified the root as `dotnet-bundle` and
suggested `extract_artifact`; extracted DLL/resource SHA-256 values matched
the producer files, and each host's SHA-256 remained unchanged. Generated
hosts were not executed. These local checks do not replace upstream CI on the
resulting commit.

## Upstream main integration (2026-10-16)

Locally merged upstream main `1bd5c5c87e81b27bfb16140f71ffa03563e58477`
into PR head `d4ac1c750670e006333336b20e77cc97938c697b`. The only textual
conflict was in `ArtifactExtraction.ts`: retain upstream's normalized logical
path collision rejection before reader/output acquisition, then select the
bundle reader using the inventoried root format and verify the complete host
digest before creating an output directory. The automatically merged source-map
edge classification in `ArtifactGraphConstruction.ts` was reviewed with the
bundle metadata projection.

Windows x64, Node 24.18.0/npm 11.16.0, with process-local temporary and npm
cache directories on E:, after `npm ci` for the merged lockfile:

- `npm run test:focused -- src/artifacts/ArtifactPaths.test.ts src/artifacts/inventory/ArtifactGraphConstruction.test.ts tests/boundary/filesystem/dotnetBundleArtifacts.test.ts tests/boundary/filesystem/ownedArtifactReaderCleanup.test.ts tests/acceptance/dotnetBundleJourney.test.ts tests/acceptance/artifactZipExtractionPaths.test.ts`: 69 passed in six files.
- `npm run check:ci`: passed typecheck, lint, formatting, dependency metadata,
  duplication, TODO, module-boundary and architecture checks.
- `npm run docs:check`: passed generated documentation and five README
  consistency tests.
- The compiled public CLI and stdio MCP inspected and extracted four existing
  Microsoft HostModel-generated Windows x64 hosts (v1, v2, plain v6 and
  compressed v6). The extracted DLL and resource bytes matched the producer
  files, and each source host's SHA-256 remained unchanged. These hosts were
  not executed.
