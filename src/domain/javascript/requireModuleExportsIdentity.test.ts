import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

describe("Node Module constructor delegate identity", () => {
  it.each([
    [
      "public constructor",
      'const M=require("module");M.prototype.require=other;',
    ],
    [
      "prefixed public constructor",
      'const M=require("node:module");M.prototype.require=other;',
    ],
    [
      "named export",
      'const {Module:M}=require("module");M.prototype.require=other;',
    ],
    [
      "nested self export",
      'const M=require("node:module").Module.Module;M.prototype.require=other;',
    ],
    ["inline constructor", 'require("module").prototype.require=other;'],
    [
      "stored constructor",
      'const box={};box.M=require("module");box.M.prototype.require=other;',
    ],
    [
      "copied prototype",
      'const M=require("module");const box={proto:M.prototype};const copy={...box};Reflect.set(copy.proto,"require",other);',
    ],
    [
      "default import",
      'import M from "node:module";M.prototype.require=other;',
    ],
    [
      "named import",
      'import {Module as M} from "module";M.prototype.require=other;',
    ],
    [
      "namespace default",
      'import * as M from "node:module";M.default.prototype.require=other;',
    ],
    [
      "namespace named export",
      'import * as M from "module";M.Module.prototype.require=other;',
    ],
    [
      "shim-loaded constructor",
      'const M=Q("module");M.prototype.require=other;',
    ],
    [
      "constructor cycle",
      'const M=require("module");M.prototype.constructor.prototype.require=other;',
    ],
    [
      "captured constructor",
      'let M=require("module");const saved=M;M=class Other{};saved.prototype.require=other;',
    ],
    [
      "unknown constructor selection",
      'const M=require("module");M[key].require=other;',
    ],
    [
      "unknown self export",
      'const M=require("module");M[key].prototype.require=other;',
    ],
    [
      "unknown namespace export",
      'import * as M from "module";M[key].prototype.require=other;',
    ],
  ])("rejects redirected loads through %s", (_name, setup) => {
    for (const loader of ["require", "Q"]) {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
    }
  });
});

describe("Node Module constructor isolation", () => {
  it.each([
    [
      "unrelated package",
      'const M=require("other");M.prototype.require=other;',
    ],
    [
      "unrelated export",
      'const M=require("module").Other;M.prototype.require=other;',
    ],
    ["constructor property", 'const M=require("module");M.require=other;'],
    [
      "unrelated prototype property",
      'const M=require("module");M.prototype.unrelated=other;',
    ],
    [
      "replaced constructor binding",
      'let M=require("module");M=class Other{};M.prototype.require=other;',
    ],
    [
      "captured unrelated constructor",
      'let M=class Other{};const saved=M;M=require("module");saved.prototype.require=other;',
    ],
    [
      "shadowed module loader",
      'function change(require){const M=require("module");M.prototype.require=other;}',
    ],
    [
      "Object constructor beyond the Module prototype",
      "module.__proto__.__proto__.constructor._load=other;",
    ],
  ])("preserves loads beside %s", (_name, setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains a load before the exported prototype is changed", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}const M=require("module");new (Q("electron").BrowserWindow)({});M.prototype.require=other;`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });
});

it.each([
  'const M=require("module");M._load=other;',
  "module.constructor._load=other;",
  'const M=require("module");Object.assign(M,{_load:other});',
  'const M=require("module");M.prototype.constructor._load=other;',
  "Object.getPrototypeOf(module).constructor._load=other;",
  'const M=require("module");Object.assign(M.prototype.constructor,{_load:other});',
])("rejects a replaced constructor loader: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it("preserves earlier loads and unrelated constructor assignments", () => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}const M=require("module");Object.assign(M,{unrelated:other});new (Q("electron").BrowserWindow)({});M._load=other;`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});
