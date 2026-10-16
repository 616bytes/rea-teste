import { describe, expect, it } from "vitest";
import { classifySwiftSymbol } from "./swiftSymbolClassification.js";

describe("bounded substituted extension contexts", () => {
  it.each([
    "AAE",
    "ABE",
    "AASQRzlE",
    "AASQR_rlE",
    "AASQR0_r0_lE",
    "AASQRd__r_zlE",
    "AARi_zrlE",
    "AARi0_d0_1_r0_1_lE",
    "A2A1PRzlE",
    "AaA1PRzlE",
    "AAAB1PRzlE",
    "AA5Other1PRzlE",
    "AASQRzSQR_rlE",
  ])("stops carrying nominal evidence at %s", (tail) => {
    expect(classifySwiftSymbol(`$s1M1WV${tail}1fyyF`)).toEqual({
      category: null,
    });
  });

  it.each([
    // E must be an operator at the exact context boundary, not identifier text.
    "AA1E",
    "AA5Other1ERzl",
    "AA5Other2PERzl",
    "AA5Other99PRzlE",
    "AA5Other01PRzlE",
    "AA5Other99999999999999999999PRzlE",
    // Missing/malformed indexes and signature terminators.
    "AASQRlE",
    "AASQR0lE",
    "AASQRd_lE",
    "AASQRd0_ElE",
    "AASQR99999999999999999999_lE",
    "AASQR2147483647_lE",
    "AASQRzE",
    "AASQRzr0_E",
    "AARizrlE",
    "AARi_zrEl",
    "AASQRzr99999999999999999999_lE",
    // Pending groups, nominal/out-of-inventory references, unsafe counts.
    "A2AE",
    "AaE",
    "A3A1PRzlE",
    "AaC1PRzlE",
    "ACE",
    "AZE",
    "A_E",
    "A99999999999999999999A1PRzlE",
    "A0A1PRzlE",
    // Unsupported requirements retain baseline behavior; no search for later E.
    "AASiRszlE",
    "AASQRpzlE",
    "AARvzlE",
    "AA5Other1PRzl1EE",
    "AA5Other1PRzlTW",
    "AAunknownE",
  ])(
    "retains baseline nominal classification for unsupported tail %s",
    (tail) => {
      expect(classifySwiftSymbol(`$s1M1WV${tail}1fyyF`)).toEqual({
        category: "structs",
      });
    },
  );
});
