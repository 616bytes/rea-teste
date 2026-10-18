import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const table = '{ "entry.js"(exports, module) { module.exports = 1; } }';

it.each([
  [
    "unrelated local binding",
    `const __commonJS = value => value; __commonJS(${table});`,
  ],
  [
    "shadowed helper",
    `const __commonJS = () => 0; { const __commonJS = value => value; __commonJS(${table}); }`,
  ],
  ["unbound spelling", `__commonJS(${table});`],
  [
    "member spelling",
    `const unrelated = { __commonJS: value => value }; unrelated.__commonJS(${table});`,
  ],
  ["esm spelling", `function __esm(value) { return value; } __esm(${table});`],
])(
  "retains %s as a candidate without verified helper identity",
  (_label, source) => {
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.bundler_registrations).toMatchObject([
      {
        bundler: "esbuild",
        interpretation: "candidate",
        modules: [{ module_key: "entry.js" }],
      },
    ]);
  },
);

it("keeps a genuine esbuild-style helper's factory facts with uncertain origin", () => {
  const source = `var __commonJS = (cb, mod) => function __require() {
    if (!mod) { mod = { exports: {} }; cb[Object.keys(cb)[0]](mod.exports, mod); }
    return mod.exports;
  }; var require_entry = __commonJS(${table});`;
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).toBe("complete");
  expect(analysis.bundler_registrations).toMatchObject([
    {
      bundler: "esbuild",
      interpretation: "candidate",
      modules: [{ module_key: "entry.js" }],
    },
  ]);
});

it("does not manufacture a helper candidate for renamed or aliased calls", () => {
  for (const source of [
    `const wrap = value => value; wrap(${table});`,
    `const __commonJS = value => value; const alias = __commonJS; alias(${table});`,
  ]) {
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_status).toBe("complete");
    expect(analysis.bundler_registrations).toEqual([]);
  }
});

it("does not turn malformed input into a complete helper observation", () => {
  const analysis = analyzeJavaScriptStaticSource("const __commonJS = (;");
  expect(analysis.parse_status).not.toBe("complete");
  expect(analysis.bundler_registrations).toEqual([]);
});
