import { resolve } from "node:path";

import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

// Windows reports a closed pipe reader through a different error path.
describe.skipIf(process.platform === "win32")(
  "CLI with a closed stdout",
  () => {
    cliTest.for([["toon"], ["json"]] as const)(
      "stops quietly with the SIGPIPE status when the reader closes ($0)",
      async ([format], { processes }) => {
        const child = processes.spawn(
          process.execPath,
          [resolve("scripts/rea.mjs"), "capabilities", "--format", format],
          { env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" } },
        );
        // Close the reader before the first write, as `rea ... | head -c 0` does.
        child.stdout.destroy();
        child.stdin.end();
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        const code = await new Promise<number | null>((done) =>
          child.once("close", done),
        );
        expect({ code, stderr }).toEqual({ code: 141, stderr: "" });
      },
    );
  },
);
