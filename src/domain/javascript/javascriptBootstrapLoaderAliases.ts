import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** Loader proof precedes member effects; only inline data has no stale mutable reads. */
const literalDataSource = (
  root: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const current = pending[cursor];
    if (current === undefined) continue;
    const node = unwrapJavaScriptExpression(current).node;
    if (readExactJavaScriptLiteral(node).found) continue;
    if (t.isArrayExpression(node)) {
      if (state.ambientWrites.covers(["global", "Array", "prototype", null]))
        return false;
      for (const element of node.elements)
        if (element !== null) pending.push(element);
    } else if (t.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (!t.isObjectProperty(property)) return false;
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (key === null || (key === "__proto__" && !property.computed))
          return false;
        pending.push(property.value);
      }
    } else return false;
  }
  return true;
};

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
            (origin) =>
              origin.copyKind === undefined &&
              !(
                [
                  ...(origin.requiredSources ?? []),
                  ...(origin.fallbackSources ?? []),
                ].every(({ node }) => literalDataSource(node, state)) &&
                semanticReferenceSourcesInactive(origin, state)
              ),
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
