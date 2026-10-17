import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it("does not classify a local Map lookup as a network endpoint", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const records = new Map([["/accounts", { name: "Alice" }]]);
    console.log(records.get("/accounts"));
    fetch("/network");
  `);
  expect(analysis.endpoints).toMatchObject([
    { kind: "network", value: "/network", mechanism: "call:fetch" },
  ]);
  expect(analysis.endpoints[0]?.interpretation).toBeUndefined();
});

it.each([
  'new Map().get("/accounts")',
  'new Map().delete("https://example.test/accounts")',
  'const records = new Map(); const alias = records; alias.get("/accounts")',
  'const records = new globalThis.Map(); records?.["get"]("/accounts")',
])("omits a proven Map operation: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
});

it.each([
  'client.get("/accounts")',
  'const records = new Map(); records.get = request; records.get("/accounts")',
  'let records = new Map(); records = client; records.get("/accounts")',
  'function inspect(Map) { new Map().get("/accounts"); }',
  'Map.prototype.get = request; const records = new Map(); records.get("/accounts")',
  'const records = new Map(); records.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); const alias = records; alias.__proto__ = { get: fetch }; records.get("/accounts")',
  'const records = new Map(); records["__proto__"] = { delete: fetch }; records.delete("/accounts")',
])("keeps unresolved lookup semantics as a candidate: %s", (source) => {
  expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
    { kind: "network", value: "/accounts", interpretation: "candidate" },
  ]);
});
