import { describe, expect, it } from "vitest";

import {
  clientConfigurationValuesEqual,
  parseClientConfiguration,
  serializeClientConfiguration,
} from "./ClientConfigurationDocument.js";

/** The `max_bytes` member of a Codex `[history]` table. */
const historyMaxBytes = (text: string): unknown => {
  const document = parseClientConfiguration(text, "toml").document;
  return (document.history as Record<string, unknown>).max_bytes;
};

/** Re-parse an edit and report whether it still holds every parsed value. */
const editHoldsValues = (original: string, edited: string): boolean =>
  clientConfigurationValuesEqual(
    parseClientConfiguration(edited, "toml").document,
    parseClientConfiguration(original, "toml").document,
  );

describe("TOML integer precision", () => {
  it.each([
    ["zero", "0"],
    ["small", "1048576"],
    ["negative", "-1"],
    ["safe maximum", "9007199254740991"],
  ])("keeps the %s value a number", (_label, literal) => {
    expect(historyMaxBytes(`[history]\nmax_bytes = ${literal}\n`)).toBe(
      Number(literal),
    );
  });

  it.each([
    ["safe maximum plus two", "9007199254740993"],
    ["signed 64-bit maximum", "9223372036854775807"],
    ["signed 64-bit minimum", "-9223372036854775808"],
  ])("keeps the %s exact", (_label, literal) => {
    expect(historyMaxBytes(`[history]\nmax_bytes = ${literal}\n`)).toBe(
      BigInt(literal),
    );
  });

  it.each([
    ["above the maximum", "9223372036854775808"],
    ["below the minimum", "-9223372036854775809"],
    ["hexadecimal above the maximum", "0x8000000000000000"],
  ])("still rejects an integer %s", (_label, literal) => {
    expect(() =>
      parseClientConfiguration(`[history]\nmax_bytes = ${literal}\n`, "toml"),
    ).toThrow(/signed 64-bit TOML range/u);
  });

  it("keeps exact integers inside arrays and nested tables", () => {
    const document = parseClientConfiguration(
      "limits = [9223372036854775807, 1]\n[history]\nwindow = { max_bytes = 9223372036854775806 }\n",
      "toml",
    ).document;
    expect(document.limits).toEqual([9223372036854775807n, 1]);
    expect(document.history).toEqual({
      window: { max_bytes: 9223372036854775806n },
    });
  });

  it("rewrites an unchanged document without altering its exact integer", () => {
    const original = "[history]\nmax_bytes = 9223372036854775807\n";
    const parsed = parseClientConfiguration(original, "toml");
    const edited = serializeClientConfiguration(
      parsed.document,
      "toml",
      original,
    );
    expect(edited).toContain("max_bytes = 9223372036854775807");
    expect(editHoldsValues(original, edited)).toBe(true);
  });

  it("keeps an exact integer in an entry reinserted into an inline server table", () => {
    const original =
      'mcp_servers = { rea = { command = "node", PORT = 9223372036854775807 } }\n';
    const parsed = parseClientConfiguration(original, "toml");
    const edited = serializeClientConfiguration(
      parsed.document,
      "toml",
      original,
    );
    expect(edited).toContain("PORT = 9223372036854775807");
    expect(editHoldsValues(original, edited)).toBe(true);
  });
});
