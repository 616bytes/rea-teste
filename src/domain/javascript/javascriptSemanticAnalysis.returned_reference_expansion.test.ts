import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";

const reassignmentWebSource = (count: number) => {
  const bindings = ["t", "e", "a", "n", "r"];
  const keys = [
    "child",
    "sibling",
    "return",
    "memoizedState",
    "pendingProps",
    "stateNode",
  ];
  const arms = Array.from({ length: count }, (_, index) => {
    const target = bindings[index % bindings.length];
    const source = bindings[(index + 1) % bindings.length];
    const key = keys[index % keys.length];
    return `case ${index}: ${target} = ${source}.${key}; break;`;
  }).join("\n");
  return `
    import imported from "dep";
    function beginWork(t, e, a, n, r) {
      switch (t.tag) {
        ${arms}
      }
      const d = t.deletions;
      d.push(n);
      return t;
    }
    beginWork(fiber, e0, a0, n0, r0);
    const unrelated = 42;
  `;
};

it("bounds returned-reference expansion on reassignment webs and preserves unrelated facts", () => {
  const ir = analyzeJavaScriptSemantics(reassignmentWebSource(24));
  expect(ir.coverage).toMatchObject({
    status: "partial",
    omittedCount: null,
    resourceLimits: ["returned-reference-expansion"],
  });
  expect(onlyBinding(ir, "unrelated").value).toEqual({
    status: "literal",
    value: 42,
  });
  expect(onlyBinding(ir, "imported").provenance.status).toBe("module");
  expect(ir.moduleLinks).toContainEqual(
    expect.objectContaining({ kind: "import", specifier: "dep" }),
  );
});

it("resolves returned references within the expansion budget", () => {
  const ir = analyzeJavaScriptSemantics(`
    function build() { return { member: 1 }; }
    function choose(flag) { return flag ? build : build; }
    const result = choose(true)().member;
    const unrelated = 42;
  `);
  expect(ir.coverage.resourceLimits ?? []).toEqual([]);
  expect(onlyBinding(ir, "unrelated").value).toEqual({
    status: "literal",
    value: 42,
  });
});
