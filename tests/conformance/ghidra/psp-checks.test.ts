import assert from "node:assert/strict";
import { it } from "vitest";
import { parsePspReadelfMips } from "./psp-fixture.mjs";

// GNU readelf 2.44 output from the maintained PSPDEV v20261001 fixture.
const observed = `MIPS ABI Flags Version: 0
ISA: MIPS2
GPR size: 32
CPR1 size: 32
CPR2 size: 0
FP ABI: Hard float (single precision)
ISA Extension: None
ASEs:
  None
FLAGS 1: 00000001
FLAGS 2: 00000000
`;

// Constructed section-table controls combined with the captured ABI declaration;
// this does not establish a real PSPSDK or Allegrex-provider run.
const metadata = `ELF Header:
  Class: ELF32
  Data: 2's complement, little endian
  Type: EXEC (Executable file)
  Machine: MIPS R3000
  Flags: 0x10a23001, noreorder, allegrex, eabi32, mips2
  Number of section headers: 3
Section Headers:
  [Nr] Name              Type            Addr     Off    Size   ES Flg Lk Inf Al
  [ 0]                   NULL            00000000 000000 000000 00      0   0  0
  [ 1] .MIPS.abiflags    MIPS_ABIFLAGS   08800118 000118 000018 18   A  0   0  8
  [ 2] .text             PROGBITS        08800130 000130 000010 00  AX  0   0 16
${observed}`;

it("reads the independent PSP producer's single-float declaration", () => {
  assert.deepEqual(parsePspReadelfMips(metadata), {
    elfClass: 32,
    byteOrder: "little",
    type: 2,
    flags: 0x10a23001,
    gnuAttributes: null,
    abiFlags: {
      version: 0,
      isaLevel: 2,
      isaRevision: 0,
      gprSize: 1,
      cpr1Size: 1,
      cpr2Size: 0,
      fpAbi: 2,
      isaExtension: 0,
      ases: 0,
      flags1: 1,
      flags2: 0,
    },
  });
});

it.each([
  ["ISA: MIPS2", "ISA: MIPS32r2"],
  ["GPR size: 32", "GPR size: 64"],
  ["Hard float (single precision)", "Hard float (double precision)"],
  ["FLAGS 1: 00000001", "FLAGS 1: 00000003"],
  ["FLAGS 2: 00000000", "FLAGS 2: 00000001"],
  ["MIPS ABI Flags Version: 0", "MIPS ABI Flags Version: 1"],
  ["CPR1 size: 32", "CPR1 size: 0"],
  ["ISA Extension: None", "ISA Extension: R5900"],
  ["GPR size: 32", "GPR size: 32\nGPR size: 32"],
  ["FLAGS 1: 00000001", ""],
])(
  "rejects unsupported or ambiguous independent ABI output: %s",
  (before, after) => {
    assert.throws(() => parsePspReadelfMips(metadata.replace(before, after)));
  },
);

it.each([
  [
    "missing table",
    metadata.replace(
      /Section Headers:[\s\S]*?MIPS ABI Flags/u,
      "MIPS ABI Flags",
    ),
  ],
  ["incomplete table", metadata.replace(/^.*\[ 2\].*\n/gmu, "")],
  ["duplicate index", metadata.replace("[ 2]", "[ 1]")],
  [
    "GNU section under another name",
    metadata.replace(
      ".text             PROGBITS",
      ".text             GNU_ATTRIBUTES",
    ),
  ],
])("refuses PSP GNU attribute absence from a %s", (_name, text) => {
  assert.throws(() => parsePspReadelfMips(text), /section|GNU attributes/u);
});

it.each([
  ["Class: ELF32", "Class: ELF64"],
  ["little endian", "big endian"],
  ["Type: EXEC", "Type: REL"],
  ["Flags: 0x10a23001", "Flags: 0x70001001"],
  ["Class: ELF32", "Class: ELF32\n  Class: ELF32"],
])("refuses contradictory or ambiguous PSP headers: %s", (before, after) => {
  assert.throws(() => parsePspReadelfMips(metadata.replace(before, after)));
});
