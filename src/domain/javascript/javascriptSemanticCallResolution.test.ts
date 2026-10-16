import * as t from "@babel/types";
import { expect, it, vi } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  resolveLocalCallables,
  type LocalCallableResolutionCache,
} from "./javascriptSemanticCallResolution.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "callback.js");
  if (parsed === null) throw new Error("Expected valid callback fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache: LocalCallableResolutionCache = new WeakMap();
  return {
    state,
    callableById,
    bindingCache,
    resolve: (node: t.Node) =>
      resolveLocalCallables({
        node,
        state,
        callableById,
        bindingCache,
      }),
  };
};

it("bounds shared partial callback alias expansion by AST size", () => {
  const measure = (depth: number) => {
    const context =
      indexed(`function fallback(){return {member:1};} function choose(cb,flag){
      if(flag)cb=fallback;
      const a0=cb;
      ${Array.from({ length: depth }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("")}
      return a${depth}();
    }`);
    const choose = context.state.program.body[1];
    if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
    const last = choose.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
      throw new Error("Missing call");
    const reads = vi.spyOn(context.bindingCache, "get");
    const result = context.resolve(last.argument.callee);
    expect(result).toMatchObject({ complete: false });
    expect(result.callableIds).toHaveLength(1);
    const callReads = reads.mock.calls.length;
    const lookups = context.state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      expect(
        createSemanticReturnedReferences(context.state)(last.argument.callee),
      ).toHaveLength(1);
      return {
        callReads,
        referenceReads: lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        ),
      };
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  const large = measure(12);
  expect(small.callReads).toBeGreaterThan(0);
  expect(large.callReads).toBeLessThan(3 * small.callReads);
  expect(small.referenceReads).toBeGreaterThan(0);
  expect(large.referenceReads).toBeLessThan(3 * small.referenceReads);
});

it.each([
  ["if(flag){cb=fallback;cb();}", true],
  ["if(flag)cb=fallback;cb();", false],
  ["cb ||= fallback;cb();", false],
] as const)(
  "reports initializer coverage at the read: %s",
  (body, expected) => {
    const { state } = indexed(`function choose(cb,flag){${body}}`);
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(expected);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not reuse a later resolved callback at an earlier read", () => {
  const context = indexed(
    `function fallback(){} function choose(cb){cb();cb=fallback;cb();}`,
  );
  const choose = context.state.program.body[1];
  if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
  const calls = choose.body.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const [before, after] = calls;
  if (before === undefined || after === undefined)
    throw new Error("Missing callback reads");
  expect(context.resolve(after)).toMatchObject({ complete: true });
  expect(context.resolve(before)).toMatchObject({
    complete: false,
    callableIds: [],
  });
  expect(context.resolve(after)).toMatchObject({ complete: true });
});

it.each([false, true])(
  "bounds separate branch assignments with intrinsic cycle=%s",
  (cyclic) => {
    const measure = (depth: number) => {
      const context = indexed(`function fallback(){return {};}
function choose(flag){let a0=${cyclic ? "flag?a0:{make:fallback}" : "{make:fallback}"};
${Array.from({ length: depth }, (_, i) => `let a${i + 1};if(flag)a${i + 1}=a${i};else a${i + 1}=a${i};`).join("")}
return a${depth}.make();}`);
      const choose = context.state.program.body[1];
      if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
      const last = choose.body.body.at(-1);
      if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
        throw new Error("Missing call");
      const lookups = context.state.scopes.map((scope) =>
        vi.spyOn(scope.bindings, "get"),
      );
      try {
        expect(
          createSemanticReturnedReferences(context.state)(last.argument.callee),
        ).toHaveLength(1);
        return lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        );
      } finally {
        for (const lookup of lookups) lookup.mockRestore();
      }
    };
    const small = measure(8),
      large = measure(12);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThan(3 * small);
  },
);

it.each(["||=", "??="])(
  "retains definite assignment to an empty local: %s",
  (operator) => {
    const { state } = indexed(
      `function choose(){let cb;cb ${operator} fallback;cb();}`,
    );
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(true);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not memoize alias cycle cuts across entry paths", () => {
  const context = indexed(
    `function fallback(){} let a,b; function setA(){a=flag?b:fallback;} function setB(){b=a;} a(); b();`,
  );
  const callees = context.state.program.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const fallback = context.state.callables.find(
    (callable) => callable.name === "fallback",
  );
  if (fallback === undefined) throw new Error("Missing fallback");
  for (const node of [...callees, ...callees].reverse()) {
    const warm = context.resolve(node);
    const cold = resolveLocalCallables({
      node,
      state: context.state,
      callableById: context.callableById,
      bindingCache: new WeakMap(),
    });
    expect(warm).toEqual(cold);
    expect(warm).toMatchObject({
      complete: false,
      cycleDependent: true,
      callableIds: [fallback.callableId],
    });
  }
});

it.each([
  "function run(){let cb=()=>{};eval('cb=options');probe(cb);}",
  "function run(cb){cb=()=>{};arguments[0]=options;probe(cb);}",
  "function run(cb){cb=()=>{};const args=arguments;args[0]=options;const saved=cb;probe(saved);}",
])("keeps unindexed callback replacement incomplete: %s", (source) => {
  const context = indexed(source);
  const reads: t.Node[] = [];
  traverseJavaScriptAst(context.state.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "probe" })
      )
        reads.push(node.arguments[0]!);
    },
  });
  expect(reads).toHaveLength(1);
  expect(context.resolve(reads[0]!)).toMatchObject({ complete: false });
});

it("bounds long callable aliases and retains shallow proofs independently of query order", () => {
  const context = indexed(`const callback=()=>{};
    ${Array.from({ length: 4096 }, (_, i) => `const a${i}=${i ? `a${i - 1}` : "callback"};`).join("\n")}
    probe(a4095);probe(a120);probe(a254);probe(a256);probe(callback);`);
  const reads: t.Node[] = [];
  traverseJavaScriptAst(context.state.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "probe" })
      )
        reads.push(node.arguments[0]!);
    },
  });
  expect(() => context.resolve(reads[0]!)).not.toThrow();
  const cold = (node: t.Node) =>
    resolveLocalCallables({
      node,
      state: context.state,
      callableById: context.callableById,
      bindingCache: new WeakMap(),
    });
  for (const order of [reads, reads.toReversed(), [...reads, ...reads]]) {
    for (const node of order) expect(context.resolve(node)).toEqual(cold(node));
  }
  expect(context.resolve(reads[0]!)).toMatchObject({ complete: false });
  expect(context.resolve(reads[1]!)).toMatchObject({ complete: true });
  expect(context.resolve(reads[2]!)).toMatchObject({ complete: true });
  expect(context.resolve(reads[3]!)).toMatchObject({ complete: false });
  expect(context.resolve(reads[4]!)).toMatchObject({ complete: true });
  expect(context.state.valueResourceLimits).toContain("expression-depth");
});

it.each(["conditional", "logical"])(
  "bounds deeply nested %s callable alternatives",
  (kind) => {
    const context = indexed("const cb=()=>{};probe(cb);");
    const call = context.state.program.body.at(-1);
    if (!t.isExpressionStatement(call) || !t.isCallExpression(call.expression))
      throw new Error("Missing probe");
    const leaf = call.expression.arguments[0]!;
    let target = leaf as t.Expression;
    for (let i = 0; i < 300; i++)
      target =
        kind === "conditional"
          ? t.conditionalExpression(
              t.identifier("flag"),
              leaf as t.Expression,
              target,
            )
          : t.logicalExpression("||", leaf as t.Expression, target);
    const result = context.resolve(target);
    expect(result.complete).toBe(false);
    expect(result.callableIds).toHaveLength(1);
    expect(context.state.valueResourceLimits).toContain("expression-depth");
    expect(context.resolve(leaf)).toMatchObject({ complete: true });
  },
);

it("bounds cyclic callable diamonds and preserves cache order under exhaustion", () => {
  const context = indexed(`function fallback(){};
    function run(flag){let a0=flag?a0:fallback;
    ${Array.from({ length: 14 }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("\n")}
    probe(a14);probe(a0);probe(a8);}`);
  const reads: t.Node[] = [];
  traverseJavaScriptAst(context.state.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "probe" })
      )
        reads.push(node.arguments[0]!);
    },
  });
  const lookups = vi.spyOn(context.bindingCache, "get");
  const deep = context.resolve(reads[0]!);
  expect(deep.complete).toBe(false);
  expect(lookups.mock.calls.length).toBeLessThan(12_000);
  expect(context.state.valueResourceLimits).toContain("callable-expansion");
  for (const node of [...reads, ...reads.toReversed()]) {
    const cold = resolveLocalCallables({
      node,
      state: context.state,
      callableById: context.callableById,
      bindingCache: new WeakMap(),
    });
    expect(context.resolve(node)).toEqual(cold);
  }
});

it("charges cached acyclic proof work identically to a cold query", () => {
  const context = indexed(`const cb=()=>{};const a0=cb;
    ${Array.from({ length: 14 }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("\n")}
    probe(a14);probe(a8);probe(a0);`);
  const reads: t.Node[] = [];
  traverseJavaScriptAst(context.state.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "probe" })
      )
        reads.push(node.arguments[0]!);
    },
  });
  expect(context.resolve(reads[1]!)).toMatchObject({ complete: true });
  const cold = resolveLocalCallables({
    node: reads[0]!,
    state: context.state,
    callableById: context.callableById,
    bindingCache: new WeakMap(),
  });
  expect(cold).toMatchObject({ complete: false, budgetDependent: true });
  expect(context.resolve(reads[0]!)).toEqual(cold);
  expect(context.resolve(reads[2]!)).toMatchObject({ complete: true });
  expect(context.resolve(reads[0]!)).toEqual(cold);
});
it("does not reuse a depth-truncated proof under a different active cycle path", () => {
  const prefix =
    `function fallback(){};function other(){};let ${Array.from({ length: 20 }, (_, i) => `a${i}`).join(",")};` +
    Array.from(
      { length: 20 },
      (_, i) =>
        `function set${i}(){a${i}=${i === 0 ? "flag?a1:fallback" : i === 19 ? "a0" : `a${i + 1}`};}`,
    ).join("");
  const wrap = (expression: string, depth: number): string =>
    `(${expression})${" as unknown".repeat(depth)}`;
  const filler = (leaves: number): string => {
    if (leaves === 1) return "fallback";
    const left = Math.floor(leaves / 2);
    return `(flag?${filler(left)}:${filler(leaves - left)})`;
  };
  const source = `${prefix};(${wrap("a9", 240)})();(${wrap(`(flag?${filler(1354)}:(flag?a0:other))`, 228)})();`;
  const parsed = parseJavaScriptSource(source, "callback.ts");
  if (parsed === null || parsed.errors.length > 0)
    throw new Error("Expected valid callback fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const reads = parsed.program.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const first = reads[0];
  const last = reads[1];
  if (first === undefined || last === undefined)
    throw new Error("Missing calls");
  const resolve = (node: t.Node, bindingCache: LocalCallableResolutionCache) =>
    resolveLocalCallables({ node, state, callableById, bindingCache });
  const cold = resolve(last, new WeakMap());
  expect(cold.callableIds).toHaveLength(2);
  expect(cold.complete).toBe(false);
  const cache: LocalCallableResolutionCache = new WeakMap();
  resolve(first, cache);
  expect(resolve(last, cache)).toEqual(cold);
  expect(resolve(last, cache)).toEqual(cold);
});
