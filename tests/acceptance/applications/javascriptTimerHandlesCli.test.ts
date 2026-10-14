import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";

const execute = promisify(execFile);

it.each([
  {
    name: "overwritten handle and stable control",
    source: `function work() {}
let handle = setTimeout(work, 100);
handle = null;
clearTimeout(handle);
const stable = setTimeout(work, 100);
clearTimeout(stable);
`,
    links: [{ resolution: "resolved", from: 6, to: 5 }],
    unknownLines: [4],
  },
  {
    name: "replacement timers, later writes and callable uncertainty",
    source: `function work() {}
let handle = setTimeout(work, 100);
clearTimeout(handle);
handle = setInterval(work, 200);
clearInterval(handle);
handle = null;
clearTimeout(handle);
let uncertain = setTimeout(work, 300);
function replace() { uncertain = null; }
replace();
clearTimeout(uncertain);
`,
    links: [
      { resolution: "resolved", from: 3, to: 2 },
      { resolution: "resolved", from: 5, to: 4 },
      { resolution: "candidate", from: 11, to: 8 },
    ],
    unknownLines: [7, 11],
  },
])(
  "preserves timer handle evidence through CLI and MCP: $name",
  async ({ source, links, unknownLines }) => {
    const root = await createTestTempDirectory("rea-timer-handles-");
    const app = join(root, "app");
    const configHome = join(root, "config");
    await Promise.all([mkdir(app), mkdir(configHome)]);
    await writeFile(
      join(app, "main.mjs"),
      `${source}throw new Error("analysis must not execute this fixture");\n`,
    );
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "analyze-javascript-application",
        app,
        "--format",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: configHome },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const evidence = parseEvidence(JSON.parse(stdout));
    const { semantic_graph: graph } =
      javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      );
    const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
    expect(
      graph.relations
        .filter(({ relation }) => relation === "cancels-timer")
        .map((relation) => ({
          resolution: relation.resolution,
          from: nodes.get(relation.source_node_id)?.identity.source_range?.start
            .line,
          to: nodes.get(relation.target_node_id)?.identity.source_range?.start
            .line,
        }))
        .sort((left, right) => (left.from ?? 0) - (right.from ?? 0)),
    ).toEqual(links);
    expect(
      graph.unknowns
        .filter(({ family }) => family === "timer")
        .map(({ node_id }) =>
          node_id === null
            ? null
            : nodes.get(node_id)?.identity.source_range?.start.line,
        )
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual(unknownLines);

    const { client, call } = await connectLocalToolsMcp({ HOME: configHome });
    const response = await call("analyze_javascript_application", {
      input_path: app,
      format: "auto",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(evidence);
    await client.ping();
  },
  60000,
);
