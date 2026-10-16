import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import {
  semanticMutationInitializers,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

it("shares effect ancestry work across successively nested captures", () => {
  const count = 256;
  const program = parseJavaScriptSource(
    "{read();".repeat(count) + "}".repeat(count) + "write();",
  )!.program;
  let gets = 0;
  class CountedParents extends WeakMap<t.Node, t.Node> {
    override get(node: t.Node): t.Node | undefined {
      gets += 1;
      return super.get(node);
    }
  }
  const parents = new CountedParents();
  const reads: t.Node[] = [];
  let effect: t.Node | undefined;
  traverseJavaScriptAst(program, {
    enter(node, parent) {
      if (parent !== null) parents.set(node, parent);
      if (t.isCallExpression(node)) {
        if (t.isIdentifier(node.callee, { name: "read" })) reads.push(node);
        else effect = node;
      }
    },
  });
  for (const read of reads)
    expect(semanticTopLevelEffectFollowsCapture(read, effect, parents)).toBe(
      true,
    );
  expect(gets).toBeLessThan(count * 20);
});

describe("parameter references copied into function body bindings", () => {
  it.each([
    ["var arg = []; mutate(arg);", false],
    ["mutate(arg); var arg = [];", true],
    ["if (flag) { var arg = []; } mutate(arg);", true],
  ])(
    "retains the entry reference only when still reachable: %s",
    (body, retained) => {
      const program = parseJavaScriptSource(
        `function result(arg = source) { ${body} }`,
      )?.program;
      const callable = program?.body[0];
      if (program === undefined || !t.isFunctionDeclaration(callable))
        throw new Error("Expected a parsed function declaration");
      const parameter = callable.params[0];
      if (!t.isAssignmentPattern(parameter) || !t.isIdentifier(parameter.left))
        throw new Error("Expected the source parameter binding");
      const parents = new WeakMap<t.Node, t.Node>();
      let replacement: t.Node | undefined;
      let mutation: t.Node | undefined;
      traverseJavaScriptAst(program, {
        enter: (node, parent) => {
          if (parent !== null) parents.set(node, parent);
          if (t.isVariableDeclarator(node) && node.init !== null)
            replacement = node.init;
          if (t.isCallExpression(node)) mutation = node;
        },
      });
      if (replacement === undefined || mutation === undefined)
        throw new Error("Expected a body initializer and subsequent effect");
      const entry = {
        node: parameter.left,
        projection: [],
        entryBody: callable.body,
      };
      const assigned = { node: replacement, projection: [] };
      const binding: JavaScriptSemanticBindingState = {
        bindingId: "body:arg",
        scopeId: "body",
        name: "arg",
        kind: "variable",
        declarationKinds: new Set(),
        mutable: true,
        memberWrites: [],
        escapedPaths: [],
        definitions: [],
        initializers: [entry, assigned],
        referenceInitializers: [],
        directOrigins: [],
        runtimeImport: false,
      };
      const origins = semanticMutationInitializers(binding, mutation, parents);
      expect(origins.initializers.includes(entry)).toBe(retained);
      expect(origins.initializers).toContain(assigned);
    },
  );
});
