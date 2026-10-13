# JVM class-file debug metadata

REA reads compiler-emitted debug metadata from one caller-selected local `.class`
file so an analyst can judge **debugging readiness before attaching a debugger**.
The reader is in-process and dependency-free: it decodes class-file attributes
only, never executes Java, never resolves a source URL, and never claims that
supplied source matches a declared `SourceFile`. Decompiler line numbers are not
compiler-emitted source positions and are never substituted for them.

CLI and MCP share one workflow and return artifact-bound Evidence inline.

## Answer an analyst question

```sh
rea inspect-jvm-debug-metadata /path/Example.class
```

The MCP method is `inspect_jvm_debug_metadata`; its only argument is the absolute
local `path`:

```json
{
  "name": "inspect_jvm_debug_metadata",
  "arguments": { "path": "/path/Example.class" }
}
```

## Interpret the result

The normalized result binds every fact to exact identity:

- `artifact` — selected `path`, exact-byte `sha256`, and `bytes`. The reader does
  not mutate the selected bytes; `sha256` identifies them, not authenticity or
  the producing compiler.
- `class` — `internal_name` (decompiler representation), `major_version`,
  `minor_version`.
- `source_file` — `presence` (`present` | `absent` | `malformed`) and the
  declared `name` when present.
- `source_debug_extension` — `presence` and opaque `byte_length`. The bytes are
  preserved but never interpreted; no source-map dialect is parsed.
- `methods[]` — each with `name`, `descriptor`, debugging `state`, and the three
  decoded tables:
  - `line_number_table` — `start_pc` → `line_number` entries.
  - `local_variable_table` — `start_pc`, `length`, `name`, `descriptor`, `slot`.
  - `local_variable_type_table` — as above with a generic `signature`.
  - `reused_slots` — slots that appear in more than one local-variable entry.
    Reuse is legal; a reused slot may denote different variables across disjoint
    scope ranges, so entries are preserved rather than merged.
- `coverage` — method counts per state, derived from examined methods.

### Method debugging state

| `state`          | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `present`        | both line and local-variable tables decoded                        |
| `partial`        | one table present, the other absent                                |
| `stripped`       | a body exists but carries neither table (e.g. `javac -g:none`)     |
| `malformed`      | a present table failed to decode fully; recovered entries are kept |
| `not-applicable` | no `Code` attribute (native/abstract, or no body)                  |

A table whose declared entry count exceeds its bytes is reported `malformed` with
the entries recovered before the short read; absent, malformed, partial, and
ambiguous (reused-slot) cases stay distinct and are never collapsed into
"absent".

## Scope and limits

Static class-file inspection only. No Java executes; no source URL is resolved;
supplied source bytes are never claimed to match a `SourceFile` name. Debug
metadata identity stays separate from any decompiler output. Standalone `.class`
inspection is independent of the Android/JADX lane and of the JVM runtime
(JDWP) proposal. A malformed or truncated class file is reported through the
tagged error algebra rather than throwing or over-allocating. A single class
file far over the input budget is refused before allocation.

Verified by the `verify:jvm` real lane, which compiles owned `javac` fixtures
with `-g` and `-g:none`, cross-checks every decoded fact against `javap`, and
exercises the CLI and MCP in parity against real application bytecode.
