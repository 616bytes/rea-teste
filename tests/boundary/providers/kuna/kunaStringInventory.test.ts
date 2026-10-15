import { expect, it } from "vitest";

import { parseKunaStringInventory } from "../../../../src/kuna/KunaStringInventory.js";

const input = "/private/program";
const row = {
  address: "@9007199254740993",
  address_hex: "0x20000000000001",
  text: "a\nΔelta",
  length: 7,
  byte_length: 9,
  nul_terminated: true,
  encoding: "utf8",
  section: ".rodata",
  xrefs_count: 0,
  functions: [],
};
const document = () => ({
  binary: input,
  encoding: "all",
  min_length: 5,
  filter: null,
  section: null,
  termination: "any",
  scanned: "sections",
  xrefs: false,
  count: 1,
  strings: [row],
});
const wire = (value: unknown) =>
  JSON.stringify(value).replace(/"@(\d+)"/gu, "$1");

it("preserves exact u64 string identity, multiline text and typed source facts", () => {
  const result = parseKunaStringInventory(wire(document()), input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      scanned: "sections",
      items: [
        {
          address: "0x20000000000001",
          value: "a\nΔelta",
          string: {
            encoding: "utf8",
            encoding_status: "observed",
            termination: "present_or_not_required",
            byte_length: 9,
          },
        },
      ],
    },
  });
});

it.each([
  ["input", { binary: "/other/program" }],
  ["count", { count: 2 }],
  ["filter", { filter: "narrowed" }],
  ["xrefs", { xrefs: true }],
  ["encoding", { encoding: "ascii" }],
  ["scan scope", { scanned: "unknown" }],
  [
    "address identity",
    { strings: [{ ...row, address_hex: "0x20000000000000" }] },
  ],
  ["u64 overflow", { strings: [{ ...row, address: "@18446744073709551616" }] }],
  ["partial row", { strings: [{ ...row, byte_length: null }] }],
  ["unexpected references", { strings: [{ ...row, xrefs_count: 1 }] }],
  ["duplicate identity", { count: 2, strings: [row, row] }],
])(
  "rejects inconsistent %s before publishing any strings",
  (_label, changes) => {
    expect(
      parseKunaStringInventory(wire({ ...document(), ...changes }), input).ok,
    ).toBe(false);
  },
);
