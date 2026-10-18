import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  createSemanticCallableTargets,
  createSemanticReturnedReferences,
} from "./javascriptSemanticReturnedReferences.js";
import { semanticStrictContext } from "./javascriptSemanticOpaqueEffects.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

/** Expressions that can supply a receiver; the Program denotes the global object. */
const receiverQueries = new WeakMap<
  JavaScriptSemanticAnalysisState,
  (node: t.ThisExpression) => readonly t.Node[]
>();

/** Possible receiver identity is shared by all ambient-write consumers. */
export const createSemanticReceiverReferences = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const prior = receiverQueries.get(state);
  if (prior !== undefined) return prior;
  const owners = new WeakMap<t.Node, t.Node>();
  const lexicalOwner = (node: t.Node): t.Node => {
    const visited: t.Node[] = [];
    let current = node;
    let owner: t.Node = state.program;
    for (;;) {
      const cached = owners.get(current);
      if (cached !== undefined) {
        owner = cached;
        break;
      }
      visited.push(current);
      let parent = state.parentsByNode.get(current);
      if (parent === undefined) break;
      // Parameter decorators can sit below patterns and TSParameterProperty.
      // Their expressions execute outside the decorated function or class.
      if (t.isDecorator(current)) {
        while (
          parent !== undefined &&
          !t.isFunction(parent) &&
          !t.isClass(parent) &&
          !t.isClassProperty(parent) &&
          !t.isClassPrivateProperty(parent) &&
          !t.isClassAccessorProperty(parent)
        )
          parent = state.parentsByNode.get(parent);
        current = parent ?? state.program;
        continue;
      }
      if (
        (t.isFunction(parent) &&
          !t.isArrowFunctionExpression(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === current
          )) ||
        t.isStaticBlock(parent) ||
        ((t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current)
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner;
  };
  let receivers: WeakMap<t.Function, Set<t.Node>> | undefined;
  const indexReceivers = () => {
    const indexed = new WeakMap<t.Function, Set<t.Node>>();
    receivers = indexed;
    const targets = createSemanticCallableTargets(state);
    const contents = createSemanticCallableTargets(state, "contents");
    const intrinsics = createSemanticModuleInterop(state);
    const groups = new Map<
      string,
      { node: t.Node; targets: readonly t.Function[] }
    >();
    const paths = new WeakMap<t.Node, readonly string[]>();
    const covered = new WeakSet<t.Node>();
    const localPath = (node: t.Node): readonly string[] | undefined => {
      const current = unwrapJavaScriptExpression(node).node;
      const cached = paths.get(current);
      if (cached !== undefined) return cached;
      const functions = targets(current);
      if (functions.length > 0) {
        const id = String(groups.size);
        groups.set(id, { node: current, targets: functions });
        const path = ["intrinsic", "local-receiver", id];
        paths.set(current, path);
        return path;
      }
      if (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        const key = semanticStaticPropertyKey(
          current.property,
          current.computed,
        );
        if (key === "call" || key === "apply" || key === "bind") {
          const path = localPath(current.object);
          if (path !== undefined) return [...path, key];
        }
      }
      return intrinsics.intrinsicPath(current);
    };
    const invocations = createSemanticModuleInterop(state, {
      intrinsicPath: localPath,
    });
    const retain = (target: t.Function, receiver?: t.Node) => {
      const values = indexed.get(target) ?? new Set<t.Node>();
      if (receiver !== undefined) values.add(receiver);
      indexed.set(target, values);
    };
    traverseJavaScriptAst(state.program, {
      enter: (node) => {
        if (t.isNewExpression(node)) {
          // Constructors receive a fresh instance, regardless of a returned object.
          for (const target of targets(node.callee)) retain(target);
          covered.add(node.callee);
          return;
        }
        if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
          return;
        const invocation = invocations.intrinsicInvocation(node);
        if (
          invocation?.path.length !== 3 ||
          invocation.path[1] !== "local-receiver"
        )
          return;
        const group = groups.get(invocation.path[2]!);
        if (group === undefined) return;
        covered.add(group.node);
        for (const read of invocation.callableReads ?? []) covered.add(read);
        const callee = unwrapJavaScriptExpression(node.callee).node;
        const receiver =
          invocation.receiver ??
          (callee === group.node &&
          (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
            ? callee.object
            : undefined);
        for (const target of group.targets) {
          retain(target, receiver);
          if (
            t.isSpreadElement(receiver) ||
            (invocation.kind === "opaque" && receiver === undefined)
          )
            retain(target, state.program);
          // Unknown arguments can be nullish. Only proven objects/non-null
          // literals exclude sloppy receiver substitution; reads remain strict.
          const value =
            receiver === undefined
              ? undefined
              : unwrapJavaScriptExpression(receiver).node;
          const nonNullish =
            value !== undefined &&
            (intrinsics.isFreshObject(value) ||
              t.isNewExpression(value) ||
              (t.isLiteral(value) && !t.isNullLiteral(value)) ||
              ["globalThis", "global", "window", "self", "module"].some(
                (name) => isUnshadowedGlobal(value, state, name),
              ));
          if (!nonNullish && !semanticStrictContext(target, state))
            retain(target, state.program);
        }
      },
    });
    // Recovered calls are not a complete use set: stored, returned or passed
    // callable values can be invoked through a receiver we did not recover.
    traverseJavaScriptAst(state.program, {
      enter: (node, parent) => {
        if (
          parent === null ||
          !(
            t.isIdentifier(node) ||
            t.isMemberExpression(node) ||
            t.isOptionalMemberExpression(node) ||
            t.isFunctionExpression(node) ||
            t.isArrowFunctionExpression(node) ||
            t.isObjectExpression(node) ||
            t.isArrayExpression(node)
          )
        )
          return;
        if (
          t.isIdentifier(node) &&
          !t.isReferenced(node, parent, state.parentsByNode.get(parent))
        )
          return;
        let current = node;
        while (
          (t.isMemberExpression(parent) ||
            t.isOptionalMemberExpression(parent)) &&
          parent.object === current
        ) {
          if (covered.has(current)) return;
          current = parent;
          parent = state.parentsByNode.get(current) ?? null;
        }
        if (covered.has(current)) return;
        if (
          (t.isVariableDeclarator(parent) &&
            parent.init === current &&
            t.isIdentifier(parent.id)) ||
          (t.isObjectProperty(parent) && parent.value === current)
        )
          return;
        for (const target of contents(node)) retain(target, state.program);
      },
    });
  };
  const returned = createSemanticReturnedReferences(state);
  const inheritedReceiver = (owner: t.Node): readonly t.Node[] => {
    if (
      !(
        (t.isClassMethod(owner) && owner.kind === "constructor") ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          !owner.static)
      )
    )
      return [];
    const body = state.parentsByNode.get(owner);
    const declaring =
      body === undefined ? undefined : state.parentsByNode.get(body);
    return t.isClass(declaring) && declaring.superClass != null
      ? returned(declaring.superClass).map(({ node }) => node)
      : [];
  };
  const query = (node: t.ThisExpression): readonly t.Node[] => {
    const owner = lexicalOwner(node);
    if (t.isProgram(owner))
      return javaScriptRuntimeContext(owner) === "unknown" ? [owner] : [];
    if (!t.isFunction(owner)) return inheritedReceiver(owner);
    if (receivers === undefined) indexReceivers();
    const known = receivers?.get(owner);
    // Unrecovered calls/accessors may choose the global receiver. Absence of
    // a recovered call is not evidence that a source-visible write is harmless.
    return known === undefined
      ? [state.program, ...inheritedReceiver(owner)]
      : [...known, ...inheritedReceiver(owner)];
  };
  receiverQueries.set(state, query);
  return query;
};
