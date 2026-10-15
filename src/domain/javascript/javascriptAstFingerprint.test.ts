import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { fingerprintJavaScriptAst } from "./javascriptAstFingerprint.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("JavaScript AST fingerprints", () => {
  it.each([
    ["bigint values", "exports.v = 1n;", "exports.v = 2n;"],
    ["bigint object keys", "exports.v = {1n: 1};", "exports.v = {2n: 1};"],
    ["directives", '"use strict";', '"use asm";'],
    ["assignment reads", "exports.v = 1;", "exports.v += 1;"],
    ["arithmetic assignments", "exports.v += 1;", "exports.v -= 1;"],
    ["logical assignments", "exports.v ||= 1;", "exports.v ??= 1;"],
    [
      "class methods",
      "class A { foo() { return 1; } }",
      "class A { bar() { return 1; } }",
    ],
    ["class fields", "class A { foo = 1; }", "class A { bar = 1; }"],
    [
      "static class methods",
      "class A { static foo() {} }",
      "class A { static bar() {} }",
    ],
    [
      "static class fields",
      "class A { static foo = 1; }",
      "class A { static bar = 1; }",
    ],
    [
      "class getters",
      "class A { get foo() { return 1; } }",
      "class A { get bar() { return 1; } }",
    ],
    [
      "class setters",
      "class A { set foo(value) {} }",
      "class A { set bar(value) {} }",
    ],
  ])("distinguishes %s", (_name, left, right) => {
    expect(fingerprintJavaScriptAst(parse(left))).not.toBe(
      fingerprintJavaScriptAst(parse(right)),
    );
  });

  it("includes complete literal values in the fingerprint", () => {
    const prefix = "x".repeat(1_024);
    const left = parse(`const value = ${JSON.stringify(`${prefix}left`)};`);
    const right = parse(`const value = ${JSON.stringify(`${prefix}right`)};`);

    expect(fingerprintJavaScriptAst(left)).not.toBe(
      fingerprintJavaScriptAst(right),
    );
  });
});

it.each(["() { return 1; }", "= 1;"])(
  "preserves computed class key semantics for %s",
  (member) => {
    const fingerprint = (source: string) =>
      fingerprintJavaScriptAst(parse(source));
    expect(
      fingerprint(`const key = selectKey(); class A { [key]${member} }`),
    ).toBe(
      fingerprint(
        `const selector = selectKey(); class B { [selector]${member} }`,
      ),
    );
    expect(fingerprint(`class A { ["foo"]${member} }`)).not.toBe(
      fingerprint(`class A { ["bar"]${member} }`),
    );
    expect(fingerprint(`class A { [key]${member} }`)).not.toBe(
      fingerprint(`class A { key${member} }`),
    );
  },
);

it.each(["() { return 1; }", "= 1;"])(
  "keeps private class member renames compatible for %s",
  (member) => {
    expect(fingerprintJavaScriptAst(parse(`class A { #foo${member} }`))).toBe(
      fingerprintJavaScriptAst(parse(`class A { #bar${member} }`)),
    );
  },
);

it.each(["obj[key]", "obj?.[key]"])(
  "ignores a local computed key binding in %s",
  (expression) => {
    const left = parse(`function read(obj, key) { return ${expression}; }`);
    const renamed = expression
      .replace("obj", "value")
      .replace("key", "selector");
    const right = parse(
      `function read(value, selector) { return ${renamed}; }`,
    );
    expect(fingerprintJavaScriptAst(left)).toBe(
      fingerprintJavaScriptAst(right),
    );
  },
);

it("distinguishes computed reads from fixed named members", () => {
  expect(fingerprintJavaScriptAst(parse("obj[key]"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.key")),
  );
  expect(fingerprintJavaScriptAst(parse("obj.key"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.other")),
  );
  expect(fingerprintJavaScriptAst(parse('obj["key"]'))).not.toBe(
    fingerprintJavaScriptAst(parse('obj["other"]')),
  );
});

it.each([
  ["obj[`left`]", "obj[`right`]"],
  ["obj[``]", "obj[`right`]"],
  ["obj[true]", "obj[false]"],
  ["obj[null]", "obj[false]"],
  ['obj["" ]', 'obj["right"]'],
  ["obj[`prefix-${key}`]", "obj[`changed-${key}`]"],
])("retains computed literal contents in %s", (left, right) => {
  expect(fingerprintJavaScriptAst(parse(left))).not.toBe(
    fingerprintJavaScriptAst(parse(right)),
  );
});

it("keeps renamed computed-key bundle modules structurally matchable", () => {
  const source = (name: string) => `globalThis.webpackChunkApp.push([[1], {
    17(module, exports) { const ${name} = selectKey(); exports.read = value[${name}]; }
  }]);`;
  const before = analyzeJavaScriptStaticSource(source("key"))
    .bundler_registrations[0]?.modules[0];
  const after = analyzeJavaScriptStaticSource(source("selector"))
    .bundler_registrations[0]?.modules[0];
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(before?.structural_fingerprint_algorithm).toBe("babel-ast-v3");
  expect(before?.source_sha256).not.toBe(after?.source_sha256);
  expect(before?.structural_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(before?.structural_fingerprint_sha256).toBe(
    after?.structural_fingerprint_sha256,
  );
});
