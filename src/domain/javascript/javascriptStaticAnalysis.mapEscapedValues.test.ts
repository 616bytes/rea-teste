import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  'const run = await Function("Map.prototype.get=fetch"); run();',
  'const factory = Function; const run = await factory("Map.prototype.get=fetch"); run();',
  'const run = await (condition ? Function("Map.prototype.get=fetch") : safe); run();',
  'const run = await Function("Map.prototype.get=fetch"); consume(run);',
  "patch(class { static expose() { return Map.prototype; } });",
  "patch(class { static get expose() { return Map.prototype; } });",
  "patch(class { static expose = Map.prototype; });",
  "patch(class { static expose = () => Map.prototype; });",
  "class Holder { static expose() { return Map.prototype; } } patch(Holder);",
  "class Parent { static expose() { return Map.prototype; } } patch(class extends Parent {});",
])(
  "retains ambient identities exposed through await or class values: %s",
  (prefix) => {
    const analysis = analyzeJavaScriptStaticSource(
      `${prefix} new Map().get('/accounts');`,
    );
    expect(analysis.endpoints).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'const run = await Function("Map.prototype.get=fetch");',
  "const run = await (() => ({})); run();",
  "const run = await unknown; run();",
  "class Holder { static expose() { return Map.prototype; } }",
  "class Holder { static expose = Map.prototype; }",
  "patch(class { static expose() { return {}; } });",
  "patch(class { static expose = {}; });",
  "patch(class { static #expose = Map.prototype; });",
])("keeps unused or nonambient escaped values separate: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it("does not apply later awaited generated execution to an earlier lookup", () => {
  expect(
    analyzeJavaScriptStaticSource(`
    const run = await Function('Map.prototype.get=fetch');
    new Map().get('/accounts'); run();
  `).endpoints,
  ).toEqual([]);
});

it("does not promote an awaited receiver into a proven Map identity", () => {
  const analysis = analyzeJavaScriptStaticSource(
    "const records = await new Map(); records.get('/accounts');",
  );
  expect(analysis.endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it("does not prove an awaited thenable's destination private", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    async function expose(external) {
      const box = await { then(resolve) { resolve(external); } };
      box.p = Map.prototype;
    }
    expose(holder); patch(holder); new Map().get('/accounts');
  `);
  expect(analysis.endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});
