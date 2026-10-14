# Fiddler SAZ selection checkpoint

This experiment addresses [#3132](https://github.com/morluto/rea/issues/3132).
Its runtime baseline is `ca1b2f8608c52ed721d3576ba5eeb1d66717b08c`.
Production APIs and defaults are unchanged. SDK/model costs are not yet measured;
the corpus and independent stored-byte checks below establish no performance win.

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
SHA-256. A third public 103-session archive was inspected during corpus discovery
but is outside the selected cohort. Archive comments report their producer
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

The baseline build and five oracle regressions passed on Linux. Real CLI/MCP
selection equivalence, model task correctness/costs and other platform behavior
remain unverified at this corpus checkpoint. Detailed outputs stay in the private
lab; missing resource counters remain unknown.
