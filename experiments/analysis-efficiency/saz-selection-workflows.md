# Fiddler SAZ selection checkpoint

This experiment addresses [#3132](https://github.com/morluto/rea/issues/3132).
Its runtime baseline is `ca1b2f8608c52ed721d3576ba5eeb1d66717b08c`.
Production APIs and defaults are unchanged. Formal SDK/model costs are not yet
measured; the corpus and preflight checks below establish no token/time win.

## Genuine public corpus

Both archives come from Microsoft's
[Xbox Live Trace Analyzer](https://github.com/microsoft/xbox-live-trace-analyzer/tree/ad880ff00b26c4cae5e3c8864d3df438a03890ba/Source/TestData/CertWarnings)
at immutable revision `ad880ff00b26c4cae5e3c8864d3df438a03890ba`.
The repository's [MIT license](https://github.com/microsoft/xbox-live-trace-analyzer/blob/ad880ff00b26c4cae5e3c8864d3df438a03890ba/LICENSE.md)
and original source files remain upstream. No sample binaries, raw HTTP material,
authentication values, configs or detailed results are committed.

| Artifact                 | Archive bytes | Expanded member bytes | Sessions | Members | Producer archive comment |
| ------------------------ | ------------: | --------------------: | -------: | ------: | ------------------------ |
| `xbox-clear_nomp.saz`    |        43,515 |                62,609 |       13 |      42 | Fiddler v4.5.1.2         |
| `xbox-clear_mp_cs10.saz` |     5,223,519 |             9,223,820 |    1,311 |   3,939 | Fiddler v4.6.2.0         |

`corpus.json` pins download URLs, file sizes, SHA-256, Git blob IDs, directory
coverage and question ordinals. Downloaded bytes match their Git blob and
SHA-256. A third public 103-session archive is pinned as an admission-negative
probe, outside completed-question comparisons. Archive comments report their producer
versions; no local Fiddler installation or independent producer-version proof
is claimed.

## Fixed analyst question

Before examining transaction facts, select ordinals `[12, 0, 6]` in the control
and `[1310, 0, 655]` in the larger archive. Return that caller-selected order,
original padded session IDs and archive-member coordinates, request method/URL,
response status/version, all recorded Content-Type pairs in their original
spelling/order, and stored response-body byte length/SHA-256.

Bodies retain their archived encoding. CONNECT trailing bytes are stored data,
not an inferred HTTP application body or certificate interpretation. Empty bodies
have zero bytes and the empty digest; an absent response remains absent. Header
duplication/folding, Latin-1 spelling and binary body bytes are independently
read without REA imports. Synthetic reader tests cover those semantics and
malformed input; they establish no provider coverage.

The oracle admits only immutable corpus size/digest matches before constructing
ZIP objects, preserves central-directory session/member order, reads selected
members with size sentinels and CRC validation, and checks the source digest
again. Necessary facts are independently checked for all six selected records.

```sh
python3 experiments/analysis-efficiency/test_saz_oracle.py
python3 experiments/analysis-efficiency/saz-oracle.py xbox-clear_nomp.saz /absolute/clear_nomp.saz
python3 experiments/analysis-efficiency/saz-oracle.py xbox-clear_mp_cs10.saz /absolute/clear_mp_cs10.saz
```

The baseline build, five oracle regressions and the SDK checker semantics passed
on Linux. Real MCP preflight checks verify control retained pages/repeated reads,
the large ordinal-selected result, and large complete-workflow recovery. The
default large MCP return completes analysis but exceeds the existing 10 MiB stdio
receive-buffer budget; its exact returned retained Evidence reference supports
summary and complete pages. Recovery preserves the failed RPC and every follow-up
call, and matches the independently checked necessary facts from direct selection.
This transport limit is not a decoding timeout. Formal repetitions and actual
model tasks remain unrun; preflight observations are not eligible cost pairs.

The 103-session `xbox-x49_mp_cs21.saz` candidate contains an empty stored response
member `raw/099_s.txt`, lacking an HTTP header/body separator. On this baseline,
whole-capture admission fails with `invalid_request` / `invalid_format`. Its
ordinals `[102, 0, 51]` were fixed before inspecting its transaction facts. The
failed attempt/source member is preserved as a negative probe; no parser repair
or successful-task comparison is claimed for that archive.

Actual-model correctness/costs and other platform behavior remain unverified.
Detailed outputs stay private; missing resource counters remain unknown.

The large selected CLI workflow also matches independent bytes and MCP facts,
parameters and Evidence ID. A separate default complete CLI attempt hit the
provider's 30-second timeout under the one-CPU guard; that failed attempt is
preserved separately from the successful-analysis MCP receive-buffer failure.
It does not prove a general CLI failure or identify an engine-stage cause.

Ten grading preflight cases cover valid actual Evidence, wrong final digests,
unknown citations, missing limitations, answer order, failed calls before/after
valid data, semantic-ID corruption and actual large retained recovery. Their
answers/events are injected checker tests, not actual model trials. An invalid
later duplicate is rejected by the domain's semantic-ID owner and does not erase
earlier authenticated observations.

## SDK and model reproduction

```sh
node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/frozen-runtime --revision ca1b2f8608c52ed721d3576ba5eeb1d66717b08c \
  --artifact xbox-clear_nomp.saz --path /absolute/clear_nomp.saz \
  --output /absolute/new-result-dir --schemas selected --saz-selection focused
node experiments/analysis-efficiency/saz-model-prompt.mjs \
  --artifact xbox-clear_nomp.saz --selection focused > /absolute/prompt.txt
```

Use the same runtime, inputs, explicit provider settings and resource profile
within a cost cohort; retain runtime/workflow/oracle/settings fingerprints. Repeat
both core archives with baseline/focused/focused/baseline order and retain all
failures/recovery RPCs. The `retained` diagnostic workflow also measures preview,
two complete pages and a repeated first page. Preview omits headers, so preview
alone is not equivalent to the complete header/body question.

Run real Codex tasks through `agent-trial.py` with an isolated temporary profile,
the two exact `inspect_web_network_capture` / `inspect_analysis_view` tools,
the same requested model/reasoning and at least two baseline/focused pairs for
the control. Grade cited observations with `review-saz.mjs`, an independently
produced oracle and the tested runtime. Count whole-task input/output tokens,
cached input, elapsed time and all calls; parsed JSON bytes are not model tokens.
Only executed trials may fill the current unverified cost/model scope above.
