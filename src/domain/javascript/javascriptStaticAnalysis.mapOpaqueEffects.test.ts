import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  'eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'eval("Map.prototype.delete = fetch"); new Map().delete("/accounts");',
  '"use strict"; eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'function run() { eval("Map.prototype.get = fetch"); return new Map().get("/accounts"); }',
  'function patch() { eval("Map.prototype.get = fetch"); } patch(); new Map().get("/accounts");',
  'for (const item of [1, 2]) { new Map().get("/accounts"); eval("Map.prototype.get = fetch"); }',
])(
  "keeps a Map lookup after possible opaque mutation as a candidate: %s",
  (source) => {
    expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
      { kind: "network", value: "/accounts", interpretation: "candidate" },
    ]);
  },
);

it.each([
  'new Map().get("/accounts"); eval("Map.prototype.get = fetch");',
  '(new Map().get("/accounts"), eval("Map.prototype.get = fetch"));',
  'function run(eval) { eval("Map.prototype.get = fetch"); return new Map().get("/accounts"); }',
  'const eval = () => {}; eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'for (const item of []) { eval("Map.prototype.get = fetch"); } new Map().get("/accounts");',
])(
  "preserves a Map proof when eval cannot precede the lookup: %s",
  (source) => {
    expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
  },
);
