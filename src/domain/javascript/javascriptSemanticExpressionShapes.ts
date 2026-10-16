import * as t from "@babel/types";

import {
  isNullishJavaScriptSyntax,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isErasedJavaScriptDeclaration,
  isUnmodeledJavaScriptRuntimeScope,
} from "./javascriptModuleDeclaration.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { collectSemanticReferences } from "./javascriptSemanticProjection.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { hasProvenJavaScriptModuleContext } from "./javascriptSourceParser.js";

type Shape = "array" | "callback" | "unknown";

/** Bounded child-argument identity only; never recover named object contents. */
export const createSemanticExpressionShapeResolver = (
  state: JavaScriptSemanticAnalysisState,
) => {
  // Most modules have no named child arguments. Collect source-wide blockers
  // only when a query actually needs a named binding or ambient undefined.
  let blocked: boolean | undefined;
  const namedProofBlocked = (): boolean => {
    if (blocked !== undefined) return blocked;
    blocked = collectSemanticReferences(state.program, state).some(
      ({ name }) => name === "eval",
    );
    if (!blocked)
      traverseJavaScriptAst(state.program, {
        enter(node) {
          blocked ||=
            isErasedJavaScriptDeclaration(node) ||
            isUnmodeledJavaScriptRuntimeScope(node);
        },
      });
    return blocked;
  };
  const shape = (input: t.Node): Shape => {
    const seen = new Set<t.Node>();
    let node = input;
    let depth = 0;
    while (true) {
      const unwrapped = unwrapJavaScriptExpression(node);
      node = unwrapped.node;
      depth += unwrapped.depth;
      if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state.valueResourceLimits.add("expression-depth");
        return "unknown";
      }
      if (seen.has(node)) return "unknown";
      seen.add(node);
      if (t.isArrayExpression(node)) return "array";
      if (t.isFunction(node) && !("declare" in node && node.declare))
        return "callback";
      if (!t.isIdentifier(node)) return "unknown";
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || binding.referenceInitializers.length > 0)
        return "unknown";
      // Unknown/classic program bindings can change via global objects or
      // constructed code. Do not try to enumerate all paths to that environment.
      if (
        state.scopesById.get(binding.scopeId)?.kind === "program" &&
        !hasProvenJavaScriptModuleContext(state.program)
      )
        return "unknown";
      if (namedProofBlocked()) return "unknown";
      const initializer = semanticStableInitializer(binding, state);
      if (initializer === undefined || initializer.projection.length > 0)
        return "unknown";
      const read = semanticBindingAtRead(binding, node, state.parentsByNode);
      // Hoisted function declarations are the only accepted unordered source.
      const parent = state.parentsByNode.get(initializer.node);
      const hoisted =
        t.isFunctionDeclaration(initializer.node) &&
        (t.isProgram(parent) ||
          (t.isBlockStatement(parent) &&
            t.isFunction(state.parentsByNode.get(parent))));
      if (
        !hoisted &&
        (read.status !== "ordered" || !read.hasDefiniteInitializer)
      )
        return "unknown";
      node = initializer.node;
      depth++;
    }
  };
  return {
    isArray: (node: t.Node) => shape(node) === "array",
    isCallback: (node: t.Node) => shape(node) === "callback",
    isNullish: (input: t.Node) => {
      const { node } = unwrapJavaScriptExpression(input);
      return (
        isNullishJavaScriptSyntax(node) ||
        (isUnshadowedGlobal(node, state, "undefined") && !namedProofBlocked())
      );
    },
  };
};
