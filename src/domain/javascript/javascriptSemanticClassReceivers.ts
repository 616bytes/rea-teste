import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticClassCandidates } from "./javascriptSemanticObjectReferences.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

/** One instance method definition retained for member-call lookup. */
export interface ClassMethodEntry {
  readonly methodNode: t.ClassMethod;
  readonly callableId: string;
  readonly key: string;
  readonly owner: t.ClassDeclaration | t.ClassExpression;
}

/** Class identity knowledge owned by one module per program. */
export interface ClassRegistry {
  readonly methodsByClass: ReadonlyMap<
    t.Node,
    ReadonlyMap<string, readonly ClassMethodEntry[]>
  >;
  readonly superClasses: ReadonlyMap<
    t.Node,
    readonly (t.ClassDeclaration | t.ClassExpression)[]
  >;
  readonly allClasses: readonly (t.ClassDeclaration | t.ClassExpression)[];
  readonly methodsByKey: ReadonlyMap<string, readonly ClassMethodEntry[]>;
  readonly reassignedKeys: ReadonlySet<string>;
  readonly computedMethodSeen: boolean;
  readonly dynamicMemberWriteSeen: boolean;
  readonly mixinSeen: boolean;
}

/** Proven receiver classes or a fail-closed unknown reason. */
export type ReceiverProof =
  | {
      readonly status: "proven";
      readonly classes: readonly (t.ClassDeclaration | t.ClassExpression)[];
    }
  | { readonly status: "unknown"; readonly reason: string };

/** Per-site candidate cap with overflow to unresolved. */
export const MAX_CLASS_CANDIDATES = 8;

const registries = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ClassRegistry
>();

/** Return the cached per-program registry, building it once. */
export const getClassRegistry = (
  state: JavaScriptSemanticAnalysisState,
): ClassRegistry => {
  const cached = registries.get(state);
  if (cached !== undefined) return cached;
  const built = buildClassMethodRegistry(state);
  registries.set(state, built);
  return built;
};

const buildClassMethodRegistry = (
  state: JavaScriptSemanticAnalysisState,
): ClassRegistry => {
  const classes: (t.ClassDeclaration | t.ClassExpression)[] = [];
  const methodsByClass = new Map<t.Node, Map<string, ClassMethodEntry[]>>();
  const methodsByKey = new Map<string, ClassMethodEntry[]>();
  let computedMethodSeen = false;
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      if (!t.isClass(node)) return;
      classes.push(node);
      const table = new Map<string, ClassMethodEntry[]>();
      methodsByClass.set(node, table);
      for (const member of node.body.body) {
        if (!t.isClassMethod(member)) continue;
        const key = semanticStaticPropertyKey(member.key, member.computed);
        if (member.computed && key === null) {
          computedMethodSeen = true;
          continue;
        }
        if (
          member.static ||
          member.kind !== "method" ||
          t.isPrivateName(member.key) ||
          key === null
        )
          continue;
        const callableId = semanticCallableIdForNode(member);
        if (callableId === null) continue;
        const entry: ClassMethodEntry = {
          methodNode: member,
          callableId,
          key,
          owner: node,
        };
        const owned = table.get(key) ?? [];
        owned.push(entry);
        table.set(key, owned);
        const grouped = methodsByKey.get(key) ?? [];
        grouped.push(entry);
        methodsByKey.set(key, grouped);
      }
      // A computed class property with an unknown key may install any method.
      for (const member of node.body.body) {
        if (
          t.isClassProperty(member) &&
          member.computed &&
          semanticStaticPropertyKey(member.key, true) === null
        )
          computedMethodSeen = true;
      }
    },
  });
  const superClasses = new Map<
    t.Node,
    readonly (t.ClassDeclaration | t.ClassExpression)[]
  >();
  for (const klass of classes) {
    if (klass.superClass == null) {
      superClasses.set(klass, []);
      continue;
    }
    // Memoized superclass walks use their own seen set inside the helper.
    superClasses.set(klass, semanticClassCandidates(klass.superClass, state));
  }
  const reassignedKeys = new Set<string>();
  let dynamicMemberWriteSeen = false;
  let mixinSeen = false;
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node) && node.operator === "=") {
        const target = unwrapJavaScriptExpression(node.left).node;
        if (
          t.isMemberExpression(target) ||
          t.isOptionalMemberExpression(target)
        ) {
          const key = semanticStaticPropertyKey(
            target.property,
            target.computed,
          );
          if (key === null) dynamicMemberWriteSeen = true;
          else reassignedKeys.add(key);
        }
      }
      if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        !node.callee.computed &&
        t.isIdentifier(node.callee.object, { name: "Object" }) &&
        t.isIdentifier(node.callee.property, { name: "assign" })
      )
        mixinSeen = true;
    },
  });
  return {
    methodsByClass,
    superClasses,
    allClasses: classes,
    methodsByKey,
    reassignedKeys,
    computedMethodSeen,
    dynamicMemberWriteSeen,
    mixinSeen,
  };
};

/** Find the enclosing instance class for a `this` receiver, if any. */
export const enclosingInstanceClass = (
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.ClassDeclaration | t.ClassExpression | null => {
  let staticMethod = false;
  let current = state.parentsByNode.get(site);
  while (current !== undefined) {
    if (t.isClass(current)) return staticMethod ? null : current;
    if (t.isClassMethod(current) || t.isClassPrivateMethod(current)) {
      if (current.static) staticMethod = true;
    } else if (t.isObjectMethod(current)) {
      return null;
    } else if (t.isClassProperty(current)) {
      if (current.static) return null;
    } else if (t.isFunction(current) && !t.isArrowFunctionExpression(current)) {
      return null;
    }
    current = state.parentsByNode.get(current);
  }
  return null;
};

/** Prove `this` or `const x = new LocalClass()` receivers (Unit 1 shapes). */
export const proveUnitOneReceiver = (
  object: t.Node,
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
  seenInitializers: ReadonlySet<JavaScriptSemanticInitializer>,
): ReceiverProof => {
  const expression = unwrapJavaScriptExpression(object).node;
  if (t.isThisExpression(expression)) {
    const owner = enclosingInstanceClass(site, state);
    return owner === null
      ? { status: "unknown", reason: "`this` has no enclosing instance class." }
      : { status: "proven", classes: [owner] };
  }
  if (t.isIdentifier(expression))
    return proveNewExpressionReceiver(expression, state, seenInitializers);
  return {
    status: "unknown",
    reason: `Unsupported ${expression.type} member receiver.`,
  };
};

const proveNewExpressionReceiver = (
  expression: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
  seenInitializers: ReadonlySet<JavaScriptSemanticInitializer>,
): ReceiverProof => {
  const binding = resolveSemanticBindingState(
    state,
    expression,
    expression.name,
  );
  if (binding === undefined)
    return {
      status: "unknown",
      reason: `Unresolved member receiver ${expression.name}.`,
    };
  if (binding.kind === "import")
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} is imported from outside this source.`,
    };
  if (
    binding.kind === "parameter" ||
    binding.mutable ||
    !(
      binding.declarationKinds.size === 1 &&
      binding.declarationKinds.has("const")
    )
  )
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} is not a stable const binding.`,
    };
  const read = semanticBindingAtRead(binding, expression, state.parentsByNode);
  if (!read.hasDefiniteInitializer)
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} may retain an incoming value or an unordered assignment.`,
    };
  const stable = semanticStableInitializer(binding, state);
  if (
    stable === undefined ||
    stable.projection.length !== 0 ||
    seenInitializers.has(stable)
  )
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} has no single stable initializer.`,
    };
  const init = unwrapJavaScriptExpression(stable.node).node;
  if (!t.isNewExpression(init))
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} is not constructed with new.`,
    };
  const callee = unwrapJavaScriptExpression(init.callee).node;
  const classes = semanticClassCandidates(callee, state);
  if (classes.length !== 1 || classes[0] === undefined)
    return {
      status: "unknown",
      reason: `Member receiver ${expression.name} has no single local class.`,
    };
  return { status: "proven", classes: [classes[0]] };
};

/** Whether another hierarchy-related class defines the same key. */
const hasHierarchyOverride = (
  proven: t.ClassDeclaration | t.ClassExpression,
  key: string,
  registry: ClassRegistry,
): boolean => {
  const bases = registry.superClasses.get(proven) ?? [];
  for (const base of bases) {
    const table = registry.methodsByClass.get(base);
    if (table?.get(key) !== undefined && table.get(key)?.length !== 0)
      return true;
  }
  for (const candidate of registry.allClasses) {
    if (candidate === proven) continue;
    const supers = registry.superClasses.get(candidate) ?? [];
    if (!supers.includes(proven)) continue;
    const table = registry.methodsByClass.get(candidate);
    if (table?.get(key) !== undefined && table.get(key)?.length !== 0)
      return true;
  }
  return false;
};

/** Lookup one method key for Unit 1 proven classes (exact or fail-closed). */
export const lookupUnitOneMethod = (
  proven: readonly (t.ClassDeclaration | t.ClassExpression)[],
  key: string,
  registry: ClassRegistry,
): {
  readonly callableIds: readonly string[];
  readonly complete: boolean;
  readonly reason: string;
} => {
  if (
    registry.reassignedKeys.has(key) ||
    registry.mixinSeen ||
    registry.dynamicMemberWriteSeen ||
    registry.computedMethodSeen
  ) {
    const ids = collectOwnIds(proven, key, registry);
    if (ids.length === 0)
      return {
        callableIds: [],
        complete: false,
        reason: `Class method ${key} may have been reassigned or mixed in.`,
      };
    return {
      callableIds: capCandidates(ids),
      complete: false,
      reason: `Class method ${key} may have been reassigned or mixed in.`,
    };
  }
  if (proven.length !== 1 || proven[0] === undefined)
    return {
      callableIds: [],
      complete: false,
      reason: `Class method ${key} has no single receiver class.`,
    };
  const owner = proven[0];
  const table = registry.methodsByClass.get(owner);
  const own = table?.get(key) ?? [];
  if (own.length === 0)
    return {
      callableIds: [],
      complete: false,
      reason: `Class method ${key} is not defined on the receiver class.`,
    };
  if (own.length > 1 || hasHierarchyOverride(owner, key, registry)) {
    const ids = collectHierarchyIds(owner, key, registry);
    return {
      callableIds: capCandidates(
        ids.length === 0 ? own.map(({ callableId }) => callableId) : ids,
      ),
      complete: false,
      reason: `Class method ${key} has overrides or duplicate definitions.`,
    };
  }
  const single = own[0];
  if (single === undefined)
    return {
      callableIds: [],
      complete: false,
      reason: `Class method ${key} is not defined on the receiver class.`,
    };
  return {
    callableIds: [single.callableId],
    complete: true,
    reason: "Exact class method call.",
  };
};

const collectOwnIds = (
  proven: readonly (t.ClassDeclaration | t.ClassExpression)[],
  key: string,
  registry: ClassRegistry,
): string[] => {
  const ids: string[] = [];
  for (const owner of proven) {
    const entries = registry.methodsByClass.get(owner)?.get(key) ?? [];
    for (const entry of entries) ids.push(entry.callableId);
  }
  return [...new Set(ids)].sort();
};

const collectHierarchyIds = (
  proven: t.ClassDeclaration | t.ClassExpression,
  key: string,
  registry: ClassRegistry,
): string[] => {
  const ids: string[] = [];
  const own = registry.methodsByClass.get(proven)?.get(key) ?? [];
  for (const entry of own) ids.push(entry.callableId);
  for (const base of registry.superClasses.get(proven) ?? []) {
    const entries = registry.methodsByClass.get(base)?.get(key) ?? [];
    for (const entry of entries) ids.push(entry.callableId);
  }
  for (const candidate of registry.allClasses) {
    if (candidate === proven) continue;
    const supers = registry.superClasses.get(candidate) ?? [];
    if (!supers.includes(proven)) continue;
    const entries = registry.methodsByClass.get(candidate)?.get(key) ?? [];
    for (const entry of entries) ids.push(entry.callableId);
  }
  return [...new Set(ids)].sort();
};

const capCandidates = (ids: readonly string[]): string[] => {
  if (ids.length > MAX_CLASS_CANDIDATES) return [];
  return [...ids];
};
