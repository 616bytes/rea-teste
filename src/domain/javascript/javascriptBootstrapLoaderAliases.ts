import * as t from "@babel/types";

import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** Possible loader identities for writes, preserving each lexical alias's capture. */
export const createBootstrapLoaderAliasLookup = (
  loaderBindingIds: ReadonlySet<string>,
  state: JavaScriptSemanticAnalysisState,
): ((root: t.Node) => boolean) => {
  const known = new WeakMap<t.Node, boolean>();
  return (root) => {
    const cached = known.get(root);
    if (cached !== undefined) return cached;
    const pending: t.Node[] = [root];
    const seen = new Set<t.Node>();
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const next = pending[cursor];
      if (next === undefined) continue;
      const node = unwrapJavaScriptExpression(next).node;
      if (seen.has(node)) continue;
      seen.add(node);
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) continue;
        if (loaderBindingIds.has(binding.bindingId)) {
          known.set(root, true);
          return true;
        }
        const selected = semanticBindingAtRead(
          binding,
          node,
          state.parentsByNode,
        ).binding;
        // Destructuring projections and rest copies do not denote the loader
        // itself. Only follow direct lexical references, not arbitrary fields.
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers.filter(
            (origin) => origin.copyKind === undefined,
          ),
        ])
          if (initializer.projection.length === 0)
            pending.push(initializer.node);
      } else if (t.isConditionalExpression(node)) {
        pending.push(node.consequent, node.alternate);
      } else if (t.isLogicalExpression(node)) {
        pending.push(node.left, node.right);
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push(last);
      } else if (t.isAssignmentExpression(node, { operator: "=" })) {
        pending.push(node.right);
      } else if (
        t.isAssignmentExpression(node) &&
        ["&&=", "||=", "??="].includes(node.operator)
      ) {
        pending.push(node.left, node.right);
      }
    }
    known.set(root, false);
    return false;
  };
};
