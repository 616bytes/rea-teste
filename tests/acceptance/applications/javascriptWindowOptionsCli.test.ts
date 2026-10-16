import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

const runtimeShadowFixtures = {
  ...Object.fromEntries(
    [
      ["const", "declare const arguments: any;"],
      ["let", "declare let arguments: any;"],
      ["import", 'import type {T} from "unloaded-type-only";'],
      ["export", 'export type {T} from "unloaded-type-only";'],
    ].map(([name, declaration]) => [
      `ambient-${name}.cts`,
      [
        'throw new Error("Static input must never execute");',
        'const {BrowserWindow} = require("electron");',
        declaration!,
        'const options = {webPreferences: {preload: "./safe.js"}, ...null};',
        "exports = options;",
        'arguments[0].webPreferences.preload = "./changed.js";',
        "new BrowserWindow(options);",
      ].join("\n"),
    ]),
  ),
  "module.mts": [
    'throw new Error("Static input must never execute");',
    'import type {T} from "unloaded-type-only";',
    'const {BrowserWindow} = require("electron");',
    "function open(parameter) {",
    'const options = {webPreferences: {preload: "./safe.js"}, ...null};',
    "parameter = options;",
    'arguments[0].webPreferences.preload = "./changed.js";',
    "new BrowserWindow(options);",
    "}",
  ].join("\n"),
  "shadow.cjs": [
    'throw new Error("Static input must never execute");',
    'const {BrowserWindow} = require("electron");',
    "const arguments = [];",
    'const options = {webPreferences: {preload: "./safe.js"}, ...null};',
    "exports = options;",
    "void arguments;",
    "new BrowserWindow(options);",
  ].join("\n"),
};

cliTest(
  "retains constant window preferences and inferred source provenance through CLI, MCP and fact views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-window-options-");
    await writeFixtureFiles(root, {
      "main.js": [
        'throw new Error("Static input must never execute");',
        'const { BrowserWindow } = require("electron");',
        "function open() {",
        '  const prefs = {nodeIntegration: true, contextIsolation: false, preload: "./preload.js"};',
        "  const options = {webPreferences: prefs, ...undefined};",
        '  if (linux) options.icon = "icon.png";',
        "  new BrowserWindow(options);",
        "  const escaped = {webPreferences: {sandbox: true}};",
        "  patch(escaped); new BrowserWindow(escaped);",
        "  new BrowserWindow({webPreferences: {sandbox: true}});",
        '  const deferred = {sandbox: false, preload: "./deferred.js"};',
        "  new BrowserWindow({webPreferences: deferred, ...undefined});",
        "}",
      ].join("\n"),
      "preload.js": "// Inert preload source",
      "deferred.js": "// Inert deferred preload source",
    });
    const cliResponse = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(cliResponse.exitCode, JSON.stringify(cliResponse.json)).toBe(0);
    const cliResult = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(cliResponse.json).normalized_result,
    );
    const { call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: root,
      format: "directory",
    });
    expect(response.isError).not.toBe(true);
    const parent = parseEvidence(response.structuredContent);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parent.normalized_result,
    );
    expect(result.graph).toEqual(cliResult.graph);
    expect(result.summary).toEqual(cliResult.summary);
    expect(result.summary).toMatchObject({
      browser_windows: 4,
      explicit_web_preferences: 6,
      preload_entrypoints: 2,
    });
    const windows = result.graph.nodes.filter(
      (node) => node.kind === "browser-window",
    );
    const resolved = windows.find((node) => {
      const sources = node.observations[0]?.properties.resolution_sources;
      return Array.isArray(sources) && sources.length === 2;
    });
    expect(resolved?.observations[0]).toMatchObject({
      properties: {
        source_path: "main.js",
        options_status: "object-literal",
        resolution_sources: [
          { source: "main.js", start: { line: 5 } },
          { source: "main.js", start: { line: 4 } },
        ],
      },
      evidence: {
        state: "inferred",
        authority: "static-relationship-inference",
        location: { value: { source: "main.js", start: { line: 7 } } },
      },
    });
    expect(
      windows.find((node) => {
        const sources = node.observations[0]?.properties.resolution_sources;
        return Array.isArray(sources) && sources.length === 1;
      })?.observations[0],
    ).toMatchObject({
      properties: {
        web_preferences_status: "object-literal",
        resolution_sources: [{ source: "main.js", start: { line: 11 } }],
      },
      evidence: { state: "inferred" },
    });
    expect(
      windows.filter(
        (node) =>
          node.observations[0]?.properties.web_preferences_status === "dynamic",
      ),
    ).toHaveLength(1);
    expect(
      windows.filter(
        (node) => node.observations[0]?.evidence.state === "observed",
      ),
    ).toHaveLength(2);
    const viewResponse = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: {
        kind: "javascript-facts",
        where: { paths: ["main.js"], kinds: ["browser-window"] },
        property_keys: ["web_preferences", "resolution_sources"],
      },
    });
    expect(viewResponse.isError).not.toBe(true);
    const view = analysisViewResultSchema.parse(
      parseEvidence(viewResponse.structuredContent).normalized_result,
    );
    if (view.kind !== "javascript-facts") throw new Error("Expected fact view");
    expect(view.rows).toHaveLength(4);
    const row = view.rows.find((row) => row.node_id === resolved?.node_id);
    expect(row?.evidence).toEqual(resolved?.observations[0]?.evidence);
    expect(row?.properties).toEqual({
      web_preferences: resolved?.observations[0]?.properties.web_preferences,
      resolution_sources:
        resolved?.observations[0]?.properties.resolution_sources,
    });
  },
);

cliTest(
  "keeps opaque constant preload contents unknown across CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-window-content-");
    await writeFixtureFiles(root, {
      "mutated.cjs": [
        'throw new Error("Static input must never execute");',
        'const {BrowserWindow} = require("electron");',
        "function open() {",
        '  const options = {webPreferences: {preload: "./safe.js"}, ...null};',
        '  eval("options.webPreferences.preload = changed");',
        "  new BrowserWindow(options);",
        '  const preferences = {preload: "./safe.js", ...null};',
        '  eval("preferences.preload = changed");',
        "  new BrowserWindow({webPreferences: preferences});",
        '  new BrowserWindow({webPreferences: {preload: "./safe.js", ...null}});',
        "}",
      ].join("\n"),
      "stable.cjs": [
        'throw new Error("Static input must never execute");',
        'const {BrowserWindow} = require("electron");',
        "function open() {",
        '  const options = {webPreferences: {preload: "./safe.js"}, ...null};',
        "  new BrowserWindow(options);",
        '  const preferences = {preload: "./other.js", ...undefined};',
        "  new BrowserWindow({webPreferences: preferences});",
        "}",
      ].join("\n"),
      "mapped.cjs": [
        'throw new Error("Static input must never execute");',
        'const {BrowserWindow} = require("electron");',
        "function open(parameter) {",
        '  const options = {webPreferences: {preload: "./safe.js"}, ...null};',
        "  parameter = options;",
        '  arguments[0].webPreferences.preload = "./changed.js";',
        "  new BrowserWindow(options);",
        '  const preferences = {preload: "./safe.js", ...null};',
        "  parameter = preferences;",
        '  arguments[0].preload = "./changed.js";',
        "  new BrowserWindow({webPreferences: preferences});",
        "}",
      ].join("\n"),
      "strict.cjs": [
        'throw new Error("Static input must never execute");',
        'const {BrowserWindow} = require("electron");',
        "function open(parameter) {",
        '  "use strict";',
        '  const options = {webPreferences: {preload: "./safe.js"}, ...null};',
        "  parameter = options;",
        '  arguments[0].webPreferences.preload = "./changed.js";',
        "  new BrowserWindow(options);",
        '  const preferences = {preload: "./other.js", ...undefined};',
        "  parameter = preferences;",
        '  arguments[0].preload = "./changed.js";',
        "  new BrowserWindow({webPreferences: preferences});",
        "}",
      ].join("\n"),
      "safe.js": "// Inert preload source",
      "other.js": "// Inert second preload source",
      ...runtimeShadowFixtures,
    });
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
    });
    expect(response.exitCode).toBe(0);
    const cliEvidence = parseEvidence(response.json);
    const { call } = await connectLocalToolsMcp();
    const mcp = await call("analyze_javascript_application", {
      input_path: root,
      format: "auto",
    });
    expect(mcp.isError).not.toBe(true);
    const mcpEvidence = parseEvidence(mcp.structuredContent);
    expect(mcpEvidence).toEqual(cliEvidence);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      mcpEvidence.normalized_result,
    );
    expect(result.summary).toMatchObject({
      browser_windows: 15,
      preload_entrypoints: 7,
    });
    const windows = result.graph.nodes.filter(
      (node) => node.kind === "browser-window",
    );
    for (const source of [
      "ambient-const.cts",
      "ambient-let.cts",
      "ambient-import.cts",
      "ambient-export.cts",
      "shadow.cjs",
    ]) {
      const window = windows.find(
        (node) => node.observations[0]?.properties.source_path === source,
      );
      expect(window?.observations[0]?.properties.preload_path).toBe(
        source === "shadow.cjs" ? "./safe.js" : null,
      );
    }
    const sourceLine = (node: (typeof windows)[number]): number => {
      const location = node.observations[0]?.evidence.location;
      if (!location?.available || location.value.kind !== "source-range")
        throw new Error("Expected window source range");
      return location.value.start.line;
    };
    windows.sort((left, right) => sourceLine(left) - sourceLine(right));
    const mutated = windows.filter(
      (node) => node.observations[0]?.properties.source_path === "mutated.cjs",
    );
    expect(
      mutated.map((node) => node.observations[0]?.properties.preload_path),
    ).toEqual([null, null, "./safe.js"]);
    const stable = windows.filter(
      (node) => node.observations[0]?.properties.source_path === "stable.cjs",
    );
    expect(
      stable.map((node) => node.observations[0]?.properties.preload_path),
    ).toEqual(["./safe.js", "./other.js"]);
    expect(
      stable.map((node) => node.observations[0]?.properties.resolution_sources),
    ).toEqual([[expect.any(Object)], [expect.any(Object)]]);
    const mapped = windows.filter(
      (node) => node.observations[0]?.properties.source_path === "mapped.cjs",
    );
    expect(
      mapped.map((node) => node.observations[0]?.properties.preload_path),
    ).toEqual([null, null]);
    const strict = windows.filter(
      (node) => node.observations[0]?.properties.source_path === "strict.cjs",
    );
    expect(
      strict.map((node) => node.observations[0]?.properties.preload_path),
    ).toEqual(["./safe.js", "./other.js"]);
    const associations = result.graph.edges.filter(
      (edge) =>
        edge.evidence.extractor.operation ===
        "associate-browser-window-preload",
    );
    expect(associations).toHaveLength(7);
    expect(
      associations.some((edge) =>
        windows
          .filter(
            (node) => node.observations[0]?.properties.preload_path === null,
          )
          .some((node) => node.node_id === edge.source_node_id),
      ),
    ).toBe(false);
  },
);
