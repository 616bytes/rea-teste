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

## Pending

- JAR entry selection and multi-release resolution (separate change, reusing
  `ZipArtifactReader`), with its fixture matrix (multi-release, truncated-table,
  R8/ProGuard scrambled tables, `SourceDebugExtension` opacity in the lane).
- `npm run check:pr` and full module-boundary/architecture guards at PR time.
  `docs:check` currently fails only on a pre-existing, unrelated `README_tr`
  link drift.

## Limits

No Java executes; no source URL resolved; supplied source bytes are never
claimed to match a `SourceFile`. Debug-metadata identity stays separate from any
decompiler output. Token usage and peak process-family memory unmeasured.
Real-toolchain validation so far covers Linux + JDK 25 only.
