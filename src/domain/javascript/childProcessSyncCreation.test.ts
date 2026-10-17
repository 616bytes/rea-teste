import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

describe("synchronous child-process creation", () => {
  it("recovers execSync, spawnSync and execFileSync candidates", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { execSync, spawnSync, execFileSync } from "node:child_process";
      import * as cp from "child_process";

      execSync("ps -p 1 -o command=", { env: { A: "1" } });
      spawnSync("gh", ["auth", "token"], { stdio: "pipe" });
      execFileSync("tool", ["--version"]);
      cp.execSync("id");
    `);

    expect(
      ir.childProcessSpawns.map(
        ({ method, command, argvCount, environmentSupplied, stdioMode }) => ({
          method,
          command,
          argvCount,
          environmentSupplied,
          stdioMode,
        }),
      ),
    ).toEqual([
      {
        method: "execSync",
        command: "ps -p 1 -o command=",
        argvCount: null,
        environmentSupplied: true,
        stdioMode: "default",
      },
      {
        method: "spawnSync",
        command: "gh",
        argvCount: 2,
        environmentSupplied: false,
        stdioMode: "pipe",
      },
      {
        method: "execFileSync",
        command: "tool",
        argvCount: 1,
        environmentSupplied: false,
        stdioMode: "default",
      },
      {
        method: "execSync",
        command: "id",
        argvCount: null,
        environmentSupplied: false,
        stdioMode: "default",
      },
    ]);
  });

  it("does not link listeners to synchronous results", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { execSync, spawnSync } from "node:child_process";

      const output = execSync("id");
      output.on("exit", () => {});
      const result = spawnSync("tool");
      result.on("error", () => {});
    `);

    expect(ir.childProcessSpawns.map(({ method }) => method)).toEqual([
      "execSync",
      "spawnSync",
    ]);
    expect(ir.childProcessInteractions).toEqual([]);
  });
});
