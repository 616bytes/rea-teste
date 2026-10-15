import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// A 256 MiB parent heap leaves a result budget that the large file's static
// checkpoint exhausts, so the next file's checkpoint stops the analysis.
cliTest.skipIf(process.versions.bun !== undefined)(
  "explains parent budget exhaustion after a static checkpoint",
  { timeout: 120_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-static-budget-");
    const source = Array.from(
      { length: 30_000 },
      (_, index) =>
        `import x${String(index)} from "./m${String(index % 50)}.js"; export const s${String(index)} = "literal-${String(index)}-" + x${String(index)}; fetch("/api/e${String(index)}");`,
    ).join("\n");
    await writeFile(join(root, "a-large.mjs"), source);
    await writeFile(join(root, "z-tiny.mjs"), "export const tiny = 1;\n");
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
      environment: {
        NODE_OPTIONS: "--max-old-space-size=256 --max-semi-space-size=8",
      },
      timeoutMs: 100_000,
    });
    expect(response.exitCode).toBe(1);
    const failure = z
      .object({
        code: z.literal("resource_constraint"),
        message: z.string(),
        remediation: z.object({ action: z.string() }),
        details: z.object({
          reported_limits: z.object({
            parent_result_budget_exhausted: z.literal(true),
          }),
        }),
      })
      .parse(response.json);
    expect(failure.message).toContain(
      "exhausted after retaining static facts for z-tiny.mjs",
    );
    expect(failure.remediation.action).toContain("parent result budget");
    expect(failure.remediation.action).toContain(
      "increasing the worker heap alone does not increase it",
    );
    expect(response.stderr).not.toMatch(/FATAL ERROR:.*heap/iu);
  },
);
