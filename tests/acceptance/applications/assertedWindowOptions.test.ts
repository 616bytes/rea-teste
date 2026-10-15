import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "asserted window objects retain preferences and conservative preload links",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-asserted-window-");
    const app = join(home, "app");
    await mkdir(app);
    const preload = join(app, "preload.cjs");
    const literal = JSON.stringify(preload);
    await writeFile(preload, "// Inert preload fixture.\n");
    const options = [
      `({ webPreferences: { preload: ${literal}, sandbox: true } } as const)`,
      `{ webPreferences: ({ preload: ${literal}, sandbox: true } as const) }`,
      `{ webPreferences: { preload: ${literal} as const, sandbox: true } }`,
      "{ webPreferences: getOptions() }",
      `{ webPreferences: ({ preload: ${literal}, ...getOptions() } as const) }`,
      `{ webPreferences: ({ preload: ${literal}, [getKey()]: true } as const) }`,
    ];
    await writeFile(
      join(app, "main.ts"),
      [
        'import { BrowserWindow } from "electron";',
        ...options.map((value) => `new BrowserWindow(${value});`),
      ].join("\n"),
    );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        app,
        "--json",
        "--full-output",
      ],
      environment: { HOME: home, USERPROFILE: home },
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const envelope = response.json as {
      ok?: boolean;
      data?: { normalized_result?: unknown };
    };
    expect(envelope.ok).toBe(true);
    const analysis = javascriptApplicationAnalysisResultSchema.parse(
      envelope.data?.normalized_result,
    );
    expect(analysis.statistics.parse_failures).toBe(0);
    expect(analysis.summary).toMatchObject({
      browser_windows: 6,
      preload_entrypoints: 3,
    });
    const windows = analysis.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(6);
    const linked = windows.filter(({ node_id }) =>
      analysis.graph.edges.some(
        (edge) => edge.source_node_id === node_id && edge.relation === "loads",
      ),
    );
    expect(linked).toHaveLength(3);
    expect(
      linked
        .map((window) => {
          const location = window.observations[0]?.evidence.location;
          if (!location?.available || location.value.kind !== "source-range")
            throw new Error("Missing window source range");
          return location.value.start.line;
        })
        .sort(),
    ).toEqual([2, 3, 4]);
    for (const window of windows.filter((window) => !linked.includes(window)))
      expect(window.observations[0]?.properties.preload_path).toBeNull();
    for (const window of linked) {
      expect(window.observations[0]?.properties).toMatchObject({
        options_status: "object-literal",
        web_preferences_status: "object-literal",
        preload_path: preload,
      });
    }
  },
);
