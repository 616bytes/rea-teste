import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/**
 * Whether the CommonJS `exports` alias and `module.exports` denote one object.
 * `unknown` covers writes whose result this timeline cannot prove.
 */
type ExportsAliasRelation = "connected" | "detached" | "unknown";

interface ExportsAliasTimeline {
  /** Relation in force before each top-level expression statement runs. */
  readonly before: ReadonlyMap<t.Statement, ExportsAliasRelation>;
  /**
   * Statements followed by a rebinding that may make `module.exports` the
   * object the alias denotes now (`module.exports = exports`), which would
   * export properties written to it in between.
   */
  readonly reexportedLater: ReadonlySet<t.Statement>;
  /**
   * False when a rebinding or an escape of `module` falls outside the
   * straight-line top-level statements, so statement order proves nothing.
   */
  readonly sequenced: boolean;
}

const timelines = new WeakMap<t.Program, ExportsAliasTimeline>();

/** `module.exports`, with `module` still the unshadowed CommonJS wrapper binding. */
export const isCommonJsModuleExports = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
  isUnshadowedGlobal(node.object, state, "module") &&
  semanticStaticPropertyKey(node.property, node.computed) === "exports";

/** An expression that creates a new object identity when it is evaluated. */
export const isFreshAssignmentResult = (node: t.Node): boolean => {
  let value = node;
  while (t.isAssignmentExpression(value, { operator: "=" }))
    value = value.right;
  return (
    t.isArrowFunctionExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isClassExpression(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value)
  );
};

/**
 * True when `node` writes a property of the `exports` alias after a top-level
 * statement provably left it pointing at a different object than
 * `module.exports`: `module.exports = {}` or `exports = {}`. Such a write never
 * defines an export of the module. Anything that leaves the order unproven, such
 * as conditional or function-hosted writes, stays an export candidate.
 */
export const isDetachedCommonJsExportsWrite = (
  node: t.AssignmentExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const left = unwrapJavaScriptExpression(node.left).node;
  if (
    (!t.isMemberExpression(left) && !t.isOptionalMemberExpression(left)) ||
    !isUnshadowedGlobal(left.object, state, "exports")
  )
    return false;
  const statement = topLevelStatement(node, state);
  if (statement === undefined) return false;
  const timeline = timelineOf(state);
  return (
    timeline.sequenced &&
    timeline.before.get(statement) === "detached" &&
    !timeline.reexportedLater.has(statement)
  );
};

/** Walk right-hand assignment chains up to a top-level expression statement. */
const topLevelStatement = (
  node: t.AssignmentExpression,
  state: JavaScriptSemanticAnalysisState,
): t.Statement | undefined => {
  let current: t.Node = node;
  for (
    let parent = state.parentsByNode.get(current);
    parent !== undefined;
    parent = state.parentsByNode.get(current)
  ) {
    if (t.isAssignmentExpression(parent) && parent.right === current)
      current = parent;
    else
      return t.isExpressionStatement(parent) &&
        state.parentsByNode.get(parent) === state.program
        ? parent
        : undefined;
  }
  return undefined;
};

const timelineOf = (
  state: JavaScriptSemanticAnalysisState,
): ExportsAliasTimeline => {
  const cached = timelines.get(state.program);
  if (cached !== undefined) return cached;
  const before = new Map<t.Statement, ExportsAliasRelation>();
  const rebindings = new Set<t.Node>();
  const chains: { statement: t.Statement; reexports: boolean }[] = [];
  let relation: ExportsAliasRelation = "connected";
  for (const statement of state.program.body) {
    if (!t.isExpressionStatement(statement)) continue;
    const chain = rebindingChain(statement.expression, state);
    // A statement that also rebinds can reconnect the alias before its own
    // property write lands, so the relation before it proves nothing there.
    if (chain === null) before.set(statement, relation);
    else for (const target of chain.targets) rebindings.add(target);
    chains.push({ statement, reexports: chain?.reexports === true });
    if (chain === null) continue;
    relation = chain.relation;
  }
  const reexportedLater = new Set<t.Statement>();
  let reexports = false;
  for (const chain of chains.toReversed()) {
    if (reexports) reexportedLater.add(chain.statement);
    reexports ||= chain.reexports;
  }
  const timeline = {
    before,
    reexportedLater,
    sequenced: !hasUnsequencedRebinding(rebindings, state),
  };
  timelines.set(state.program, timeline);
  return timeline;
};

/**
 * Read an assignment chain that writes `exports` or `module.exports`. All
 * targets of one chain receive the chain's final value, so a chain naming both
 * keeps them connected and a fresh value separates them from the other one.
 */
const rebindingChain = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly targets: readonly t.Node[];
  readonly relation: ExportsAliasRelation;
  /** Assigns `module.exports` something other than a freshly created value. */
  readonly reexports: boolean;
} | null => {
  const targets: t.Node[] = [];
  let alias = false;
  let moduleExports = false;
  let simple = true;
  let value = expression;
  while (t.isAssignmentExpression(value)) {
    const left = unwrapJavaScriptExpression(value.left).node;
    const isAlias = isUnshadowedGlobal(left, state, "exports");
    const isModuleExports = isCommonJsModuleExports(left, state);
    if (isAlias || isModuleExports) {
      targets.push(left);
      alias ||= isAlias;
      moduleExports ||= isModuleExports;
    }
    // `cache ||= {}` may keep the previous value, wherever it sits in the chain.
    simple &&= value.operator === "=";
    value = unwrapJavaScriptExpression(value.right).node;
  }
  if (targets.length === 0) return null;
  const fresh = simple && isFreshAssignmentResult(value);
  const reexports = moduleExports && !fresh;
  if (!simple) return { targets, relation: "unknown", reexports };
  if (alias && moduleExports)
    return { targets, relation: "connected", reexports };
  const other = alias
    ? isCommonJsModuleExports(value, state)
    : isUnshadowedGlobal(value, state, "exports");
  if (other) return { targets, relation: "connected", reexports };
  return { targets, relation: fresh ? "detached" : "unknown", reexports };
};

/**
 * A write that reaches `exports`, `module` or `module.exports` outside the
 * recognized top-level statements, or an escape of `module` (which may rebind
 * `exports` indirectly), can run at any point and invalidates statement order.
 */
const hasUnsequencedRebinding = (
  recognized: ReadonlySet<t.Node>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let found = false;
  traverseJavaScriptAst(state.program, {
    enter: (node, parent, readAncestors) => {
      if (found) return;
      const target = semanticWriteSiteTarget(node);
      if (target !== null)
        for (const leaf of semanticWriteTargets(target))
          if (writesWrapperBinding(leaf, state) && !recognized.has(leaf))
            found = true;
      if (
        t.isIdentifier(node, { name: "module" }) &&
        escapesModule(node, parent, readAncestors) &&
        isUnshadowedGlobal(node, state, "module")
      )
        found = true;
    },
  });
  return found;
};

const writesWrapperBinding = (
  leaf: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (t.isIdentifier(leaf))
    return (
      isUnshadowedGlobal(leaf, state, "exports") ||
      isUnshadowedGlobal(leaf, state, "module")
    );
  if (!t.isMemberExpression(leaf) && !t.isOptionalMemberExpression(leaf))
    return false;
  if (!isUnshadowedGlobal(leaf.object, state, "module")) return false;
  const key = semanticStaticPropertyKey(leaf.property, leaf.computed);
  return key === null || key === "exports";
};

/**
 * Other uses of `module` than reading a member or naming a property. Invoking
 * a member (`module.valueOf()`) can return `module` itself, so it escapes.
 */
const escapesModule = (
  node: t.Identifier,
  parent: t.Node | null,
  readAncestors: () => readonly t.Node[],
): boolean => {
  if (parent === null) return true;
  if (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent))
    return parent.object === node
      ? isInvoked(parent, readAncestors())
      : parent.computed;
  if (t.isUnaryExpression(parent, { operator: "typeof" })) return false;
  if (
    (t.isObjectProperty(parent) || t.isObjectMethod(parent)) &&
    parent.key === node
  )
    return parent.computed || (t.isObjectProperty(parent) && parent.shorthand);
  return true;
};

/** Whether `member`, through inert wrappers, is called, constructed or tagged. */
const isInvoked = (member: t.Node, ancestors: readonly t.Node[]): boolean => {
  const path = ancestors.at(-1) === member ? ancestors : [...ancestors, member];
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const owner = path[index];
    if (owner === undefined) return false;
    if (
      (t.isCallExpression(owner) ||
        t.isOptionalCallExpression(owner) ||
        t.isNewExpression(owner)) &&
      unwrapJavaScriptExpression(owner.callee).node === member
    )
      return true;
    if (
      t.isTaggedTemplateExpression(owner) &&
      unwrapJavaScriptExpression(owner.tag).node === member
    )
      return true;
    if (unwrapJavaScriptExpression(owner).node !== member) return false;
  }
  return false;
};
