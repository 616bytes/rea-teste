import { Cli } from "incur";
import { afterEach, expect, it } from "vitest";
import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import type { JvmAnalysisPort } from "../../src/application/jvm/JvmAnalysisPort.js";
import { registerJvmCommands } from "../../src/cli/jvmCommands.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err, ok } from "../../src/domain/result.js";
import { silentLogger } from "../../src/logger.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

it.each([false, true])(
  "retains %s operation outcome when final CLI cleanup also fails",
  async (succeeded) => {
    const operation = "inspect_jvm_decompiler";
    const captured = {
      stdout: "",
      stderr: "invalid provider output",
      exit_code: 7,
      truncated: false,
    };
    const client = {
      command: "/tools/vineflower",
      command_source: "environment",
      version: "1.12.0",
    };
    const provider: JvmAnalysisPort = {
      async inspectAvailability() {
        return {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {},
        };
      },
      async execute() {
        return succeeded
          ? ok(
              createAnalysisExecution(
                { client },
                { id: "vineflower", name: "Vineflower", version: "1.12.0" },
              ),
            )
          : err(
              new AnalysisOutputError(operation, "primary failure", {
                capturedOutput: captured,
              }),
            );
      },
      async close() {
        throw new ProviderCleanupError(
          "vineflower",
          ["/owned/workspace"],
          { reason: "close failed" },
          { operation },
        );
      },
    };
    const cli = Cli.create("rea-jvm-lifecycle", { sync: false });
    registerJvmCommands(cli, silentLogger, {}, provider);
    let stdout = "";
    await cli.serve(["inspect-jvm-decompiler", "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    });
    const projected: unknown = JSON.parse(stdout);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["/owned/workspace"] },
    });
    if (succeeded)
      expect(projected).toMatchObject({
        details: {
          partial_observation: { operation, normalized_result: { client } },
        },
      });
    else
      expect(projected).toMatchObject({
        details: { captured_output: captured },
      });
  },
);
