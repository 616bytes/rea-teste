import { describe, expect, it } from "vitest";

import {
  ghidraOnlyArchitectureLabel,
  isGhidraOnlyArchitecture,
} from "./binaryTargetTypes.js";

describe("Ghidra-only families", () => {
  it.each([
    ["mips", "MIPS"],
    ["riscv", "RISC-V"],
    ["powerpc", "PowerPC"],
    ["hexagon", "Hexagon"],
    ["sparc", "SPARC"],
  ] as const)("declines %s by its documented name", (family, label) => {
    expect(isGhidraOnlyArchitecture(family)).toBe(true);
    expect(ghidraOnlyArchitectureLabel(family)).toBe(label);
  });

  it("leaves header-only families outside the Ghidra-only partition", () => {
    expect(isGhidraOnlyArchitecture("x86")).toBe(false);
    expect(isGhidraOnlyArchitecture("arm64")).toBe(false);
  });
});
