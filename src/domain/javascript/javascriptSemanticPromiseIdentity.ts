import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  javaScriptExactResultOperand,
} from "./javascriptAstValues.js";
import {
  delayedInstanceFieldValue,
  semanticPatternInitializationPrecedesRead,
} from "./javascriptSemanticEvaluationOrder.js";
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

/** Syntax-local alias order; deferred activations require a separate proof. */
const promiseAliasInitializedBeforeRead = (
  initializer: t.Node,
  read: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const parents = state.parentsByNode;
  const owner = (node: t.Node): t.Node => {
    let child = node;
    for (;;) {
      const parent = parents.get(child);
      if (parent === undefined) return child;
      if (
        delayedInstanceFieldValue(parent, child) ||
        (t.isFunction(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === child
          ))
      )
        return parent;
      child = parent;
    }
  };
  if (owner(initializer) !== owner(read)) return false;
  let ancestor: t.Node | undefined = initializer;
  while (ancestor !== undefined && !t.isFunction(ancestor)) {
    if (t.isSwitchCase(ancestor)) {
      let readAncestor: t.Node | undefined = read;
      while (readAncestor !== undefined && readAncestor !== ancestor)
        readAncestor = parents.get(readAncestor);
      if (readAncestor === undefined) return false;
    }
    ancestor = parents.get(ancestor);
  }
  const binding = resolveSemanticBindingState(state, read, read.name);
  const bindingNode = semanticStableInitializer(binding, state)?.bindingNode;
  const patternOrder =
    bindingNode === undefined
      ? undefined
      : semanticPatternInitializationPrecedesRead(bindingNode, read, parents);
  return patternOrder ?? (initializer.end ?? Infinity) < (read.start ?? -1);
};

/** The shared activation block owns conditional producer/wait coupling. */
const promiseWaitBoundary = (
  producer: t.Node,
  awaited: t.AwaitExpression,
  parents: WeakMap<t.Node, t.Node>,
): t.Program | t.BlockStatement | undefined => {
  const blocks = new Set<t.Node>();
  let current: t.Node | undefined = producer;
  while (current !== undefined && !t.isFunction(current)) {
    if (t.isBlockStatement(current) || t.isProgram(current))
      blocks.add(current);
    current = parents.get(current);
  }
  current = awaited;
  while (current !== undefined && !t.isFunction(current)) {
    if (
      (t.isBlockStatement(current) || t.isProgram(current)) &&
      blocks.has(current)
    )
      return current;
    current = parents.get(current);
  }
  return undefined;
};

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
      const result = semanticPromiseResultIdentity(awaited.argument, state);
      if (result === undefined) continue;
      // Aliases retain identity only after their own initialization. Reachability
      // is relative to the block shared with the producer: entering a branch
      // can create and await a promise together without reaching either globally.
      if (result.aliases.length !== 0) {
        if (
          result.aliases.some(
            ({ initializer, read }) =>
              !promiseAliasInitializedBeforeRead(initializer, read, state),
          )
        )
          continue;
        const boundary = promiseWaitBoundary(
          result.node,
          awaited,
          state.parentsByNode,
        );
        if (boundary === undefined || !reached(awaited, boundary)) continue;
      }
      const sites = index.get(result.node) ?? [];
      sites.push(awaited);
      index.set(result.node, sites);
    }
    awaitedResults.set(state, index);
  }
  return index.get(node) ?? [];
};
