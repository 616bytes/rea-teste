import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  LOADER_GETTER_REPLACEMENT as replacement,
  webpackGetterSource,
} from "../../../src/domain/javascript/electronBundledGetter.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves loader getter identity after alias writes through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-loader-getter-aliases-");
    const cases = [
      ["intact.cjs", ""],
      ["direct.cjs", `load.n = ${replacement};`],
      ["alias.cjs", `const alias = load; alias.n = ${replacement};`],
      [
        "reflective.cjs",
        `const alias = load; Reflect.set(alias, "n", ${replacement});`,
      ],
      [
        "captured.cjs",
        `let first = load; const alias = first; first = {}; alias.n = ${replacement};`,
      ],
      ["unrelated.cjs", "const alias = load; alias.d = 1;"],
      [
        "reassigned.cjs",
        `let alias = load; alias = {}; alias.n = ${replacement};`,
      ],
    ] as const;
    for (const [name, mutation] of cases)
      await writeFile(
        join(root, name),
        `${webpackGetterSource(mutation)}\nthrow new Error("source must remain inert");`,
      );

    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics).toMatchObject({
      parsed_javascript_files: cases.length,
      parse_failures: 0,
    });
    expect(result.summary.browser_windows).toBe(3);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(3);
    expect(
      windows
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties.source_path),
        )
        .sort(),
    ).toEqual(["intact.cjs", "reassigned.cjs", "unrelated.cjs"]);
    for (const [name] of cases)
      expect(
        result.graph.nodes.flatMap(({ observations }) => observations),
      ).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            reference_kind: "require",
            specifier: "electron",
          }),
          evidence: expect.objectContaining({
            location: {
              available: true,
              value: expect.objectContaining({ source: name }),
            },
          }),
        }),
      );
  },
);
