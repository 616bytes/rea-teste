import { Cli } from "incur";
import { describe, expect, it } from "vitest";
import { registerWebSourceLocationCommands } from "../../../src/cli/webSourceLocationCommands.js";
import { registerWebModuleCommands } from "../../../src/cli/webModuleCommands.js";
import { silentLogger } from "../../../src/logger.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import type { WebSourceLocationService } from "../../../src/application/WebSourceLocationService.js";
import type { WebModuleTraceService } from "../../../src/application/WebModuleTraceService.js";

const runSourceLocationCli = async (
  mockService: WebSourceLocationService,
  line = "1",
) => {
  const cli = Cli.create("test-cli", { sync: false });
  registerWebSourceLocationCommands(cli, silentLogger, {}, mockService);
  let stdout = "";
  await cli.serve(
    [
      "trace-web-source-location",
      "/manifest.json",
      "0",
      "/app.js.map",
      "https://app.test/app.js.map",
      line,
      "0",
      "--format",
      "json",
    ],
    {
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );
  return JSON.parse(stdout);
};

const runModuleTraceCli = async (
  mockService: WebModuleTraceService,
  scriptIndex = "0",
) => {
  const cli = Cli.create("test-cli", { sync: false });
  registerWebModuleCommands(cli, silentLogger, {}, mockService);
  let stdout = "";
  await cli.serve(
    [
      "trace-web-module-imports",
      "/manifest.json",
      scriptIndex,
      "--format",
      "json",
    ],
    {
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );
  return JSON.parse(stdout);
};

describe("trace-web-source-location cleanup error algebra", () => {
  it("preserves successful evidence while projecting cleanup failure when close rejects", async () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Source Location", version: "1" },
      {
        operation: "trace_web_source_location",
        parameters: {},
        result: { file: "test.ts", line: 10, column: 5 },
        confidence: "observed",
      },
    );
    const cleanupError = new ProviderCleanupError(
      "web-source-location",
      ["/retained/source.map"],
      { reason: "Map file handle locked by external process" },
      {
        message: "Web source-location cleanup failed",
        operation: "trace_web_source_location",
      },
    );
    const mockService = {
      trace: async () => ok(evidence),
      close: async () => {
        throw cleanupError;
      },
    } as unknown as WebSourceLocationService;

    const output = await runSourceLocationCli(mockService);
    expect(output).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: ["/retained/source.map"],
      },
    });
    expect(output.details.partial_observation).toBeDefined();
  });

  it("preserves primary analysis error alongside cleanup failure when both fail", async () => {
    const primaryError = new AnalysisInputError("trace_web_source_location", {
      userMessage: "Generated line 999 exceeds script bounds",
    });
    const cleanupError = new ProviderCleanupError(
      "web-source-location",
      ["/retained/source.map"],
      { reason: "File handle lock" },
      {
        message: "Web source-location cleanup failed",
        operation: "trace_web_source_location",
      },
    );
    const mockService = {
      trace: async () => err(primaryError),
      close: async () => {
        throw cleanupError;
      },
    } as unknown as WebSourceLocationService;

    const output = await runSourceLocationCli(mockService, "999");
    expect(output.message).toBe("Generated line 999 exceeds script bounds");
    expect(output.details.diagnostics.primary_error.code).toBe(
      "invalid_request",
    );
    expect(output.details).toMatchObject({
      cleanup: "incomplete",
      resources: ["/retained/source.map"],
    });
  });
});

describe("trace-web-module-imports cleanup error algebra", () => {
  it("preserves successful evidence while projecting cleanup failure when close rejects", async () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Module Trace", version: "1" },
      {
        operation: "trace_web_module_imports",
        parameters: {},
        result: { imports: [] },
        confidence: "observed",
      },
    );
    const cleanupError = new ProviderCleanupError(
      "web-module-trace",
      ["chromium-session-proc-999"],
      { reason: "Headless browser failed to terminate" },
      {
        message: "Web module trace cleanup failed",
        operation: "trace_web_module_imports",
      },
    );
    const mockService = {
      trace: async () => ok(evidence),
      close: async () => {
        throw cleanupError;
      },
    } as unknown as WebModuleTraceService;

    const output = await runModuleTraceCli(mockService);
    expect(output).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: ["chromium-session-proc-999"],
      },
    });
    expect(output.details.partial_observation).toBeDefined();
  });

  it("preserves primary analysis error alongside cleanup failure when both fail", async () => {
    const primaryError = new AnalysisInputError("trace_web_module_imports", {
      userMessage: "Selected script index 42 out of range",
    });
    const cleanupError = new ProviderCleanupError(
      "web-module-trace",
      ["chromium-session-proc-999"],
      { reason: "Browser orphan" },
      {
        message: "Web module trace cleanup failed",
        operation: "trace_web_module_imports",
      },
    );
    const mockService = {
      trace: async () => err(primaryError),
      close: async () => {
        throw cleanupError;
      },
    } as unknown as WebModuleTraceService;

    const output = await runModuleTraceCli(mockService, "42");
    expect(output.message).toBe("Selected script index 42 out of range");
    expect(output.details.diagnostics.primary_error.code).toBe(
      "invalid_request",
    );
    expect(output.details).toMatchObject({
      cleanup: "incomplete",
      resources: ["chromium-session-proc-999"],
    });
  });
});
