# Reuse successful immutable parent validation

This checkpoint addresses [#4810](https://github.com/morluto/rea/issues/4810),
found in the [retained-investigation audit](retained-investigation-workflows.md).
It changes the shared format interpretation used by CLI and MCP views, without
adding a tool, changing a schema, projecting away source data, or rerunning a
provider.

## Question, ownership, and compatibility

The task resumes authentic exported Evidence in a fresh production stdio MCP
server, discovers its source, reads six original symbols or modules in two-row
pages, repeats that traversal three times, queries the existing Unknowns,
exports the investigation, and closes it. The original source records must
survive the round trip exactly. Pages are compared to original retained facts.
Independent ELF byte decoding checks symbol names, values, and ranges; JavaScript
checks cover selected source bytes and the `lib/cli.js` module identity, rather
than independently proving the entire application inventory or semantic graph.

Imported JavaScript graphs lack the producer's realm-private format proofs.
Previously each view repeated full schema, graph/hash, and cross-graph binding
validation. Native layout views likewise parsed the entire layout for every
page. An immutable Evidence root alone was insufficient: its selected normalized
result did not carry the JSON owner's private sealing proof.

The JSON owner now transfers that proof to a selected own member without another
walk or per-node registration. Each format owner records a **successful complete
interpretation of the exact immutable source** in a WeakSet. There is no second
retained parsed graph, strong cache, cross-process cache, or live-state cache.
The schema implementation is fixed for the process; a different source object
must validate independently. Weak entries do not keep Evidence alive, and session
lookup continues to gate access after close.

Cache admission follows full validation and requires that parsing preserved the
source representation. A shared iterative JSON comparison checks own data keys,
scalar values, prototypes, and enumerability without calling accessors. Object
member order is immaterial; array order remains exact. Shared node pairs are
inspected once; parsing that splits a shared source node keeps the parsed result
instead. The temporary comparison Map is discarded on return. Parser
defaults, hidden-field removal, or other normalization retain the parser's
result and do not cache the source. Writable/configurable descriptor differences
are immaterial: the source is sealed while the temporary parse is mutable.
The JSON sealing boundary rejects proxies before reflection, so arbitrary
mutable proxy behavior cannot acquire an immutable proof. Mutable, merely
Object.freeze'd, failed, and abandoned inputs do not qualify for successful
format reuse.

No Evidence identity, source linkage, coverage, unknown, omission, error, or
caller-selected page changes are intended. Complete source Evidence remains
accessible through the existing contracts. The first view still pays for full
validation and the representation comparison; a one-off CLI invocation cannot
benefit from a cache in a previous process.

## Inputs and measurement scope

Baseline: `2c4338db1fdb7773e05376301c558cff2a0b4b80` (REA 6.6.0).
Node 24.18.0, npm 11.16.0, Linux x86-64 (AMD EPYC 7B12, kernel 6.1.0-53-cloud).
The ELF producer reports pwntools 4.15.0, pyelftools 0.33, and Unicorn 2.1.2.
The baseline's built runtime was preserved
before production changes. Candidate and baseline use the same locked packages.

- SQLite `/usr/lib/x86_64-linux-gnu/libsqlite3.so.0.8.6`: SHA-256
  `2e6eef9a727f081f0d453b4e5e6cbd8b9ef8b6f86cbf7681cbad444d3b0b55c8`;
  26 sections, 1,479 symbols, 2,963 relocations. Original history: 1,745,224 bytes.
- Shipped npm 11.16.0: inventory digest
  `f8e576a7d162542c616168b25a95a5f62b9accf29467cc37e149905ad4b8e603`;
  five explicitly selected paths (`package.json`, `bin/npm-cli.js`, `lib/cli.js`,
  `lib/cli/entry.js`, `lib/commands/install.js`), 2,822 application nodes,
  1,796 semantic nodes, 13,682 semantic unknowns. The 1,416 unselected files stay
  unknown. Original history: 21,058,430 bytes.
- Small case `/usr/bin/true`: SHA-256
  `c79bf44242829108e323378531f4ac839513ca1fba45efd6583643526e1e9fd2`;
  31 sections, 53 symbols, 66 relocations. Produced through the real production
  `inspect_binary_layout` MCP operation. An independent raw ELF reader checked
  every symbol name, value, and source range plus section/relocation counts.

The two larger histories were produced and independently checked in the linked
previous audit. They are historical Evidence, not a claim of fresh provider
analysis during a resumed view. All tasks here are static; no target executable
is run.

Each completed comparison includes startup, the complete 207-tool catalog,
import, queries, oracle checks, export, close, receipt writing, and SDK cleanup.
RPC timings exclude subsequent client-side oracle/receipt work. Fresh servers
separate first-view validation from later pages; OS file caches are uncontrolled.
Runs alternate baseline/candidate order. One CPU, 8 GiB hard family memory,
7 GiB early stop, no swap, and a 192-task ceiling bound each serial task.
Resource counters are observed at payload exit while the observer remains alive;
final whole-scope counters are unavailable. Kernel cgroup peaks include charged
file cache and descendants, rather than just the server's JS heap.

## Results and executed validation

Candidate production code: `646312dad75e2cb2becb0dd4139b99a1c04d6bcc`.
The [curated receipt](immutable-parent-validation.json) retains every final run,
offline token estimates, compatibility checks, and costs of previous attempts.
Values below are medians with min–max ranges across three fresh alternating pairs.

| Source     | First page, before → after (ms)                       | Eight later pages, before → after (ms)              |
| ---------- | ----------------------------------------------------- | --------------------------------------------------- |
| SQLite ELF | 260.63 [170.43–476.00] → 208.04 [197.35–628.10]       | 631.39 [355.80–1090.01] → 60.51 [57.67–187.48]      |
| npm        | 1908.35 [1503.26–6990.99] → 3138.79 [2610.17–3248.63] | 13568.94 [9500.24–23578.81] → 110.78 [73.74–121.15] |
| Small ELF  | 132.46 [99.05–145.36] → 163.07 [155.61–344.72]        | 135.54 [99.92–140.12] → 373.14 [97.57–378.53]       |

| Source / runtime    | Whole elapsed (s)   | Family CPU (s)      | Kernel family peak (MiB) |
| ------------------- | ------------------- | ------------------- | ------------------------ |
| SQLite ELF / before | 17.60 [13.64–32.19] | 17.39 [13.35–30.41] | 1048.5 [947.1–1054.9]    |
| SQLite ELF / after  | 16.88 [14.35–48.56] | 16.60 [14.11–43.52] | 1039.5 [999.8–1041.1]    |
| npm / before        | 38.71 [28.87–86.73] | 38.39 [28.63–73.11] | 1398.3 [1334.0–1524.1]   |
| npm / after         | 28.30 [20.19–29.05] | 28.03 [19.96–28.72] | 1246.8 [1236.9–1263.1]   |
| Small ELF / before  | 19.54 [12.62–21.41] | 19.18 [12.41–21.08] | 1016.7 [986.1–1017.0]    |
| Small ELF / after   | 19.21 [16.12–19.54] | 18.96 [15.88–19.24] | 998.5 [996.1–1019.0]     |

| Source     | Paired warm-read ratio, before / after | Paired first-view change, after − before (ms) |
| ---------- | -------------------------------------- | --------------------------------------------- |
| SQLite ELF | 5.88× [5.81–10.95]                     | +26.92 [-52.59–+152.10]                       |
| npm        | 128.83× [122.49–194.62]                | +1106.91 [-3742.36–+1230.44]                  |
| Small ELF  | 0.37× [0.27–1.39]                      | +64.02 [+23.15–+199.36]                       |

Each pair matches the before/after runs with the same repetition number.
The paired effect can differ from the ratio of marginal medians when the host
speed changes. Positive first-view changes mean higher latency.

SQLite and npm have faster later reads in each numbered pair. The small ELF is
a negative control: two of three pairs are slower, with marginal medians
135.54 → 373.14 ms for eight reads. No small-input gain is claimed; those runs
remain included and the cause of that latency difference is not established.

A separate instrumented public MCP run on that small source confirms one
successful format admission, one miss and eight hits for its nine queries,
identified from the `safeParseOwnedBinaryLayout` caller stack. The instrumentation
preserves return values; its timings are excluded from the comparison. This
confirms reuse without establishing a cause for the small-task latency regression.

The demonstrated benefit is larger-source repeated selected reads. First-view
validation
also performs the representation comparison and can be more expensive. Whole
task, CPU and memory figures above are measured SDK workflow costs, not a
general provider-analysis or agent-investigation speedup. The previous e30
checkpoint had a slow npm repetition on both sides, including a 65-second
candidate task; its cause was not profiled. The original checkpoint and every
fresh run remain retained. No model-token saving, general memory improvement,
or complex-software investigation advantage is established.

All 18 fresh workflow runs preserve original records and canonical answer
digests. Every corresponding query's structured result and complete catalog
is equal. The three public CLI source pairs are also byte-for-byte identical.
The two additional mixed-history tasks preserve all 97 original records, check
64 follow-up heads over 32 pages and revision two, reject stale updates and
tampered imports atomically, clear Unknowns on close, and refuse old references.

Offline `tiktoken` 0.12.0 / `cl100k_base` estimates for one pass over the complete
catalog, named-call arguments and replies are **unchanged** within each pair:
849,736 native, 856,384 JavaScript, and 840,303 small-case tokens. The catalog
contributes 805,215 tokens alone.
These are raw transport serialization estimates, not actual model context or
usage; initialization/framing, prompts, client discovery, rendering/replay,
and continuations are unmeasured. Metadata paths differ from the historical
checkpoint; compare equivalent runs within each checkpoint.

Executed checks at the final production code:

- `npm run check` and `npm run docs:check` pass, including five README
  consistency tests.

- 126 source tests across immutable JSON, native/JavaScript format validation,
  and the shared application view service; `npm run check:fast` and
  `npm run build:cached` pass.
- Four compiled CLI/MCP files (`evidenceBundleInline`, `serverUnknownsMcp`,
  `analysisViewMcp`, and `analysisViewCli`): 36 tests pass.
- Real public stdio MCP: 18 fresh paired tasks and two additional mixed tasks;
  public CLI: six invocations, with three exact output pairs. These corpus
  workflows and four-file boundary checks have exit zero, verified payload
  cleanup and zero observed
  payload-exit OOM events.

Internal review reproduced two **candidate-only** defects before integration.
Generic deep equality ignored hidden fields removed by parsing; the JSON owner
comparison now preserves that normalization. Its initial iterative traversal
also repeatedly expanded shared nodes: a valid 27-object graph exhausted an
instrumented 10,000-inspection budget. Tracking source-to-parsed node pairs
reduces that same compiled probe to 54 inspections and successful borrowing.
A parser that splits a shared source node keeps its parsed result rather than
expanding repeated paths. Deterministic regressions enforce the inspection
budget instead of relying on timing or letting a regression consume exponential
CPU. These are internal JSON-owner probes, not claimed baseline public-provider
reproductions.

The initial exploratory cohort and historical e30 paired checkpoint are not
the final comparison. One earlier source-check attempt was mistakenly started
during an initial baseline run; the newly started owned scope was stopped after
17.27 s and that check remains incomplete (exit 241). Observed counters, the
contended baseline, subsequent successful retries, and prior checkpoints remain
retained; no OOM or terminal-counter claim is inferred from that stopped task.

Real Ghidra, Hopper, JEB, fresh JavaScript producer performance, and actual
agent trials are outside this checkpoint. Private WeakSet metadata/heap retention
was not measured independently; the absence of a strong retained parsed graph
is source-derived. The comparison's source-to-parsed Map exists only during
the first interpretation; measured family peaks include its temporary cost.

## Latest-main integration and a retained timeout

Main `bb212ffec` adds three test/config/guide fixes. Merge `71e0b2739`
integrates them; the production files are unchanged from measured `646312dad`.
The initial three-file `npm run test:focused` integration attempt passed 26 tests
and timed out the live server identity/catalog test at its default 30 seconds.
Its scope exited one, with verified payload cleanup and no observed OOM.

An unmodified latest-main checkout and the candidate subsequently both passed
all 27 tests through the same official `npm run test:focused` command and default
deadline. Additional diagnostics passed: one isolated main test, 27 direct
Vitest main tests, and 27 candidate tests with an explicitly declared CLI-only
120-second deadline. These different-entrypoint diagnostics do not replace the
matching official-command comparison. The original failure remains unexplained;
a passing retry does not identify its cause. No product or test-policy file was
changed to obtain a pass. Every attempt's elapsed/CPU/family-memory counters and
actual exit status are retained in the curated receipt.

## Reproduction and retained evidence

Use `retained-investigation.mjs` from this directory with an authentic exported
bundle and its original source Evidence ID. Build both selected runtime revisions
with the pinned toolchain, preserving a separate baseline. For each runtime run:

```sh
python3 experiments/analysis-efficiency/resource-run.py --observe-payload-exit -- \
  node experiments/analysis-efficiency/retained-investigation.mjs \
  --runtime-root /absolute/runtime --revision REVISION \
  --bundle /absolute/history.json --evidence-id ORIGINAL_EVIDENCE_ID \
  --scenario native --delivery focused --output /absolute/new-receipt-directory
```

Use `--scenario javascript` for the npm history, and `--verify-mixed` with an
actual mixed investigation. Reuse the same bytes and source identity on both
sides. Do not regenerate parent identities or synthesize bundle records.
The checked-in wrapper defaults to a 4 GiB hard / 3 GiB early stop. This
checkpoint used a private resource-only copy with 8 GiB / 7 GiB thresholds,
a 16 GiB available-memory start floor and 8 GiB host early stop. Its source
and unchanged observer hashes are recorded in the curated receipt. This local
resource policy does not change the public workflow or global wrapper defaults.
Raw histories, transcripts, oracle outputs, and resource logs stay in the private
local audit cache; only curated receipts are committed.
