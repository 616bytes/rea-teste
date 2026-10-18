# Ghidra 65816 / SNES ROM analysis

REA admits `65816` as a raw-only architecture so single-file Super Nintendo ROM dumps (`.sfc` / `.smc`) can be opened and analysed through the existing Ghidra provider.

## Requirements

- Ghidra with a community 65C816 / 65816 processor extension installed (upstream Ghidra does not ship one). Common options include:
  - https://github.com/joshleaves/ghidra-snes
  - https://github.com/achan1989/ghidra-65816 (archived)
- A caller-supplied single-file ROM that you own or are authorised to analyse.

## Usage

Open the ROM as a raw binary and explicitly select the architecture and entry point:

```bash
rea analyze /path/to/game.sfc --target-format raw-binary --architecture 65816 --entry-point 0x8000
```

Or via MCP `open_binary` with:
```json
{
  "path": "/path/to/game.sfc",
  "format": "raw-binary",
  "architecture": "65816",
  "entry_point": "0x8000"
}
```

Common starting load addresses:
- LoROM: `0x8000` (or bank-aware equivalents)
- HiROM: `0x8000` or `0xC00000` depending on mapping

REA does not auto-detect LoROM vs HiROM or interleave multi-file ROM sets in this version. Supply the correct load address yourself.

## Limitations

- No automatic memory map / LoROM-HiROM detection.
- No multi-file or interleaved ROM support.
- No emulation.
- Decompilation quality depends on the installed 65816 SLEIGH module and on correctly setting the M/X flag state in Ghidra for the region being analysed.
- Analysis is read-only.
- Actual decompilation requires a compatible Ghidra 65816 language extension; REA only admits the architecture and hands the bytes to Ghidra.

## Related

- Issue: https://github.com/morluto/rea/issues/4794
- Existing raw-binary path used by `6502`.
