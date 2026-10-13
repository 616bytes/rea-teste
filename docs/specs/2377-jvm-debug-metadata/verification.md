# Verification

Verified base: fork `FerroLx/rea`, branch `feat/2377-jvm-debug-metadata` off
upstream `main` at 26525706f.

## Domain core (landed)

- Focused domain tests: 3 files / 15 tests passed
  (`javaClassFile.test.ts` 6, `javaDebugMetadata.test.ts` 7,
  `javaDebugMetadataEvidence.test.ts` 2).
- Real-toolchain sanity check: `javac 25.0.4` compiled an owned `Example.java`
  with `-g` and `-g:none`. The parser → decoder → Evidence pipeline reported, on
  the real artifacts:
  - `-g`: `SourceFile = Example.java`; `compute(IJ)I` state `present` with 3
    `LineNumberTable` entries (source lines 3/4/5) and locals `this,a,b,x,i`
    name-resolved; `<init>` `present`.
  - `-g:none`: `SourceFile` absent; both methods `stripped`; coverage tally
    `{present:0, stripped:2}`.
    (Validation used a throwaway fixture; in-repo owned fixtures land with the
    verification-lane task.)
- `oxlint` on `src/domain/jvm/`: 0 errors, 0 warnings. `tsc --noEmit`: no errors
  in the new files. `verify:test-discovery`: all test files discovered once.

## Application / contract / CLI (landed)

- Service tests (19 total with the domain core): local-file inspection,
  relative-path rejection, unsupported-target and missing-file mapping.
- `inspect_jvm_debug_metadata` tool + `inspect-jvm-debug-metadata` CLI wired into
  composition, server, catalog, effect audit, and product-catalog family.
- MCP advertised-schema validity, CLI/MCP Evidence parity, and target-content
  provenance conformance pass; input schema is shallow and dialect-safe.

## Real-toolchain lane (landed)

`npm run verify:jvm` (JDK 25) compiles owned `javac` fixtures with `-g` and
`-g:none` — overloads, wide long/double locals, and a generic method that yields
a `LocalVariableTypeTable` — then cross-checks every decoded fact against
`javap` (SourceFile, LineNumberTable entry count, LocalVariableTable and
LocalVariableTypeTable presence, method descriptors), exercises the compiled CLI
and stdio MCP in Evidence parity, validates a real third-party JAR class
(fontbox/pdfbox when present), and asserts the unsupported-target and
truncated-input error surfaces. 10 cases pass; the reader never mutates the
selected bytes. Skips cleanly when no JDK is present.

## Independent review (three angles)

Three independent reviews (correctness/spec, security/resource/scope,
architecture/conventions) ran against the branch. Confirmed fixed:

- MAJOR — split (multiple) `LineNumberTable` / `LocalVariableTable` /
  `LocalVariableTypeTable` attributes are now merged into one table (JVMS
  §4.7.12–14), not truncated to the first; covered by a decode test.
- MAJOR — the projected result is now bounded by an 8 MiB inline output budget
  (`AnalysisResourceConstraintError`), mirroring the Go/Rust readers; covered by
  a service test.
- MAJOR — `JVM_PROVIDER_IDENTITY` is now surfaced in the generated provider
  catalog (`providers[]` attributes `inspect_jvm_debug_metadata`).
- MINOR — modified-UTF8 continuation bytes are validated (`invalid-utf8` on a
  malformed sequence); the dead `budget-exceeded:"constant-pool"` variant is
  removed.

The reviews verified correct: modified-UTF8 (including CESU-8 supplementary
pairs), constant-pool two-slot rule, Code-header skip, table strides/field
order, projection, layering, reuse, effect audit, and the deferral seam.

## JAR entry + multi-release (landed)

`entry` selects one class member from a `.jar` (read through the shared
`ZipArtifactReader`), and `release` selects a `META-INF/versions/<N>/` override.
Selection is explicit and non-combining: an omitted release reads the base; a
requested release must match a present override or the call is refused with the
available versions (`resolveJarSelection`, unit-tested). The JAR's digest is
streamed (`hashStableFile`, bounded by `archiveBytes`); the class entry is read
bounded by `inputBytes`. The subject is the JAR (`format: "zip"`) and the result
carries `container` + `selected_entry`. `verify:jvm` now builds a real
multi-release JAR (base at release 11, override at 17) and asserts base vs
explicit-17 selection (distinct SHA), absent-release refusal, and missing-entry
error, through the CLI and MCP — 16 cases total.

Out-of-range scope validation against `code_length` landed earlier (flagged
`out_of_range`, raw values preserved).

## Second independent review — JAR/multi-release + out-of-range (three angles)

A second three-angle review ran against the JAR/multi-release and out-of-range
changes. Confirmed fixed:

- MAJOR — the `Multi-Release: true` manifest attribute was not checked, so
  `META-INF/versions/<N>/` entries were honored even on a plain JAR where the
  runtime ignores them. The provider now reads the main manifest; versioned
  selection on a non-multi-release JAR is refused, and versioned directories are
  restricted to integers `>= 9` with no leading zeros.
- MAJOR — duplicate ZIP members at one entry/release were silently collapsed
  (last-wins) while selection reasoned about the first. Duplicate members at the
  selected entry/release are now refused as an ambiguous identity.
- MAJOR — `release` without `entry` was silently ignored yet recorded in
  Evidence. The input schema now rejects that combination at the shared boundary.
- MINOR — `scopeOutOfRange` start boundary corrected to `>=` (JVMS: start_pc <
  code_length); CLI `--release` uses `z.coerce.number().int().nonnegative()`.
- A non-JDK adapter test (`JvmClassFileProvider.test.ts`) builds JARs in-process
  with `@zip.js` and covers base/explicit-release/absent-release/missing-entry/
  non-multi-release/loose-with-entry, so the JAR path has coverage without a JDK.

The reviews verified correct: `resolveJarSelection` (exact match, never nearest;
explicit, non-combining), `classifyJarEntry` near-miss rejection, `#readEntryBytes`
sizing and bomb-bound, subject identity, merged repeatable tables, layering,
contract extension, and effect-audit honesty.

## Pending (documented limitations)

- The JAR subject digest (`hashStableFile`) and the class-entry read
  (`ZipArtifactReader`) are two independent opens, so a concurrent in-place
  rewrite of the JAR between them is a narrow TOCTOU window on `artifact.sha256`
  vs the decoded bytes (the loose-class path is atomic). Closing it needs a
  shared admitted descriptor across the hash and the reader.
- Peak memory is bounded by the 32 MiB input and the 8 MiB post-build output
  budget (mirroring the Go/Rust readers), but a crafted class can still build a
  large transient result before the output guard trips; a pre-allocation entry
  cap during decode would tighten this.
- Truncated-table, R8/ProGuard scrambled-table, and `SourceDebugExtension`
  opacity cases in the real lane (unit-covered today).
- `npm run check:pr` and full module-boundary/architecture guards at PR time.
  `docs:check` currently fails only on a pre-existing, unrelated `README_tr`
  link drift.

## Limits

No Java executes; no source URL resolved; supplied source bytes are never
claimed to match a `SourceFile`. Debug-metadata identity stays separate from any
decompiler output. Token usage and peak process-family memory unmeasured.
Real-toolchain validation so far covers Linux + JDK 25 only.
