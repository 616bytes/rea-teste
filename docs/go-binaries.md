# Go binary metadata and function entries

`inspect_go_binary` / `inspect-go-binary` answers which Go compiler version,
modules, replacements and build settings are embedded in one selected local
executable or library. It reads the file without running it and requires no
Go installation, active binary target, Hopper, Ghidra or IDA.

With `--functions` (MCP: `functions: true`), ELF64 little-endian amd64 inspection also reads compiler-declared
function names and entry coordinates from a named Go 1.20-layout `.gopclntab`.

```bash
rea inspect-go-binary /absolute/path/to/application --json
rea inspect-go-binary /absolute/path/to/application --functions --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_go_binary",
  "arguments": { "path": "/artifacts/application" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, byte length,
container format, architecture, word size and byte order. A recognized
`build_info` record contains:

- `go_version`, preserved as embedded UTF-8 text rather than forced into a
  semantic version, or `null` when the embedded bytes are not UTF-8;
- `go_version_bytes_base64`, preserving the exact compiler-string bytes;
- exact file offsets and byte lengths for the header, compiler string and module
  string;
- `module_text`, the decoded module-information body, or `null` when the complete
  body cannot be represented as UTF-8;
- `module_bytes_base64`, the original module-string bytes including Go framing;
- `module.path`, the embedded package path;
- `module.main`, the main module's path, version, checksum and optional
  replacement;
- `module.dependencies`, with the same fields and their original order;
- `module.settings`, retaining ordered key/value entries and duplicate keys;
- `module.unparsed_lines`, `module.unparsed_line_bytes_base64` and
  `module.complete`, so unfamiliar, malformed, conflicting or undecodable records
  do not disappear behind a complete result.

Missing checksums are `null`; empty fields and development/local replacement
versions remain unchanged. Build settings such as `GOOS`, `GOARCH` or `vcs.revision`
are reported when present. Their absence does not establish a build choice.
Go strings may contain arbitrary bytes. Non-UTF-8 records remain available as
base64 while other decodable module records are still reported; the reader does
not insert replacement characters or reject the entire artifact for those
strings.

## Supported boundary

### Function entries

`functions.state` defaults to `not-requested`, with an empty entry list. Function
table work and output occur only with `--functions` / MCP `functions: true`.
When requested, the state is `complete` when every declared function-table row was
decoded, or `unavailable` with an explicit `reason` and `limitation`. Complete
coverage describes that table only, not all code or inline functions in the image.
Unavailable coverage has no entries and never asserts that no functions exist.
A malformed function table preserves independently readable build information;
resource exhaustion fails the operation without partial success.

Each entry contains `name`, `entry_address` (a hexadecimal string), a verified
`file_offset`, the original `table_row_offset` and `function_data_offset`, and
`name_location` (UTF-8 bytes excluding the terminating NUL). The table range and
all coordinates belong to the reported artifact SHA-256. No function size is
inferred from adjacent entries.

The initial boundary is ELF `ET_EXEC`, 64-bit little-endian amd64, quantum 1,
pointer width 8, and pclntab magic `0xfffffff1` (Go 1.20 layout). A unique
file-backed, read-only, uncompressed `.gopclntab` and a unique file-backed `.text`
with consistent load mappings are required. `text_start` comes from the `.text`
section address, identified by `text_start_source: ".text-section"`, as in Go's
standard `debug/gosym` reader. `declared_text_start` preserves the table header's
separate value, which can be zero. PIE, relocatable images, PE/Mach-O functions,
other architectures/layouts and sectionless discovery remain unavailable.

Local producer verification used Go 1.27.0 normal and `-s -w` stripped Linux
amd64 executables, comparing every name/address/file offset against Go's standard
`debug/elf` and `debug/gosym` readers. This verifies those samples, not every Go
release sharing the layout. Inspection itself requires no compiler.

Function-name scanning has a cumulative 1 MiB budget; table decoding is limited
to 16 MiB, entry representation to 8 MiB, and address checks to 4,194,304 mapping
comparisons. These admission limits apply before materializing oversized results.

### Build information

The built-in TypeScript reader supports ELF, PE and thin Mach-O images with Go's
inline or historical pointer build-info encoding. Source ranges refer to the
original stable file snapshot, including pointer-backed strings. It does not
scan arbitrary byte strings as compiler metadata or interpret a fat Mach-O
container as one selected architecture.

For ELF images without a named build-info section, discovery checks each
nonempty writable, non-executable load segment in program-header order. This
includes sectionless PIE images with metadata in a later data segment. Named
sections retain priority, and alignment, file mapping and record validation
remain required.

Historical moduleless Go binaries can store their empty module-string header in
declared zero-initialized virtual memory rather than file-backed bytes. The reader
recognizes this only when the complete optional module header lies in that memory
without a conflicting file mapping. Its module contents are empty and
`module_location` has zero bytes, anchored at the build-info field containing the
module-header pointer. Compiler strings and other unmapped pointers remain strict
file-backed reads.

`build_info: null` means no recognized record was found in the inspected image.
It does not prove that the binary is not Go. Stripping, old builds, deliberate
removal and obfuscation can limit metadata. A malformed supported container or
recognized build-info record returns an input-format failure. Unsupported
containers receive a separate unsupported-target failure.

Symlinks and nonregular files are rejected. The shared stable reader detects
replacement and observed in-place changes during acquisition. Missing files,
host permission denial, changed artifacts and cancellation retain distinct
errors. The selected file is never modified; this inspection creates no
temporary files, starts no subprocesses and accesses no network endpoint.

Resource guards bound the selected file and cumulative header searches to 256 MiB
each, aggregate embedded strings
to 1 MiB, structural table decoding to 16 MiB and the complete normalized metadata
report to 8 MiB. Identical search spans with the same virtual alignment are
searched once; partially overlapping spans consume the cumulative search budget
and fail with a CPU resource constraint when it is exhausted. Oversized results
fail without partial success. MCP also applies
its [response transport budget](mcp-contracts.md), which counts both text and
structured content; a report within the metadata limit can still require export
from retained Evidence. These limits are not operating-system memory or CPU
isolation.

Embedded metadata is evidence of file content. It does not authenticate a
compiler, dependency, commit or supply chain, and it does not establish runtime
behavior. Source mappings, types and decompiled code remain outside
this tool's coverage. Use the [native workflow](native-investigation.md) when
those questions require a disassembler.

## Real producer verification

`npm run verify:go:binary` exercises compiler-built fixtures through the public
CLI and MCP, comparing their metadata with Go's standard `debug/buildinfo`
reader. The verification lane requires Go; normal inspection does not.
For supported Linux amd64 executables, it additionally compares every function
name, entry address and mapped file offset with `debug/elf` and `debug/gosym`,
including a Unicode name. Other producer targets verify explicit unavailable
function coverage.
