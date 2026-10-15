import { describe, expect, it } from "vitest";
import { closeOwnedWebResources } from "./closeOwnedWebResources.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

describe("closeOwnedWebResources", () => {
  it("resolves cleanly when all cleanup owners succeed or are undefined", async () => {
    let closedA = false;
    let closedB = false;
    await closeOwnedWebResources(
      [
        async () => {
          closedA = true;
        },
        undefined,
        async () => {
          closedB = true;
        },
      ],
      "Cleanup failed",
    );
    expect(closedA).toBe(true);
    expect(closedB).toBe(true);
  });

  it("throws tagged ProviderCleanupError when a cleanup owner rejects", async () => {
    const error = await closeOwnedWebResources(
      [
        async () => {
          throw new Error("Disk locked");
        },
      ],
      "Web source-location cleanup failed",
      {
        providerId: "web-source-location",
        operation: "trace_web_source_location",
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderCleanupError);
    expect(error).toBeInstanceOf(AnalysisError);
    if (!(error instanceof ProviderCleanupError))
      throw new Error("Expected ProviderCleanupError");

    expect(error.message).toBe("Web source-location cleanup failed");
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toContain("web-resource");
    expect(error.diagnostics?.reason).toContain("Disk locked");
    expect(error.providerId).toBe("web-source-location");
    expect(error.operation).toBe("trace_web_source_location");
  });

  it("extracts resources from ArtifactReaderFailure and AnalysisError", async () => {
    const artifactFailure = new ArtifactReaderFailure(
      "unavailable",
      "Source artifact read lock",
      {
        cleanup: {
          reason: "Failed to release source file handle",
          resources: ["/path/to/source.js"],
        },
      },
    );

    const error = await closeOwnedWebResources(
      [
        async () => {
          throw artifactFailure;
        },
      ],
      "Web module trace cleanup failed",
      {
        providerId: "web-module-trace",
        operation: "trace_web_module_imports",
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderCleanupError);
    if (!(error instanceof ProviderCleanupError))
      throw new Error("Expected ProviderCleanupError");

    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toEqual(["/path/to/source.js"]);
    expect(error.diagnostics?.reason).toBe(
      "Failed to release source file handle",
    );
  });

  it("aggregates multiple failures into a single ProviderCleanupError retaining all resources and an AggregateError cause", async () => {
    const failure1 = new ArtifactReaderFailure("unavailable", "Artifact lock", {
      cleanup: {
        reason: "Artifact cleanup incomplete",
        resources: ["/path/to/manifest.json"],
      },
    });
    const failure2 = new ProviderCleanupError(
      "resolver",
      ["chromium-instance-1234"],
      { reason: "Browser process did not terminate" },
      { operation: "trace_web_module_imports" },
    );

    const error = await closeOwnedWebResources(
      [
        async () => {
          throw failure1;
        },
        async () => {
          throw failure2;
        },
      ],
      "Web module trace cleanup failed",
      {
        providerId: "web-module-trace",
        operation: "trace_web_module_imports",
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderCleanupError);
    if (!(error instanceof ProviderCleanupError))
      throw new Error("Expected ProviderCleanupError");

    expect(error.message).toBe("Web module trace cleanup failed");
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toEqual([
      "/path/to/manifest.json",
      "chromium-instance-1234",
    ]);
    expect(error.cause).toBeInstanceOf(AggregateError);
  });
});
