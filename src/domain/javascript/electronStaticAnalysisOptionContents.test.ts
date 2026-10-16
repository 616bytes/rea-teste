import { describe, expect, it } from "vitest";
import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const contentCases = (["options", "preferences"] as const).flatMap((owner) =>
  ["", ", ...null", ", ...undefined"].map((spread) => ({ owner, spread })),
);

it.each([
  "declare const arguments: any;",
  "declare let arguments: any;",
  "declare var arguments: any;",
  "declare class arguments {}",
  "declare namespace ambient { const arguments: any; }",
  'import type {T} from "unloaded-type-only";',
  'export type {T} from "unloaded-type-only";',
])(
  "does not treat erased declarations as runtime arguments shadows: %s",
  (declaration) => {
    const source = `
      const {BrowserWindow} = require("electron");
      ${declaration}
      const options = {webPreferences: {preload: "./safe.js"}, ...null};
      exports = options;
      arguments[0].webPreferences.preload = "./changed.js";
      new BrowserWindow(options);
    `;
    const parsed = parseJavaScriptSource(source, "fixture.cts");
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.errors ?? []).toEqual([]);
    const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
    expect(
      analysis.electron.browser_windows[0]?.resolution_sources,
    ).toBeUndefined();
  },
);

it.each(["fixture.cts", "fixture.mts"])(
  "uses runtime module mode for mapped contents in %s",
  (path) => {
    const source = `
    import type {T} from "unloaded-type-only";
    const {BrowserWindow} = require("electron");
    function open(parameter) {
      const options = {webPreferences: {preload: "./safe.js"}, ...null};
      parameter = options;
      arguments[0].webPreferences.preload = "./changed.js";
      new BrowserWindow(options);
    }
  `;
    const parsed = parseJavaScriptSource(source, path);
    if (parsed === null) throw new Error("Expected parsed source");
    expect(parsed.program.sourceType).toBe("module");
    expect(parsed.errors ?? []).toEqual([]);
    const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
      path.endsWith(".mts") ? "./safe.js" : null,
    );
  },
);

it.each(["export const", "const"])(
  "keeps transformed namespace scope uncertain during recovery (%s)",
  (declaration) => {
    const source = `
    namespace Own { ${declaration} arguments = []; }
    const {BrowserWindow} = require("electron");
    const options = {webPreferences: {preload: "./safe.js"}, ...null};
    exports = options;
    arguments[0].webPreferences.preload = "./changed.js";
    new BrowserWindow(options);
  `;
    const parsed = parseJavaScriptSource(source, "fixture.cts");
    if (parsed === null) throw new Error("Expected recovered source");
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(
      analyzeParsedJavaScriptStaticSource(source, parsed).electron
        .browser_windows[0]?.preload_path,
    ).toBeNull();
  },
);

it.each([
  "const arguments = [];",
  "let arguments = [];",
  "function arguments() {}",
])("retains actual runtime arguments shadows: %s", (declaration) => {
  const source = `
    const {BrowserWindow} = require("electron");
    ${declaration}
    const options = {webPreferences: {preload: "./safe.js"}, ...null};
    exports = options;
    void arguments;
    new BrowserWindow(options);
  `;
  const parsed = parseJavaScriptSource(source, "fixture.cjs");
  if (parsed === null) throw new Error("Expected parsed source");
  expect(parsed.errors ?? []).toEqual([]);
  const analysis = analyzeParsedJavaScriptStaticSource(source, parsed);
  expect(analysis.electron.browser_windows[0]?.preload_path).toBe("./safe.js");
});

describe("Electron option contents exposed to dynamic code", () => {
  it.each(contentCases)(
    "keeps $owner contents unknown after eval with spread $spread",
    ({ owner, spread }) => {
      const options = owner === "options";
      const analysis = analyzeJavaScriptStaticSource(`
          const { BrowserWindow } = require("electron");
          function open() {
            const ${owner} = ${options ? `{webPreferences: {preload: "./safe.js"}${spread}}` : `{preload: "./safe.js"${spread}}`};
            eval('${owner}${options ? ".webPreferences" : ""}.preload = "./changed.js"');
            new BrowserWindow(${options ? owner : "{webPreferences: preferences}"});
          }
        `);
      expect(analysis.electron.browser_windows).toHaveLength(1);
      expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
      expect(
        analysis.electron.browser_windows[0]?.resolution_sources,
      ).toBeUndefined();
    },
  );

  it.each(contentCases)(
    "preserves stable $owner contents and provenance with spread $spread",
    ({ owner, spread }) => {
      const options = owner === "options";
      const analysis = analyzeJavaScriptStaticSource(`
          const { BrowserWindow } = require("electron");
          function open() {
            const ${owner} = ${options ? `{webPreferences: {preload: "./safe.js"}${spread}}` : `{preload: "./safe.js"${spread}}`};
            new BrowserWindow(${options ? owner : "{webPreferences: preferences}"});
          }
        `);
      expect(analysis.electron.browser_windows).toHaveLength(1);
      expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
        "./safe.js",
      );
      expect(
        analysis.electron.browser_windows[0]?.resolution_sources,
      ).toHaveLength(1);
    },
  );

  it("retains fresh inline options despite an unrelated eval reference", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      function open() {
        eval("void 0");
        new BrowserWindow({webPreferences: {preload: "./safe.js", ...null}, ...null});
      }
    `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
      "./safe.js",
    );
    expect(
      analysis.electron.browser_windows[0]?.resolution_sources,
    ).toBeUndefined();
  });
});

it.each(contentCases)(
  "keeps mapped-argument writes to $owner contents unknown with spread $spread",
  ({ owner, spread }) => {
    const options = owner === "options";
    const analysis = analyzeJavaScriptStaticSource(`
      const {BrowserWindow} = require("electron");
      function open(parameter) {
        const ${owner} = ${options ? `{webPreferences: {preload: "./safe.js"}${spread}}` : `{preload: "./safe.js"${spread}}`};
        parameter = ${owner};
        arguments[0]${options ? ".webPreferences" : ""}.preload = "./changed.js";
        new BrowserWindow(${options ? owner : "{webPreferences: preferences}"});
      }
    `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
    expect(
      analysis.electron.browser_windows[0]?.resolution_sources,
    ).toBeUndefined();
  },
);

it.each(contentCases)(
  "retains strict arguments isolation for $owner with spread $spread",
  ({ owner, spread }) => {
    const options = owner === "options";
    const analysis = analyzeJavaScriptStaticSource(`
      const {BrowserWindow} = require("electron");
      function open(parameter) {
        "use strict";
        const ${owner} = ${options ? `{webPreferences: {preload: "./safe.js"}${spread}}` : `{preload: "./safe.js"${spread}}`};
        parameter = ${owner};
        arguments[0]${options ? ".webPreferences" : ""}.preload = "./changed.js";
        new BrowserWindow(${options ? owner : "{webPreferences: preferences}"});
      }
    `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
      "./safe.js",
    );
    expect(
      analysis.electron.browser_windows[0]?.resolution_sources,
    ).toHaveLength(1);
  },
);

it("keeps unproved mapped argument reachability source-wide for contents", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const {BrowserWindow} = require("electron");
    function unrelated(value) { return arguments[0]; }
    function open() {
      const options = {webPreferences: {preload: "./safe.js"}, ...null};
      new BrowserWindow(options);
    }
  `);
  expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
  expect(
    analysis.electron.browser_windows[0]?.resolution_sources,
  ).toBeUndefined();
});

it.each([
  'const box = {options}; function mutate(parameter) { parameter = box.options; arguments[0].webPreferences.preload = "./changed.js"; } mutate(0);',
  'function mutate(parameter) { with ({}) { parameter = options; arguments[0].webPreferences.preload = "./changed.js"; } } mutate(0);',
  'exports = options; arguments[0].webPreferences.preload = "./changed.js";',
  'var arguments; exports = options; arguments[0].webPreferences.preload = "./changed.js";',
])(
  "does not prove contents across opaque argument reachability: %s",
  (mutation) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const {BrowserWindow} = require("electron");
    const options = {webPreferences: {preload: "./safe.js"}, ...null};
    ${mutation}
    new BrowserWindow(options);
  `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
  },
);

it.each([
  "function open(parameter = {})",
  "function open(...parameters)",
  "function open(arguments)",
  "const open = (arguments) =>",
])(
  "retains stable contents with unmapped or shadowed arguments: %s",
  (declaration) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const {BrowserWindow} = require("electron");
    ${declaration} {
      const options = {webPreferences: {preload: "./safe.js"}, ...null};
      void arguments;
      new BrowserWindow(options);
    }
  `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
      "./safe.js",
    );
  },
);

it.each([
  '"use strict"; const {BrowserWindow} = require("electron");',
  'import {BrowserWindow} from "electron";',
])(
  "retains stable contents in strict program/module contexts: %s",
  (header) => {
    const analysis = analyzeJavaScriptStaticSource(`
    ${header}
    function open(parameter) {
      const options = {webPreferences: {preload: "./safe.js"}, ...null};
      parameter = options;
      arguments[0].webPreferences.preload = "./changed.js";
      new BrowserWindow(options);
    }
  `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBe(
      "./safe.js",
    );
  },
);
