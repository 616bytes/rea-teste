import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const large = "x".repeat(200_000);
const requests = [
  { setup: "", callee: "fetch" },
  { setup: "", callee: "new WebSocket" },
  { setup: 'const http = require("node:http");', callee: "http.request" },
  { setup: 'const https = require("node:https");', callee: "https.get" },
];

describe("semantic request endpoint normalization", () => {
  it.each(requests)(
    "bounds bare $callee endpoint values",
    ({ setup, callee }) => {
      for (const expression of [JSON.stringify(large), `\`${large}\``]) {
        const ir = analyzeJavaScriptSemantics(
          `${setup}${callee}(${expression});`,
        );
        expect(ir.requestOperations).toHaveLength(1);
        expect(ir.requestOperations[0]).toMatchObject({
          endpoint: null,
          endpointResourceLimit: "primitive-bytes",
          resolution: "partial",
        });
        expect(ir.coverage).toMatchObject({
          status: "partial",
          resourceLimits: ["primitive-bytes"],
        });
      }
    },
  );

  it("preserves a limiting endpoint through a linked response consumer", () => {
    const ir = analyzeJavaScriptSemantics(
      `const response = fetch(${JSON.stringify(large)}); response.json();`,
    );
    expect(ir.requestOperations).toHaveLength(2);
    for (const operation of ir.requestOperations)
      expect(operation).toMatchObject({
        endpoint: null,
        endpointResourceLimit: "primitive-bytes",
        resolution: "partial",
      });
    expect(ir.requestOperations[1]?.linkedRequestIds).toEqual([
      ir.requestOperations[0]?.requestId,
    ]);
  });

  it.each(["", "/api/items", "/api/\u2603?revision=1#part"])(
    "keeps a bounded endpoint exact: %j",
    (endpoint) => {
      const ir = analyzeJavaScriptSemantics(
        `fetch(${JSON.stringify(endpoint)});`,
      );
      expect(ir.requestOperations[0]).toMatchObject({
        endpoint,
        resolution: "complete",
      });
      expect(ir.requestOperations[0]?.endpointResourceLimit).toBeUndefined();
      expect(ir.coverage.resourceLimits ?? []).toEqual([]);
    },
  );

  it("uses cooked endpoint text without changing source lookup identities", () => {
    const ir = analyzeJavaScriptSemantics(
      'fetch(`/api/\\u0061`); const fs = require("node:fs");' +
        `fs.readFile(${JSON.stringify(large)});`,
    );
    expect(ir.requestOperations[0]?.endpoint).toBe("/api/a");
    expect(ir.configurationOperations[0]?.key).toBe(large);
    expect(ir.coverage.resourceLimits ?? []).toEqual([]);
  });

  it.each(["missing", "{}", "null", "42"])(
    "keeps unsupported request input %s partial without inventing a resource limit",
    (expression) => {
      const ir = analyzeJavaScriptSemantics(`fetch(${expression});`);
      expect(ir.requestOperations[0]).toMatchObject({
        endpoint: null,
        resolution: "partial",
      });
      expect(ir.requestOperations[0]?.endpointResourceLimit).toBeUndefined();
      expect(ir.coverage.resourceLimits ?? []).toEqual([]);
    },
  );
});
