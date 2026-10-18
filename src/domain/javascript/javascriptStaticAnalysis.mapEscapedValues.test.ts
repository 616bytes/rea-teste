import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  'const run = Object.freeze(Function("Map.prototype.get=fetch")); run();',
  'const freeze = Object.freeze; const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'const freeze = Object.freeze; Object.freeze = other; const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'function inspect(consume, condition) { const freeze = condition ? Object.freeze : consume; const run = freeze(Function("Map.prototype.get=fetch")); run(); } inspect(run => run, false);',
  'const freeze = Object.freeze.bind(null); const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'const run = Reflect.apply(Object.freeze, null, [Function("Map.prototype.get=fetch")]); run();',
  'const box = Object.freeze({ run: Function("Map.prototype.get=fetch") }); box.run();',
  "const box = Object.freeze({ prototype: Map.prototype }); patch(box);",
  "const box = Object.freeze({ prototype: Map.prototype }); box.prototype.get = fetch;",
  'const Run = Object.freeze(class extends Function("Map.prototype.get=fetch") {}); new Run();',
])("preserves the returned identity of a known freeze call: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  'Object.freeze(Function("Map.prototype.get=fetch"));',
  'const freeze = Object.freeze; Object.freeze = consume; freeze(Function("Map.prototype.get=fetch"));',
  'const box = Object.freeze({ run: Function("Map.prototype.get=fetch") });',
  "const box = Object.freeze({ prototype: Map.prototype });",
  'const Run = Object.freeze(class extends Function("Map.prototype.get=fetch") {}); try { Run(); } catch {}',
])("keeps an unused or nonexecuting frozen value inert: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it("does not trust a replaced freeze helper to return a private destination", () => {
  expect(
    analyzeJavaScriptStaticSource(`
    Object.freeze = externalFactory;
    const box = Object.freeze({}); box.p = Map.prototype;
    patch(holder); new Map().get('/accounts');
  `).endpoints,
  ).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  'class Run extends Function("Map.prototype.get=fetch") {} new Run();',
  'const Base = Function("Map.prototype.get=fetch"); class Run extends Base {} const Alias = Run; new Alias();',
  'class Base extends Function("Map.prototype.get=fetch") {} class Run extends Base {} new Run();',
  'class Run extends Function("Map.prototype.get=fetch") {} Reflect.construct(Run, []);',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { super(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") {} const Bound = Run.bind(null); new Bound();',
])(
  "retains generated superclass execution during construction: %s",
  (prefix) => {
    expect(
      analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
        .endpoints,
    ).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'class Run extends Function("Map.prototype.get=fetch") {}',
  'class Run extends Function("Map.prototype.get=fetch") {} try { Run(); } catch {}',
  'class Run extends Function("Map.prototype.get=fetch") {} const Bound = Run.bind(null); try { Bound(); } catch {}',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const unused = () => super(); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { super(); } }',
  'class Run extends Function {} new Run("Map.prototype.get=fetch");',
])("keeps inert or nonexecuting class constructors separate: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

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
