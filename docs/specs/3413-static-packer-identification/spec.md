# Static packer identification for PE and ELF

Issue: [#3413](https://github.com/morluto/rea/issues/3413), Part A only.

## Scope

One read-only operation, `inspect_packer_indicators`, available through MCP and
the `inspect-packer-indicators` CLI command. It reads one stable regular file
and reports packer indicators for PE32, PE32+, ELF32 and ELF64 images. It
introduces no process launch, emulation, external tool or file write.

## Out of scope

- Part B of #3413: producing a decompressed derived artifact with a
  caller-supplied UPX binary. It waits for the maintainer answer on whether
  `upx -d` is ordinary standard-compression extraction under the current scope.
- Commercial protectors, code virtualization, runtime dumping, OEP or IAT
  reconstruction.
- PE resource string and version decoding (tracked separately in #2812/#2887).
- DOS MZ images without a PE header, Mach-O and other formats.

## Contract

Input: `path` (absolute) and `max_file_bytes` (default 64 MiB, maximum 512 MiB).

Output (Evidence result, `confidence: observed`):

| Field         | Content                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `artifact`    | path, SHA-256, byte count of the stable snapshot                       |
| `format`      | `pe32`, `pe32-plus`, `elf32` or `elf64`; `machine` is the header value |
| `regions`     | sections/segments: sizes, file range, flags, Shannon entropy           |
| `entry_point` | address (PE RVA), containing region, file offset                       |
| `signatures`  | packer section names and magic with file offsets                       |
| `imports`     | PE import libraries, counts, loader-style APIs; ELF `not_applicable`   |
| `overlay`     | trailing bytes after mapped file ranges, entropy, PE certificate range |
| `indicators`  | named `strong` or `supporting` indicators with detail                  |
| `verdict`     | `likely_packed`, `not_observed` or `unknown` with a basis sentence     |
| `limitations` | fixed and per-file limitations                                         |

## Verdict rules

- Any strong indicator (known section name or magic): `likely_packed`.
- Two or more supporting indicators: `likely_packed`.
- One supporting indicator, or an image region/import directory that could not
  be examined: `unknown`.
- Otherwise `not_observed`, which never establishes that a file is unpacked.

## Failure behavior

Non-PE/ELF bytes and truncated or inconsistent headers fail as `invalid_format`
input errors. Missing files, permission failures, budget exhaustion, artifact
changes during reading and cancellation use the same typed errors as
`inspect_pe_resources`. Section ranges past the end of the file are clamped,
reported as limitations and make the verdict at most `unknown` unless another
indicator applies. An inconsistent PE import directory is reported as
`unreadable` rather than partially decoded.

## Verification

Unit tests use hand-built PE32, PE32+, ELF32 and ELF64 images, including
layouts shaped like UPX output (empty RWX `UPX0`, high-entropy `UPX1` holding
the entry, `UPX!` magic, loader-only imports) built from deterministic filler.
No packed program is committed. Filesystem boundary tests cover the stable
reader, typed failures and cancellation.
