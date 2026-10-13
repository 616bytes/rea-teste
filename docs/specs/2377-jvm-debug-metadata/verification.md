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

## Pending (application / contract / CLI / fixtures)

- Service tests: local-file + JAR-entry + multi-release selection, parse-error
  mapping, cancellation, malformed input, bounded reads.
- Compiled CLI/MCP boundary parity and advertised-schema validity (kept shallow
  and dialect-safe per #2813/#2832).
- Owned `javac` fixtures: overloads, slot reuse, wide locals, duplicate line
  entries, invalid/out-of-range scope, truncated attributes, multi-release JAR,
  R8/ProGuard-shaped scrambled tables; `SourceDebugExtension` opacity.
- `npm run check:pr`, `docs:check`, full module-boundary/architecture guards.

## Limits

No Java executes; no source URL resolved; supplied source bytes are never
claimed to match a `SourceFile`. Debug-metadata identity stays separate from any
decompiler output. Token usage and peak process-family memory unmeasured.
Real-toolchain validation so far covers Linux + JDK 25 only.
