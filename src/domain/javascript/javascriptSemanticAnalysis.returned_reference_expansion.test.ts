import * as t from "@babel/types";
import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "web.js");
  if (parsed === null) throw new Error("Expected valid fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  return { program: parsed.program, state: step.value };
};

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

it("returns the selected callable's result expressions below the budget", () => {
  const { program, state } = indexed(`
    const shared = { value: 1 };
    function source() { return shared; }
    function choose(flag) { return flag ? source : source; }
    choose(true);
  `);
  const call = program.body[3];
  if (!t.isExpressionStatement(call) || !t.isCallExpression(call.expression))
    throw new Error("Missing choose call");
  const references = createSemanticReturnedReferences(state)(
    call.expression.callee,
  );
  expect([...state.valueResourceLimits]).toEqual([]);
  expect(references).toHaveLength(1);
  expect(t.isConditionalExpression(references[0]?.node)).toBe(true);
});

it("resolves a deep alias chain exactly within the budget", () => {
  const depth = 1024;
  const chain = Array.from(
    { length: depth },
    (_, index) => `const a${depth - index - 1} = a${depth - index};`,
  ).join("\n");
  const { program, state } = indexed(`
    const marker = { value: 1 };
    function fn() { return marker; }
    const a${depth} = fn;
    ${chain}
    a0();
  `);
  const call = program.body.at(-1);
  if (!t.isExpressionStatement(call) || !t.isCallExpression(call.expression))
    throw new Error("Missing chain call");
  const references = createSemanticReturnedReferences(state)(
    call.expression.callee,
  );
  expect([...state.valueResourceLimits]).toEqual([]);
  expect(
    references.some(
      (reference) =>
        t.isIdentifier(reference.node) && reference.node.name === "marker",
    ),
  ).toBe(true);
});

it("bounds a reassignment chain deeper than the admission reserve", () => {
  const depth = 32768;
  const chain = Array.from(
    { length: depth },
    (_, index) => `const a${depth - index - 1} = a${depth - index};`,
  ).join("\n");
  const { program, state } = indexed(`
    const marker = { value: 1 };
    function fn() { return marker; }
    const a${depth} = fn;
    ${chain}
    a0();
  `);
  const call = program.body.at(-1);
  if (!t.isExpressionStatement(call) || !t.isCallExpression(call.expression))
    throw new Error("Missing chain call");
  createSemanticReturnedReferences(state)(call.expression.callee);
  expect([...state.valueResourceLimits]).toEqual([
    "returned-reference-expansion",
  ]);
});

it("keeps references proven before the budget cuts off a reassignment web", () => {
  const bindings = ["t", "e", "a", "n", "r"];
  const keys = [
    "child",
    "sibling",
    "return",
    "memoizedState",
    "pendingProps",
    "stateNode",
  ];
  const arms = Array.from({ length: 24 }, (_, index) => {
    const target = bindings[index % bindings.length];
    const source = bindings[(index + 1) % bindings.length];
    const key = keys[index % keys.length];
    return `case ${index}: ${target} = ${source}.${key}; break;`;
  }).join("\n");
  const { program, state } = indexed(`
    const marker = { value: 1 };
    function direct() { return marker; }
    function run(t, e, a, n, r, flag) {
      switch (t.tag) {
        ${arms}
      }
      const d = t.deletions;
      const f = flag ? direct : d.push;
      f();
    }
    run(fiber, e0, a0, n0, r0, true);
  `);
  const run = program.body[2];
  if (!t.isFunctionDeclaration(run)) throw new Error("Missing run function");
  const call = run.body.body.at(-1);
  if (!t.isExpressionStatement(call) || !t.isCallExpression(call.expression))
    throw new Error("Missing f() call");
  const references = createSemanticReturnedReferences(state)(
    call.expression.callee,
  );
  expect([...state.valueResourceLimits]).toEqual([
    "returned-reference-expansion",
  ]);
  expect(
    references.some(
      (reference) =>
        t.isIdentifier(reference.node) && reference.node.name === "marker",
    ),
  ).toBe(true);
});
