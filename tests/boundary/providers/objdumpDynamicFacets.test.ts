import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { expect, it } from "vitest";

import { createReverseEngineeringService } from "../../../src/composition/reverseEngineering.js";

const hasObjdump = (() => {
  try {
    execFileSync("objdump", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// A stripped, dynamically linked system executable.
const strippedElf = "/bin/true";

it.skipIf(
  process.platform !== "linux" || !hasObjdump || !existsSync(strippedElf),
)(
  "reports needed libraries and imports of a stripped executable with real objdump",
  async () => {
    const service = createReverseEngineeringService(process.env);
    const outputOf = async (operation: string) => {
      const result = await service.inspectWithObjdump({
        path: strippedElf,
        operation,
      });
      if (!result.ok) throw result.error;
      return JSON.stringify(result.value);
    };
    expect(await outputOf("private_headers")).toMatch(/NEEDED\s+libc\.so/u);
    expect(await outputOf("dynamic_symbols")).toMatch(/DYNAMIC SYMBOL TABLE/u);
    expect(await outputOf("dynamic_relocations")).toMatch(
      /DYNAMIC RELOCATION RECORDS/u,
    );
  },
);
