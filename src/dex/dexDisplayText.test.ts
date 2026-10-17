import { describe, expect, it } from "vitest";

import { displayName, displayNote, NamedMembers } from "./dexDisplayText.js";
import { DEX_LIMITS } from "./DexFileRelease.js";

describe("DEX display text", () => {
  it("keeps short names verbatim and marks a shortened one by its two ends", () => {
    expect(displayName("./classes2.dex", true)).toBe('"./classes2.dex"');
    const long = `${"./".repeat(1000)}classes7.dex`;
    const half = DEX_LIMITS.nameDisplayChars / 2;
    expect(displayName(long, true)).toBe(
      `${JSON.stringify(long.slice(0, half))}…${JSON.stringify(long.slice(-half))} (name shortened: ${String(DEX_LIMITS.nameDisplayChars)} of ${String(long.length)} characters shown)`,
    );
    expect(displayNote("x".repeat(5000))).toContain(
      `(note shortened: ${String(DEX_LIMITS.noteDisplayChars)} of 5000 characters shown)`,
    );
  });

  it("never splits a surrogate pair when shortening", () => {
    const half = DEX_LIMITS.nameDisplayChars / 2;
    const name = `${"a".repeat(half - 1)}😀${"b".repeat(500)}😀${"c".repeat(half - 1)}`;
    const shown = displayName(name);
    // Each cut falls inside a pair, so both halves of it are left out.
    expect(shown).toBe(
      `${"a".repeat(half - 1)}…${"c".repeat(half - 1)} (name shortened: ${String(2 * half - 2)} of ${String(2 * half + 500)} characters shown)`,
    );
  });

  it("counts every name past the byte budget and none twice", () => {
    const names = new NamedMembers(true);
    const huge = "y".repeat(100_000);
    for (let i = 0; i < 40; i += 1) names.add(`${huge}${String(i)}`);
    names.add(`${huge}0`);
    const kept = names.names.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept + names.unnamed).toBe(40);
    const bytes = names.names.reduce(
      (sum, name) => sum + Buffer.byteLength(names.display(name)) + 2,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(DEX_LIMITS.namedMembersBytes);
  });

  it("marks a link member within the budget, or drops and counts it", () => {
    const names = new NamedMembers(false);
    names.add("classes3.dex");
    names.add("classes3.dex", true);
    expect(names.display("classes3.dex")).toBe(
      "classes3.dex (symbolic-link mode; REA does not read it)",
    );
    // Fill the budget with unmarked names, then mark the last one kept.
    const full = new NamedMembers(false);
    let index = 0;
    for (const prefixes of [70, 0])
      for (const unnamed = full.unnamed; full.unnamed === unnamed; index += 1)
        full.add(`${"./".repeat(prefixes)}classes${String(index + 2)}.dex`);
    const last = full.names.at(-1)!;
    const before = full.unnamed;
    full.add(last);
    full.add(last, true);
    expect(full.names).not.toContain(last);
    // All three occurrences of the dropped name are counted.
    expect(full.unnamed).toBe(before + 3);
    const bytes = full.names.reduce(
      (sum, name) => sum + Buffer.byteLength(full.display(name)) + 2,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(DEX_LIMITS.namedMembersBytes);
  });
});
