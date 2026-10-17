import { expect, it } from "vitest";

import { objdumpInputSchema } from "../../src/domain/reverseEngineering.js";
import { objdumpCommand } from "../../src/objdump/ObjdumpCommand.js";

// A stripped dynamic executable has no static symbol or relocation tables, so
// `symbols` and `relocations` report nothing. Its needed libraries and imports
// remain in the dynamic section, which only these facets read.
it("maps each dynamic facet to its GNU objdump option", () => {
  for (const [operation, option] of [
    ["private_headers", "-p"],
    ["dynamic_symbols", "-T"],
    ["dynamic_relocations", "-R"],
  ] as const) {
    const input = objdumpInputSchema.parse({ path: "/tmp/a.out", operation });
    expect(objdumpCommand(input)).toEqual([option, "/tmp/a.out"]);
  }
});
