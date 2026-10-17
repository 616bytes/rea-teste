import { describe, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  PlaywrightElectronActiveProvider,
  executableContainsApplication,
} from "../../../src/browser/PlaywrightElectronActiveProvider.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { err } from "../../../src/domain/result.js";

describe("PlaywrightElectronActiveProvider cleanup retry", () => {
  it("combines retry failure with outcome.error when primary capture fails", async () => {
    const scope = new ArtifactResourceScope();

    scope.retain({
      kind: "lease",
      resource: "/fake/app/package.json",
      lease: {
        release: async () => {
          throw new Error("EBUSY: resource locked");
        },
      },
    });

    const provider = new PlaywrightElectronActiveProvider(
      {},
      async () => {
        throw new Error("Process failed to launch!");
      },
      undefined,
      scope,
    );

    const result = await provider.capture({
      executable_path: "/nonexistent/electron",
      application_path: "/fake/app",
      application_root: "/fake/app",
      args: [],
      actions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected capture to fail");

    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.diagnostics).toBeDefined();
    expect(result.error.diagnostics?.primary_error).toBeDefined();
    expect(result.error.diagnostics?.cleanup_error).toBeDefined();
    expect(result.error.cleanupResources).toContain("/fake/app/package.json");
    expect(result.error.cause).toBeInstanceOf(AggregateError);

    const cleanupError = (result.error.cause as AggregateError).errors[1];
    cleanupError.resolveCleanup();
    expect(result.error.cleanupIncomplete).toBe(false);
  });

  it("finishAnalysisCommand combines close failure with primary result for CLI", async () => {
    const scope = new ArtifactResourceScope();
    scope.retain({
      kind: "lease",
      resource: "/fake/manifest.json",
      lease: {
        release: async () => {
          throw new Error("EBUSY: handle busy");
        },
      },
    });

    const failingService = {
      close: async () => {
        await scope.close();
      },
    };

    const finished = await finishAnalysisCommand(
      async () =>
        err(
          new ProviderAdapterError(
            "rea-playwright-electron-active",
            "capture_electron_scenario",
            {
              cause: new Error("Primary capture launch failed"),
            },
          ),
        ),
      failingService,
      "rea-playwright-electron-active",
      "capture_electron_scenario",
    );

    expect(finished).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        provider_id: "rea-playwright-electron-active",
        operation: "capture_electron_scenario",
        diagnostics: {
          primary_error: expect.objectContaining({
            code: "execution_failure",
          }),
          cleanup_error: expect.objectContaining({
            code: "cleanup_incomplete",
            details: expect.objectContaining({
              resources: ["/fake/manifest.json"],
            }),
          }),
        },
      },
    });
  });

  it("restricts package-less fallback detection to package-root default entrypoint", async () => {
    const root = "/opt/app";
    const executable = "/opt/app/my-app";

    // Direct root entry: recognized
    const isRootEntry = await executableContainsApplication(
      executable,
      "/opt/app/resources/app/index.js",
    );
    expect(isRootEntry).toBe(true);

    // Nested entry with recognized basename: not recognized as the default bundle entry
    const isNestedEntry = await executableContainsApplication(
      executable,
      "/opt/app/resources/app/plugins/index.js",
    );
    expect(isNestedEntry).toBe(false);
  });
});
