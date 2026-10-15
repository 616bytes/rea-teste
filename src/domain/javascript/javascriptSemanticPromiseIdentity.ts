import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  javaScriptExactResultOperand,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { createUnconditionalEvaluationProof } from "./javascriptSymbolicControlFlow.js";

/** Exact local promise-result identity; aliases do not prove execution order. */
export const semanticPromiseResultIdentity = (
  rawNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly node: t.Node;
      readonly aliases: readonly {
        readonly read: t.Identifier;
        readonly initializer: t.Node;
      }[];
    }
  | undefined => {
  const seen = new Set<string>();
  const aliases: { read: t.Identifier; initializer: t.Node }[] = [];
  let node = rawNode;
  for (;;) {
    node = unwrapJavaScriptExpression(node).node;
    const result = javaScriptExactResultOperand(node);
    if (result !== undefined) {
      node = result;
      continue;
    }
    if (!t.isIdentifier(node)) return { node, aliases };
    const binding = resolveSemanticBindingState(state, node, node.name);
    const initializer = semanticStableInitializer(binding, state);
    if (
      binding === undefined ||
      binding.mutable ||
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      binding.referenceInitializers.length !== 0 ||
      seen.has(binding.bindingId)
    )
      return undefined;
    seen.add(binding.bindingId);
    aliases.push({ read: node, initializer: initializer.node });
    node = initializer.node;
  }
};

const awaitedResults = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, t.AwaitExpression[]>
>();

/** Index owned await facts once, including stable aliases of the exact result. */
export const semanticAwaitedResultSites = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly t.AwaitExpression[] => {
  let index = awaitedResults.get(state);
  if (index === undefined) {
    index = new WeakMap();
    const reached = createUnconditionalEvaluationProof(state.parentsByNode);
    for (const awaited of state.awaitSites) {
      if (!reached(awaited)) continue;
      const result = semanticPromiseResultIdentity(awaited.argument, state);
      if (result === undefined) continue;
      const sites = index.get(result.node) ?? [];
      sites.push(awaited);
      index.set(result.node, sites);
    }
    awaitedResults.set(state, index);
  }
  return index.get(node) ?? [];
};
