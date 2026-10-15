import { z } from "zod";

import { isSwiftMangledSymbolName } from "../../domain/swiftSymbolClassification.js";

const resultSchema = z.object({
  input: z.string(),
  output: z.string(),
  status: z.enum(["demangled", "unchanged", "invalid"]),
});

export type DemangledSymbol = z.infer<typeof resultSchema>;

/**
 * swift-demangle removes one underscore from a name starting with `__` before
 * demangling, and prefixes `$` to an argument starting with S, s or e. A name
 * it cannot decode is printed in that adjusted spelling.
 */
const linkageName = (input: string): string =>
  input.startsWith("__") ? input.slice(1) : input;
const undecodedSpelling = (input: string): string =>
  /^[Sse]/u.test(input) ? `$${input}` : linkageName(input);

/**
 * Preserve input ordering while parsing `swift-demangle --compact` lines.
 * The demangler ends each record with LF, so a carriage return belongs to the
 * symbol text.
 */
export const parseDemangledSymbols = (
  inputs: readonly string[],
  output: string,
): DemangledSymbol[] => {
  if (inputs.length === 0) {
    if (output === "" || output === "\n") return [];
    throw new TypeError("swift-demangle emitted output for an empty input");
  }
  const lines = output.replace(/\n$/u, "").split("\n");
  if (lines.length !== inputs.length)
    throw new TypeError("swift-demangle output count does not match input");
  return inputs.map((input, index) => {
    const value = lines[index];
    if (value === undefined)
      throw new TypeError("swift-demangle omitted an output line");
    const decoded = value !== input && value !== undecodedSpelling(input);
    return resultSchema.parse({
      input,
      output: decoded ? value : input,
      status: decoded
        ? "demangled"
        : isSwiftMangledSymbolName(linkageName(input))
          ? "invalid"
          : "unchanged",
    });
  });
};
