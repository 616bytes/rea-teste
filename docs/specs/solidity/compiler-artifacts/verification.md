# Compiler artifact verification

Verified on 13 October 2026 with Linux x64, Node 24.18.0, npm 11.16.0,
`solc 0.8.30+commit.73712a01.Emscripten.clang`,
`solc 0.4.26+commit.4563c3fc.Emscripten.clang`, and bundled `evmole@0.9.3`.
Current integration base: `4d98123279c5a6f5442c458307f5a3ec678fd49e`.
The earlier full, installed-package and live-agent matrices below ran on base
`3cb9d61ec1a1bf29000a00cff712ed07ca472da6`. EVM production code is identical
after the rebase; current-base reruns passed the runtime build, 78 public
compiler CLI/MCP cases and 288 focused tests, with two opposing-platform skips.
Current lint passed. Current typecheck is blocked by the unchanged main test
`tests/acceptance/providers/hopperStartupRecovery.test.ts:207` (`TS2339`,
`workspace` on a string); the same check blocks the normal pre-push hook.

## Executed checks

- `npm run build:cached`: passed.
- Focused parser, domain, retained-view, service, adapter, MCP, JSON serialization,
  worker, resource/cleanup and CI-scope tests: 255 passed; two opposing-platform
  cases skipped on Linux. The CI-scope suite contributes 118 tests, including
  selection of the real-EVM lane for compiler verifier changes.
- Typecheck, unused-code, architecture and module-boundary checks: passed.
  Changed-file lint: zero errors; changed-file formatting: passed.
- `npm run verify:test-discovery`: all 1,128 test files discovered exactly once.
- `node scripts/verify-solc-artifacts.mjs`: 78 public CLI/stdio-MCP cases passed;
  actual converted advertised schemas validated with Ajv 2020.
- The same 78 cases passed against a locally packed npm tarball installed in an
  isolated prefix, without a source checkout. Packaged runtime, generated skill
  and unchanged EVMole 0.9.3 were present. Installed CLI/MCP also passed 18 real
  compiler-variant inspections: optimizer, viaIR, content-hash-free and CBOR-free
  output, recorded settings and independent hex controls.
- Independent agents passed 62 main/feature acceptance checks, 68 adversarial
  CLI/MCP checks and eight syscall-traced compiler inspections. These supplement
  the genuine legacy before/after comparison below; counts include repeated
  adapter checks and schema/control cases, not distinct acceptance requirements.
- `node scripts/verify-evm-interface.mjs`: 59 existing real EVM cases passed.
- `node scripts/verify-solidity-metadata.mjs`: all four pinned compiler variants
  passed, preserving decoded terminal CBOR and unavailable metadata for the
  CBOR-free fixture.

Repository-wide checks have unrelated failures on unchanged main files:
formatting in `enhancedTools.04-uses-complete-inventories-inline.test.ts` and
`packagePlatformDiagnostics.test.ts`; lint line limits in
`artifactComparison.test.ts` and `ManagedCilDecoding.test.ts`; and documentation
link drift in `docs/readme/README_tr.md`. All three failures also reproduce in the
isolated rebased baseline; these files have no feature diff.
The documentation generation stages passed before the link check failed.
Hosted CI execution and the complete repository gate remain unverified.

Both public lanes used an absolute `REA_VERIFY_SOLC_MODULE` selecting the pinned
compiler. The existing EVM lane also used `/usr/bin/strace`. Both verified process
lineage cleanup with zero descendants. Routine structured CLI/MCP logs remain
separate from protocol output. The new lane covers
exact creation/deployed selection, raw/hex inference equivalence, escaped source
identities and syntax ranges, unlinked/absent objects, compiler error-only output,
downstream EOF rejection with retained compiler diagnostics, malformed references,
duplicate properties, converted schema rejection and summary parent readback.
Synthetic carriers additionally verify oversized repeated reference identities
with escaped and surrogate source text, retained capacity-failure warnings and
carrier digests, and legacy placeholders with `/`, `./` and `@` source prefixes,
plus Unicode names, two placeholders and a later immutable reference.
Placeholder widths and byte offsets use UTF-8;
JSON syntax coordinates retain UTF-16 units.
The permanent lane uses synthetic legacy boundary fixtures. The separate
historical comparison below additionally verifies real 0.4.26 output. Public
capacity cases exercise both depth and AST-node admission. CLI SIGINT and SDK
cancellation occur after a token-bound real worker is observed; both require
worker exit and private-root removal. SIGINT returns exit 130 with typed
cancellation; MCP accepts a subsequent compiler request. Retained unlinked
summaries preserve unknown candidate totals/exhaustion, complete parent text and
a typed error when decoded-hex paging is unavailable.

The existing lane records absent target execution and network requests for its
traced raw/hex fixtures. Eight additional modern, legacy and canary compiler-JSON
CLI/MCP inspections were traced for network, exec and file-open syscalls. Only
Node, prlimit and ownership-check ps executed; network observations were local
stdio socket operations. Referenced source canaries were not opened, and recorded
file/HTTP/HTTPS/IPFS metadata URLs caused no network request. This establishes
offline behavior for those inputs and syscall classes, not arbitrary artifacts.
These checks cover Linux source-built and isolated installed-package workflows;
other operating systems, additional compiler versions/facets and arbitrary
compiler outputs remain unverified. Three live Codex CLI 0.162.1 trials with
configured model `gpt-6-luna` passed using isolated native setup, the installed
skill and full MCP catalog: exact deployed selection, Unicode unlinked creation
inspection, and requesting missing selectors without guessing. Returned digests,
selectors, byte counts and link offsets matched independent fixture checks.
The temporary login profile was removed. These trials establish those observed
workflows for one client/model, not general agent reliability. Hosted CI and
native macOS/Windows runs remain unverified; the existing EVM provider supports
Linux x64 and explicitly refuses other hosts.
The real-EVM workflow includes native macOS/Windows jobs for portable parser,
Evidence and provider-refusal tests plus the public CLI refusal. Their YAML and
script syntax are checked locally; native execution awaits the hosted run.
No contract was executed.

## Issue acceptance and historical comparison

The [issue body](https://github.com/morluto/rea/issues/2389) and its complete
comment thread were reread on 13 October 2026. The canonical specification, plan
and tasks use the issue body's `docs/specs/solidity/compiler-artifacts/` path.
The [architectural comment](https://github.com/morluto/rea/issues/2389#issuecomment-6133834299)'s
ownership requirement is implemented by
`src/domain/evm/solcArtifactSelection.ts`; EVMole invocation and worker supervision
remain in `src/evm/`. Exact kind is explicit in input `bytecode_kind` and output
`bytecode.kind`, rather than inferred from size or deployment context.

An isolated comparison built the pre-feature revision
`653067d799591ce2b8fdc84e99c160ac17e2860f` and initial implementation
`f9ecf7c98845542896764af273912d865fbc42dc`, then exercised the review fixes before
the main update through real CLI and stdio MCP. Those builds used the same locked
dependencies and pinned Node.
This earlier comparison predates the current integration base and Unicode fix.

**88 comparison checks passed**, with zero remaining verifier descendants.

| Requirement / scenario                                        | Before                                                                     | Review fixes before main update                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact Standard JSON creation/deployed selection               | Pre-feature CLI/MCP have no compiler selection contract                    | Selects original objects and digests; inferred candidates equal the independent hex workflow                                               |
| Same contract name in `a/Same.sol` and `b/Same.sol`           | Initial implementation selects exact identities                            | Both remain distinct; basename `Same.sol` fails through CLI/MCP                                                                            |
| Compiler error-only output                                    | Initial implementation retains recorded errors on selection failure        | Errors and exact carrier/selection remain visible                                                                                          |
| Repeated long reference identities exceeding the reply budget | Initial implementation drops the warning and digest                        | Bounded serialization retains warning, ranges, carrier digest and selection                                                                |
| Real legacy `/`, `./` and `@` placeholders                    | Initial implementation rejects valid 0.4.26 output                         | Twelve CLI/MCP creation/deployed inspections retain exact unlinked objects and recorded version; missing immutable references stay unknown |
| Cancellation after worker admission                           | Pre-feature raw/hex and initial compiler workflows release the worker/root | Compiler CLI/MCP release the worker/root and the MCP connection accepts another request                                                    |

The legacy producer uses `compileStandardWrapper` from unchanged solc 0.4.26,
with independently supplied source keys `/lib.sol`, `./lib.sol` and
`@pkg/lib.sol`, no import callback and this owned source:

```solidity
pragma solidity ^0.4.26;
library L {
    function f(uint x) public pure returns(uint) { return x + 1; }
}
contract C {
    function f(uint x) public view returns(uint) { return L.f(x); }
}
```

Compilation is fixture preparation; REA inspects only the existing output. No
contract or library is executed. These fixtures establish the observed legacy
selection/linkage and omitted-facet behavior, not all older compiler facets.

## Verification after the main update

An isolated build of rebased feature revision
`9a600223734e843373880ca6b638af84ef974f3a` was compared with the final working
diff using the current lockfile and pinned Node. **32 checks passed**, including
24 CLI/MCP before/after inspections of genuine solc 0.4.26 outputs with source
keys `雪.sol`, `é.sol` and `😀.sol`, creation/deployed selection, and two library
calls. Before the fix, each Unicode inspection fails with `invalid_request`.
Afterward, each retains the exact unlinked object, both recorded link offsets,
compiler version and unavailable inference. Both placeholders are 40 UTF-8 bytes;
bytecode size is independent of JSON text coordinates. The compiler preparation
adds a second `L.f(x + 1)` call to the owned source above. No contract is executed.
The comparison verifies process-lineage cleanup with zero descendants.

Astra independently reproduced the genuine Unicode defect, then reviewed the
shared domain scanner and its consumers. The final review found no actionable
defects and verified the preserved main metadata, resource ownership and subject
validation behavior. The permanent public lane includes Unicode regressions;
real legacy compilation remains a separate local verification.

## Completed-task cost samples

Before means rebased revision `9a6002237`; after means its final working diff.
Each CLI command inspects the same owned `FirstFixture` deployed bytecode. For
each encoding, before/after normalized facts and response sizes are identical,
including main's decoded CBOR metadata. The hex workflow receives an already
selected object and omits extraction cost and compiler provenance; it is not an
equivalent complete compiler-artifact task.

| Revision / carrier / run          | Elapsed s | CPU s | Sampled peak family RSS MiB | Response bytes | Response token estimate |
| --------------------------------- | --------: | ----: | --------------------------: | -------------: | ----------------------: |
| Before / hex / first              |     0.908 |  1.40 |                      388.30 |          5,900 |                   1,501 |
| Before / hex / repeated           |     1.193 |  1.74 |                      387.53 |          5,900 |                   1,501 |
| Before / compiler JSON / first    |     0.936 |  1.44 |                      402.97 |         10,439 |                   2,841 |
| Before / compiler JSON / repeated |     1.533 |  2.20 |                      394.30 |         10,439 |                   2,841 |
| After / hex / first               |     1.100 |  1.70 |                      386.48 |          5,900 |                   1,501 |
| After / hex / repeated            |     1.029 |  1.59 |                      389.50 |          5,900 |                   1,501 |
| After / compiler JSON / first     |     1.015 |  1.66 |                      392.00 |         10,439 |                   2,841 |
| After / compiler JSON / repeated  |     1.160 |  1.78 |                      401.56 |         10,439 |                   2,841 |

Node compile caching was disabled. First/repeated rows start fresh REA and worker
processes; OS caches were not reset and builds/earlier tests had warmed runtime
files. These are single samples, not verified cold-filesystem runs or a statistical
latency comparison. There is no shared inference-result cache or established
performance improvement. Compilation and fixture generation are excluded.

Elapsed time includes sampling overhead. CPU is GNU `time` user plus system time
for the completed command and waited children. Peak family RSS sums the GNU-time
launcher, REA and live descendants sampled through `ps` approximately every 25 ms.
It can miss brief peaks and count shared pages repeatedly; it differs from
virtual memory and GNU time's maximum individual-process RSS.

Response token estimates use `tokenx@1.3.0` on complete CLI JSON. The actual
SDK-advertised EVM tool definition, including input/output schemas, descriptions
and annotations, estimates 7,521 tokens both before and after these review fixes.
The CLI argument arrays estimate 34 tokens for hex and 79 for exact compiler
selection; these are command text, not model API requests. The skill entrypoint
adds approximately 29 estimated tokens over fetched main (4,872 to 4,901), confined
to its existing EVM route. No model was invoked by these cost-sample experiments. Actual
model task tokens, client projection, duplicate structured/text reply overhead,
retries and guide-reading cost remain unmeasured. Bytes and isolated token
estimates do not establish whole-task savings. Compiler summaries omit duplicate
object and raw metadata text while preserving diagnostics and references.

Reproduce the semantic fixtures with `npm run verify:solc:artifacts`. For cost
samples, generate the pinned fixture using
`scripts/fixtures/solidity/compiler-artifacts.mjs`, select `FirstFixture` deployed
bytecode as a hex reference, run both complete CLI calls in fresh processes, and
collect command CPU plus live process-family RSS.
