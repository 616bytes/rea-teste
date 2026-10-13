# Inspect JVM source-line & local-variable debug metadata (#2377)

## Outcome and scope

Read compiler-emitted debug metadata from one caller-selected `.class` file or a
selected JAR entry, so an analyst can judge debugging readiness **before**
attaching a debugger. No Java executes; no source URL is resolved; no live target
is involved. This is static format inspection within existing offline-artifact
authority, not a new runtime provider and not decompilation.

The tool reads only these class-file attributes: `SourceFile`,
`SourceDebugExtension`, `LineNumberTable`, `LocalVariableTable`,
`LocalVariableTypeTable`. Decompiler line numbers are not compiler source
positions and are never substituted for these.

## Inspection contract

Bind every fact to exact identity: class internal name/descriptor, source file
name as declared, major/minor version, and per method the name **plus
descriptor**, bytecode offset, local **slot** and scope range. A method debug
state is reported as `present | stripped | partial`. Absent tables, malformed
records, partial examination and ambiguous mappings are distinguished; a reused
local slot may denote different variables across scope ranges and is never
collapsed. `SourceDebugExtension` bytes are preserved opaquely with bounded
access; an admitted source-map dialect is interpreted only when established, and
unknown extensions remain opaque rather than guessed.

In a multi-release JAR the requested effective class version is selected
explicitly or its alternatives are reported; metadata from different entries is
never silently combined. Ordering is deterministic by member and offset. The
result returns artifact path/digest/length, class identity, the bound debug
facts, examined-vs-reported `coverage`, `limitations`, and explicit `unknown`s.
Supplied source bytes are never claimed to match a `SourceFile` name.

## Authority and overlap

Reads the supplied artifact only: no process, network, UI, or mutation effects,
no target acquisition, no foreign-code execution. Debug-metadata identity stays
separate from any decompiler output. Standalone `.class`/JAR inspection is
deliberately independent of the Android/JADX lane (`REA_JADX_MCP_JAR`) and of the
JVM runtime/JDWP proposal (#2376). Parent Java domain: #1558.

## Resource admission

Every length-prefixed structure is bounded before allocation: constant-pool
count, attribute length, and table entry counts are validated against the
artifact's own declared sizes and a file-size budget; exhaustion reports an
`AnalysisResourceConstraintError` rather than allocating. JAR entry reads are
bounded per entry. Parsing is linear in examined bytes. Token usage and peak
process-family memory remain unmeasured at spec time.

## Verification

Owned `javac` fixtures compiled with full `-g` and with `-g:none` show the actual
difference. Tests cover overloads, local-slot reuse across scopes, wide
(long/double) locals, duplicate line entries, invalid/out-of-range scope,
truncated attributes, a multi-release JAR binding to the selected member, and an
R8/ProGuard-shaped scrambled-table class (reported as-is; no deobfuscation).
`SourceDebugExtension` tests separate opaque preservation from any verified
mapping. Exercise CLI/MCP parity, advertised-schema validity (kept shallow and
dialect-safe, per #2813/#2832), cancellation, malformed input, and partial
coverage. Independent subagent review before handoff.

Format reference: JVMS class-file attributes, sections 4.7.10–4.7.14 —
https://docs.oracle.com/javase/specs/jvms/se25/html/jvms-4.html
