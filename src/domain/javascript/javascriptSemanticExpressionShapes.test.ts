import * as t from "@babel/types";
import { expect, it, vi } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

const indexed = (source: string, path = "shapes.ts") => {
  const parsed = parseJavaScriptSource(source, path);
  if (parsed === null) throw new Error("Expected valid shape fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const reads: t.Node[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "read" })
      ) {
        const argument = node.arguments[0];
        if (argument !== undefined) reads.push(argument);
      }
    },
  });
  return { state: step.value, reads };
};

it.each([
  ["read([]); read([...incoming]);", ["array", "array"]],
  [
    "read(null); read(void sideEffect()); read(undefined);",
    ["nullish", "nullish", "nullish"],
  ],
  ["function f(undefined) { read(undefined); }", ["unknown"]],
  ["const undefined = {}; read(undefined);", ["unknown"]],
  ["read(future); const future = []; read(future);", ["unknown", "array"]],
  [
    "let a=[]; read(a); const saved=a; a=incoming; read(a); read(saved);",
    ["array", "unknown", "array"],
  ],
  [
    "let a=null; const saved=a; a=incoming; read(a); read(saved);",
    ["unknown", "nullish"],
  ],
  ["let a; const saved=a; a=[]; read(saved); read(a);", ["unknown", "array"]],
  ["let a; if(flag)a=[]; read(a);", ["unknown"]],
  ["let a=[]; if(flag)a=incoming; read(a);", ["unknown"]],
  ["let a; function initialize(){a=[];} function f(){read(a);}", ["unknown"]],
  ["const a=flag?[]:[...incoming]; read(a);", ["array"]],
  ["const a=flag?null:undefined; read(a);", ["nullish"]],
  ["const a=flag?[]:incoming; read(a);", ["unknown"]],
  ["let a=flag?[]:a; read(a);", ["unknown"]],
  ["const {a}={a:[]}; read(a);", ["unknown"]],
  ["import a from './external'; read(a);", ["unknown"]],
  ["const a=[]; a.length=incoming; a.extra=1; consume(a); read(a);", ["array"]],
  ["function f(){let a=[]; eval('a={}'); read(a);}", ["unknown"]],
  ["function f(){eval('var undefined={}'); read(undefined);}", ["unknown"]],
  ["function f(eval){let a=[]; eval('a={}'); read(a);}", ["unknown"]],
] as const)(
  "preserves certain shapes and unknowns at each read: %s",
  (source, expected) => {
    const { state, reads } = indexed(source);
    const shared = createSemanticExpressionShapeResolver(state);
    const shape = (resolver: typeof shared, node: t.Node) =>
      resolver.isArray(node)
        ? "array"
        : resolver.isNullish(node)
          ? "nullish"
          : "unknown";
    expect(reads).toHaveLength(expected.length);
    for (const order of [reads, reads.toReversed(), [...reads, ...reads]]) {
      for (const node of order) {
        expect(shape(shared, node)).toBe(expected[reads.indexOf(node)]);
        expect(shape(shared, node)).toBe(
          shape(createSemanticExpressionShapeResolver(state), node),
        );
      }
    }
  },
);

it.each([
  [
    "nested block does not enable strict mode",
    "function f(){{'use strict';function g(a){a=null;arguments[0]={};read(a);}}}",
    "unknown",
  ],
  [
    "conditional legacy arguments declaration",
    "function f(a,flag){if(flag)function arguments(){}a=null;arguments[0]={};read(a);}",
    "unknown",
  ],
  [
    "arrow var arguments shadows inherited object",
    "function f(a){a=null;(()=>{var arguments;consume(arguments)})();read(a);}",
    "nullish",
  ],
  [
    "script global object var self-initializer",
    "var globalThis=globalThis;var a=null;globalThis.a={};read(a);",
    "unknown",
  ],
  [
    "local var global object shadow",
    "function f(){var globalThis={};var a=null;globalThis.a={};read(a);}",
    "nullish",
  ],
  [
    "mapped argument write",
    "function f(a){a=null;arguments[0]={};read(a);}",
    "unknown",
  ],
  [
    "argument alias escape",
    "function f(a){a=null;const args=arguments;consume(args);read(a);}",
    "unknown",
  ],
  [
    "argument property definition",
    "function f(a){a=null;Object.defineProperty(arguments,'0',{value:{}});read(a);}",
    "unknown",
  ],
  [
    "arrow argument capture",
    "function f(a){a=null;(()=>{arguments[0]={}})();read(a);}",
    "unknown",
  ],
  [
    "arguments var redeclaration",
    "function f(a){var arguments;a=null;arguments[0]={};read(a);}",
    "unknown",
  ],
  [
    "outer arguments binding",
    "const arguments={};function f(a){a=null;arguments[0]={};read(a);}",
    "unknown",
  ],
  [
    "private function name",
    "const f=function arguments(a){a=null;arguments[0]={};read(a);};",
    "unknown",
  ],
  [
    "computed object method key",
    "function f(a){a=null;const o={[arguments[0]={}](){}};read(a);}",
    "unknown",
  ],
  [
    "computed class method key",
    "function f(a){a=null;class C{[arguments[0]={}](){}};read(a);}",
    "unknown",
  ],
  [
    "with fallback",
    "function f(a){a=null;with(o){consume(arguments)}read(a);}",
    "unknown",
  ],
  [
    "unexposed parameter assignment",
    "function f(a){a=null;read(a);}",
    "nullish",
  ],
  [
    "strict function",
    "function f(a){'use strict';a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "strict enclosing program",
    "'use strict';function f(a){a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  ["class method", "class C{f(a){a=null;arguments[0]={};read(a);}}", "nullish"],
  [
    "default parameter",
    "function f(a,b=0){a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "rest parameter",
    "function f(a,...rest){a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "destructured parameter",
    "function f(a,{b}){a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "ordinary inner arguments",
    "function f(a){a=null;function g(){arguments[0]={}}g(0);read(a);}",
    "nullish",
  ],
  [
    "arrow own parameter",
    "const f=(a)=>{a=null;arguments[0]={};read(a);};",
    "nullish",
  ],
  [
    "formal arguments shadow",
    "function f(a,arguments){a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "lexical arguments shadow",
    "function f(a){let arguments={};a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "body function arguments shadow",
    "function f(a){function arguments(){}a=null;arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "property names are not argument references",
    "function f(a){a=null;o.arguments={};const x={arguments:0};read(a);}",
    "nullish",
  ],
  [
    "legacy function arguments is not mapped",
    "function f(a){a=null;f.arguments[0]={};read(a);}",
    "nullish",
  ],
  [
    "script global object write",
    "var a=null;globalThis.a={};read(a);",
    "unknown",
  ],
  [
    "global object alias",
    "var a=null;const root=globalThis;root.a={};read(a);",
    "unknown",
  ],
  [
    "global member eval",
    "let a=null;globalThis.eval('a={}');read(a);",
    "unknown",
  ],
  ["script top-level this", "var a=null;this.a={};read(a);", "unknown"],
  ["script arrow this", "var a=null;(()=>{this.a={}})();read(a);", "unknown"],
  [
    "sloppy function receiver",
    "var a=null;function mutate(){this.a={}}mutate();read(a);",
    "unknown",
  ],
  [
    "sloppy IIFE receiver alias",
    "var a=null;const root=(function(){return this})();root.a={};read(a);",
    "unknown",
  ],
  [
    "arrow inherits sloppy function receiver",
    "var a=null;function mutate(){(()=>{this.a={}})()}mutate();read(a);",
    "unknown",
  ],
  [
    "sloppy object method receiver",
    "var a=null;const o={mutate(){this.a={}}};const mutate=o.mutate;mutate();read(a);",
    "unknown",
  ],
  [
    "default parameters do not enable strict receiver",
    "var a=null;function mutate(value=0){this.a={}}mutate();read(a);",
    "unknown",
  ],
  [
    "nested block does not enable strict receiver",
    "var a=null;function mutate(){{'use strict';function inner(){this.a={}}inner();}}mutate();read(a);",
    "unknown",
  ],
  [
    "computed class method key inherits sloppy receiver",
    "var a=null;function mutate(){class C{[this.a={}](){}}}mutate();read(a);",
    "unknown",
  ],
  [
    "computed object method key inherits sloppy receiver",
    "var a=null;function mutate(){const o={[this.a={}](){}}}mutate();read(a);",
    "unknown",
  ],
  [
    "strict function receiver",
    "var a=null;function receiver(){'use strict';return this}receiver();read(a);",
    "nullish",
  ],
  [
    "strict program receiver",
    "'use strict';var a=null;function receiver(){return this}receiver();read(a);",
    "nullish",
  ],
  [
    "nested function inherits strict receiver",
    "var a=null;function outer(){'use strict';return function receiver(){return this}}outer()();read(a);",
    "nullish",
  ],
  [
    "arrow inherits strict function receiver",
    "var a=null;function outer(){'use strict';return ()=>this}outer()();read(a);",
    "nullish",
  ],
  [
    "class method owns strict receiver",
    "var a=null;class C{mutate(){this.a={}}}new C().mutate();read(a);",
    "nullish",
  ],
  [
    "class fields and static block own receiver",
    "var a=null;class C{field=this.a={};static field=this.a={};static{this.a={}}}new C();read(a);",
    "nullish",
  ],
  [
    "class method arrow inherits class receiver",
    "var a=null;class C{mutate(){(()=>{this.a={}})()}}new C().mutate();read(a);",
    "nullish",
  ],
  [
    "sloppy receiver does not replace function-local binding",
    "function mutate(){let a=null;this.a={};read(a);}mutate();",
    "nullish",
  ],
  ["unexposed script binding", "var a=null;read(a);", "nullish"],
  [
    "function-local binding",
    "function f(){let a=null;globalThis.a={};read(a);}",
    "nullish",
  ],
  [
    "shadowed global object",
    "const globalThis={};var a=null;globalThis.a={};read(a);",
    "nullish",
  ],
] as const)("accounts for binding exposure: %s", (_name, source, expected) => {
  const { state, reads } = indexed(source, "exposure.cjs");
  const shared = createSemanticExpressionShapeResolver(state);
  expect(reads).toHaveLength(1);
  for (const node of [...reads, ...reads]) {
    expect(shared.isNullish(node)).toBe(expected === "nullish");
    expect(shared.isNullish(node)).toBe(
      createSemanticExpressionShapeResolver(state).isNullish(node),
    );
  }
});

it("keeps module bindings and parameters separate from global-object writes", () => {
  const { state, reads } = indexed(
    "var a=null;globalThis.a={};read(a);function f(b){b=null;arguments[0]={};read(b);}",
    "exposure.mjs",
  );
  const resolver = createSemanticExpressionShapeResolver(state);
  expect(reads).toHaveLength(2);
  for (const node of reads) expect(resolver.isNullish(node)).toBe(true);
});

it("keeps module binding proofs separate from ordinary function receivers", () => {
  const { state, reads } = indexed(
    "var a=null;function mutate(){this.a={}}mutate();read(a);",
    "exposure.mjs",
  );
  expect(reads).toHaveLength(1);
  const resolver = createSemanticExpressionShapeResolver(state);
  expect(resolver.isNullish(reads[0]!)).toBe(true);
});

it("retains uncertainty through aliases of exposed parameters", () => {
  const { state, reads } = indexed(
    "function f(a){a=[];const saved=a;arguments[0]={};read(a);read(saved);}",
    "exposure.cjs",
  );
  const resolver = createSemanticExpressionShapeResolver(state);
  expect(reads).toHaveLength(2);
  for (const node of reads) expect(resolver.isArray(node)).toBe(false);
});

it("bounds shared alias diamonds without evaluating array contents", () => {
  const measure = (depth: number) => {
    const { state, reads } = indexed(`const a0=[];
      ${Array.from({ length: depth }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("\n")}
      read(a${depth});`);
    const lookups = state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      expect(
        createSemanticExpressionShapeResolver(state).isArray(reads[0]!),
      ).toBe(true);
      return lookups.reduce(
        (total, lookup) => total + lookup.mock.calls.length,
        0,
      );
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  expect(small).toBeGreaterThan(0);
  expect(measure(12)).toBeLessThan(3 * small);
});
