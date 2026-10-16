# Evidence, comparison, and verification workflows

Evidence-producing tools return the complete Evidence record directly in MCP
`structuredContent` and CLI JSON. Read `normalized_result` for operation data,
and cite `evidence_id` when another tool or your explanation needs a stable
reference. Preserve authority, limitations, coverage, and residual unknowns. If a result
is incomplete or paginated, continue only when the remaining data matters to
the task; do not fetch a bundle or resource merely to read a result already
returned inline. When complete `inspect_binary_layout` or
`analyze_javascript_application` Evidence is already retained, call
`inspect_analysis_view` for a summary, one section/symbol/module, or a stable
page instead of repeating the producer.

Completed `inspect_artifact` inventory also supports a summary and
`view: {kind: "inventory", collection: "occurrences", logical_paths: ["package.json", "main.js"]}`.
Omit `logical_paths` to page all available occurrences; `[]` selects none.
Other inventory collections are `nodes`, `edges` and
`integrity_contradictions`. Keep `source_complete` separate from page exhaustion:
a missing match in partial source Evidence does not establish absence. Use the
returned parent Evidence ID for subsequent views and export before closing the
session when the source must survive it.
When `tools/list` advertises `inspect_artifact.detail`, request `"summary"` to
retain its complete source and receive that view immediately. Without that
advertised choice, keep the existing complete call. CLI inspection returns
portable complete Evidence; save it before projecting a selected inline view.

Use `record_unknown` to track unresolved questions in the user's investigation
and name the authority or environment still required. Supply supporting and
contradicting evidence IDs. It updates the session registry directly.
Use `update_unknown` with the current revision; reread after a stale revision
instead of retrying blindly. Only qualifying observed evidence can verify a
resolution.

Use comparisons with complete, compatible page sets when claiming equivalence
or absence:

- `compare_artifacts` compares inventory pages by occurrence path, content,
  metadata, and graph relations.
- `compare_functions` compares explicit function Evidence, not fuzzy
  whole-binary matches.
- `compare_bundles` compares canonical bundle membership and unknown history.
- `find_changed_behavior` combines existing comparisons; static differences
  remain candidates, not causal proof.
- `build_call_path` needs explicit function dossiers from one artifact/provider;
  an incomplete frontier makes absence unknown.
- `correlate_static_and_runtime` uses explicit mappings; matching patterns are
  hypotheses, not causality.
- `verify_reconstruction` evaluates a finite typed specification. A pass covers
  only declared comparable claims, not global equivalence.

Process captures are opt-in behavioral evidence, not a security sandbox. V3
captures cannot be upgraded to V4; rerun the original scenario. Distinguish root
exit from descendant settlement and require freshness when the task needs it.
A timed-out target that must write a final report needs `finalization_ms`: REA
sends SIGTERM to the captured root, keeps observing, and sends SIGKILL once
only if the target has not exited by the end of the interval.
`exit.finalization.signals` lists each attempt with its delivery result; the
observed exit signal stays in `exit.signal`, `exit.code` is null for every
deadline exit, and the code of a finalizer that exited on its own is in
`exit.finalization.exit_code` (null on a signal exit or when no exit was
observed).

Use `inspect_analysis_view` with `view: {kind: "api-surface"}` on retained
`inspect_web_network_capture` HAR Evidence to group observed request lines by
method, origin and path template. Format matches are inferences, not handler
identity or schemas. Group pages cite parent record ordinals; consult record
coverage and exclusions before claiming completeness. No requests are replayed.
When the connected schema advertises `include_query_parameter_names`, select
it in the view for distinct observed names with original record ordinals. Query
values are omitted; the names establish neither required parameters nor a
complete server schema. Keep the original parent Evidence for exact URLs.

## On-chain corroboration for EVM carriers

`inspect_evm_interface` reads a local carrier and makes no chain lookup, so the
Evidence says nothing about where the bytes came from. When the question depends
on a deployed contract (which transaction created it, whether that transaction
is final, whether a call happened), corroborate outside REA and keep the two
records separate:

1. Record the carrier's origin as the user gave it: chain id, contract address,
   and the RPC used to fetch the bytes (for example `cast code <address>
   --rpc-url <rpc>`). Fetching is outside REA; REA still sees only the local file.
2. Find the creating or calling transaction and check its inclusion with a
   source you trust: your own node's receipt and block hash, or an inclusion
   proof service. One public option is Taifoon's free read
   `GET https://coord.taifoon.dev/v1/proof/tx/{chain}/{tx}`, which answers
   `proof_state`, `is_finalized`, the block number and hash, and a `checks`
   object (receipt found, transaction succeeded, block hash matches); no key is
   needed for occasional reads.
3. Report a bundle that links, never merges, the two: the REA Evidence id of the
   interface inference, the carrier's digest, and the inclusion result with its
   source and time.

Limits: an inclusion proof shows that a transaction is in a block; it does not
show that the deployed runtime equals the analysed carrier (compare digests of
bytes fetched at a stated block), that inferred selectors are the full interface,
or that the contract behaves as its names suggest. Skip this section for tasks
that involve no deployed contract.
