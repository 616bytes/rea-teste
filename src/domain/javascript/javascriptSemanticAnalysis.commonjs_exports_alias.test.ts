import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const exportedNames = (source: string): (string | null)[] =>
  analyzeJavaScriptSemantics(source)
    .moduleLinks.filter(({ kind }) => kind === "commonjs-export")
    .map(({ exportedName }) => exportedName);

describe("CommonJS exports alias lifetime across statements", () => {
  it.each([
    [
      "a module.exports object replacement",
      `module.exports = {};
       exports.parse = () => ({ kind: "result" });`,
      ["default"],
    ],
    [
      "a module.exports function replacement",
      `module.exports = function main() {};
       exports.status = "enabled";`,
      ["default"],
    ],
    [
      "an exports alias rebinding",
      `exports = {};
       exports.parse = () => ({ kind: "result" });`,
      [],
    ],
    [
      "a replacement followed by another fresh replacement",
      `module.exports = {};
       exports.parse = () => 1;
       module.exports = {};`,
      ["default", "default"],
    ],
    [
      "a replacement followed by a module.exports write",
      `module.exports = {};
       exports.parse = () => 1;
       module.exports.other = () => 2;`,
      ["default", "other"],
    ],
  ])(
    "does not export a write to the exports alias detached by %s",
    (_name, source, expected) => {
      expect(exportedNames(source)).toEqual(expected);
    },
  );

  it.each([
    ["an untouched exports alias", `exports.parse = () => 1;`, ["parse"]],
    [
      "a write before the replacement",
      `exports.parse = () => 1;
       module.exports = {};`,
      ["parse", "default"],
    ],
    [
      "a replacement that also rebinds exports",
      `module.exports = exports = {};
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "an exports alias reconnected to module.exports",
      `module.exports = {};
       exports = module.exports;
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "a module.exports reconnected to the exports alias",
      `exports = {};
       module.exports = exports;
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
  ])("keeps an exports write after %s", (_name, source, expected) => {
    expect(exportedNames(source)).toEqual(expected);
  });

  it.each([
    [
      "a conditional replacement",
      `if (condition) module.exports = {};
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "a replacement by a value that may be the old object",
      `module.exports = require("./self.js");
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "a write inside a function whose call order is unknown",
      `module.exports = {};
       function init() { exports.parse = () => 1; }`,
      ["default", "parse"],
    ],
    [
      "a rebinding hidden inside a function",
      `module.exports = {};
       function reconnect() { exports = module.exports; }
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "a logical assignment in the replacement chain",
      `const cache = exports;
       module.exports = cache ||= {};
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
    [
      "a write whose own statement reconnects the alias",
      `module.exports = {};
       exports.parse = module.exports = exports;`,
      ["default", "parse", "default"],
    ],
    [
      "a later module.exports assignment from the exports alias",
      `module.exports = {};
       exports.parse = () => 1;
       module.exports = exports;`,
      ["default", "parse", "default"],
    ],
    [
      "a later module.exports assignment of the rebound alias",
      `exports = {};
       exports.parse = () => 1;
       module.exports = exports;`,
      ["parse", "default"],
    ],
    [
      "a later module.exports assignment of an unknown value",
      `const saved = exports;
       module.exports = {};
       exports.parse = () => 1;
       module.exports = saved;`,
      ["default", "parse", "default"],
    ],
    [
      "a call through module that may return module",
      `const m = module.valueOf();
       module.exports = {};
       m.exports = exports;
       exports.parse = () => 1;`,
      ["default", "parse"],
    ],
  ])(
    "keeps an exports write whose receiver is unknown after %s",
    (_n, source, expected) => {
      expect(exportedNames(source)).toEqual(expected);
    },
  );
});
