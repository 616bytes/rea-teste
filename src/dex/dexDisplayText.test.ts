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

  it("marks each name entry would refuse and keeps only plain ones selectable", () => {
    const names = new NamedMembers(false);
    names.add("classes2.dex");
    names.add("classes3.dex", { symlink: true });
    names.add("classes4.dex", { encrypted: true });
    names.add("classes5.dex");
    names.add("classes5.dex", { symlink: true });
    expect(names.names.map((name) => names.display(name))).toEqual([
      "classes2.dex",
      "classes3.dex (symbolic-link mode; REA does not read it)",
      "classes4.dex (encrypted; REA does not read it)",
      "classes5.dex (stored 2 times; ambiguous)",
    ]);
    expect(names.names.filter((name) => names.isSelectable(name))).toEqual([
      "classes2.dex",
    ]);
  });

  /**
   * Fill the byte budget, `used` bytes already spent, to within 5 bytes (less
   * than any mark or short name), then leave out one short name, returned.
   */
  const fill = (names: NamedMembers, used = 0): string => {
    let room = DEX_LIMITS.namedMembersBytes - used - 5;
    for (let index = 0; room > 0; index += 1) {
      // Each name costs its length plus the ", " separator.
      const length = Math.min(150, room - 2);
      names.add(`n${String(index)}`.padEnd(length, "x"));
      room -= length + 2;
    }
    const left = "classes99.dex";
    names.add(left);
    return left;
  };
  const bytesOf = (names: NamedMembers): number =>
    names.names.reduce(
      (sum, name) => sum + Buffer.byteLength(names.display(name)) + 2,
      0,
    );

  it("drops a name whose mark no longer fits and counts it ever after", () => {
    const full = new NamedMembers(false);
    fill(full);
    expect(bytesOf(full)).toBe(DEX_LIMITS.namedMembersBytes - 5);
    const last = full.names.at(-1)!;
    const before = full.unnamed;
    full.add(last, { symlink: true });
    expect(full.names).not.toContain(last);
    // Both occurrences of the dropped name are counted.
    expect(full.unnamed).toBe(before + 2);
    // A later occurrence is counted too, never re-added without its mark.
    full.add(last);
    expect(full.names).not.toContain(last);
    expect(full.unnamed).toBe(before + 3);
    expect(bytesOf(full)).toBeLessThanOrEqual(DEX_LIMITS.namedMembersBytes);
  });

  it("admits no name after one is left out, even when a mark shrinks", () => {
    const names = new NamedMembers(false);
    names.add("classes2.dex", { symlink: true });
    const left = fill(names, bytesOf(names));
    const before = names.unnamed;
    // The link's mark becomes the shorter ambiguity mark, freeing bytes.
    names.add("classes2.dex");
    expect(names.display("classes2.dex")).toBe(
      "classes2.dex (stored 2 times; ambiguous)",
    );
    names.add(left);
    expect(names.names).not.toContain(left);
    expect(names.unnamed).toBe(before + 1);
  });
});
