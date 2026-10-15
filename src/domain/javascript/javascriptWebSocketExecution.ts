import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  semanticStaticPropertyName,
} from "./javascriptAstValues.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Outward syntax wrappers preserve the expression's runtime identity. */
const webSocketOuterExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (
      parent === undefined ||
      unwrapJavaScriptExpression(parent).node !== node
    )
      return current;
    current = parent;
  }
};

/** Binding a literal defers it only until that bound result is invoked. */
const webSocketImmediateInvocation = (
  node: t.Function,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression
  | undefined => {
  let callee = webSocketOuterExpression(node, state);
  for (;;) {
    let invocation = state.parentsByNode.get(callee);
    let binds = false;
    if (
      (t.isMemberExpression(invocation) ||
        t.isOptionalMemberExpression(invocation)) &&
      invocation.object === callee
    ) {
      const member = semanticStaticPropertyName(
        invocation.property,
        invocation.computed,
      );
      if (member !== "call" && member !== "apply" && member !== "bind")
        return undefined;
      binds = member === "bind";
      callee = webSocketOuterExpression(invocation, state);
      invocation = state.parentsByNode.get(callee);
    }
    if (
      (!t.isCallExpression(invocation) &&
        !t.isOptionalCallExpression(invocation) &&
        !t.isNewExpression(invocation)) ||
      invocation.callee !== callee
    )
      return undefined;
    if (!binds || t.isNewExpression(invocation)) return invocation;
    callee = webSocketOuterExpression(invocation, state);
  }
};

/** Children completed in order if this straight-line node completes normally. */
const webSocketOrderedEvaluation = (node: t.Node): readonly t.Node[] => {
  if (t.isBlockStatement(node)) return node.body;
  if (t.isExpressionStatement(node)) return [node.expression];
  if (t.isVariableDeclaration(node)) return node.declarations;
  if (t.isVariableDeclarator(node))
    return t.isNode(node.init) ? [node.init] : [];
  if (t.isUnaryExpression(node)) return [node.argument];
  if (t.isSequenceExpression(node)) return node.expressions;
  if (t.isBinaryExpression(node)) return [node.left, node.right];
  if (t.isCallExpression(node) || t.isNewExpression(node))
    return [node.callee, ...node.arguments];
  // Conditional/short-circuit branches, nested functions and try/catch do not
  // establish a suspension on every path to the following expression.
  return [];
};

/** Successful completion crosses the last await in this straight-line node. */
const webSocketCompletedAwait = (
  node: t.Node,
): t.AwaitExpression | undefined => {
  const pending = [node];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const current = unwrapJavaScriptExpression(next).node;
    if (t.isAwaitExpression(current)) return current;
    for (const child of webSocketOrderedEvaluation(current))
      pending.push(child);
  }
  return undefined;
};

const webSocketAwaitPrefixes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, ReadonlyMap<t.Node, t.AwaitExpression>>
>();

/** Index sibling phases once rather than rescan a long async body per socket. */
const webSocketPrecedingAwait = (
  parent: t.Node,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.AwaitExpression | undefined => {
  let byParent = webSocketAwaitPrefixes.get(state);
  if (byParent === undefined) {
    byParent = new WeakMap();
    webSocketAwaitPrefixes.set(state, byParent);
  }
  let prefixes = byParent.get(parent);
  if (prefixes === undefined) {
    const indexed = new Map<t.Node, t.AwaitExpression>();
    let awaited: t.AwaitExpression | undefined;
    for (const node of webSocketOrderedEvaluation(parent)) {
      if (awaited !== undefined) indexed.set(node, awaited);
      awaited = webSocketCompletedAwait(node) ?? awaited;
    }
    byParent.set(parent, indexed);
    prefixes = indexed;
  }
  return prefixes.get(child);
};

/** Find a completed await on the containing straight-line evaluation path. */
const webSocketAsyncContinuation = (
  node: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.AwaitExpression | undefined => {
  let current = node;
  while (current !== body) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return undefined;
    const awaited = webSocketPrecedingAwait(parent, current, state);
    if (awaited !== undefined) return awaited;
    current = parent;
  }
  return undefined;
};

/** Keep class initialization, invocation and suspended bodies in their own phase. */
export const webSocketExecutionContext = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return current;
    if (
      (t.isClassProperty(parent) || t.isClassPrivateProperty(parent)) &&
      !parent.static &&
      parent.value === current
    )
      return parent;
    if (t.isFunction(parent)) {
      if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.key === current
      ) {
        current = parent;
        continue;
      }
      const invocation = webSocketImmediateInvocation(parent, state);
      if (
        invocation === undefined ||
        (current === parent.body &&
          !t.isArrowFunctionExpression(parent) &&
          parent.generator &&
          !t.isNewExpression(invocation))
      )
        return parent;
      if (parent.async && current === parent.body) {
        const continuation = webSocketAsyncContinuation(
          node,
          parent.body,
          state,
        );
        if (continuation !== undefined) return continuation;
      }
    }
    current = parent;
  }
};
