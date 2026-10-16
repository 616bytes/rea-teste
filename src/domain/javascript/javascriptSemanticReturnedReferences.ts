import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  SEMANTIC_RETURNED_REFERENCE_BLOCKER_CONTEXT_LIMIT,
  SEMANTIC_RETURNED_REFERENCE_BLOCKER_LIMIT,
  SEMANTIC_RETURNED_REFERENCE_EXPANSION_LIMIT,
  SEMANTIC_RETURNED_REFERENCE_PATH_LINK_LIMIT,
} from "./javascriptSemanticResourceLimits.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import type { JavaScriptSemanticResourceLimit } from "./javascriptSemanticValueTypes.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  readonly path: PathLink;
  readonly initializers: InitializerChain | null;
}

/** Entered-initializer ancestry shared across children: O(1) to extend. */
interface InitializerChain {
  readonly parent: InitializerChain | null;
  readonly value: JavaScriptSemanticInitializer;
  readonly depth: number;
}

/**
 * A projection path as an interned chain: the head key is consumed first.
 * Identical paths share one link, so extending, consuming, and keying on a
 * path are all O(1) and no per-candidate copy or serialization is retained.
 */
interface PathLink {
  readonly rest: PathLink | null;
  readonly key: string | number | null;
  readonly length: number;
  readonly id: number;
}

interface PathInterner {
  readonly root: PathLink;
  readonly prepend: (
    base: PathLink,
    keys: readonly (string | number | null)[],
  ) => PathLink | null;
}

const createPathInterner = (chargeLink: () => boolean): PathInterner => {
  // Key by base link identity and the original key reference so no serialized
  // key text is retained per entry. Newly created links draw on the caller's
  // budget; a null result drops the candidate instead of truncating its path.
  const slotsByBase = new Map<
    PathLink,
    Map<string | number | null, PathLink>
  >();
  let nextId = 1;
  const root: PathLink = { rest: null, key: null, length: 0, id: 0 };
  const prependOne = (
    base: PathLink,
    key: string | number | null,
  ): PathLink | null => {
    let slots = slotsByBase.get(base);
    if (slots === undefined) {
      slots = new Map();
      slotsByBase.set(base, slots);
    }
    const existing = slots.get(key);
    if (existing !== undefined) return existing;
    if (!chargeLink()) return null;
    const link: PathLink = {
      rest: base,
      key,
      length: base.length + 1,
      id: nextId,
    };
    nextId += 1;
    slots.set(key, link);
    return link;
  };
  return {
    root,
    prepend: (base, keys) => {
      let link: PathLink | null = base;
      for (let index = keys.length - 1; index >= 0 && link !== null; index--)
        link = prependOne(link, keys[index] ?? null);
      return link;
    },
  };
};

const initializerChainLink = (
  chain: InitializerChain | null,
  target: JavaScriptSemanticInitializer,
): InitializerChain | null => {
  for (let link = chain; link !== null; link = link.parent)
    if (link.value === target) return link;
  return null;
};

/** Cycle-blocked initializers with their depth on the completing frame's chain. */
type InitializerContext = ReadonlyMap<JavaScriptSemanticInitializer, number>;
type CompletedExpansions = WeakMap<
  t.Node,
  Map<string, readonly InitializerContext[]>
>;

interface ExpansionFrame {
  readonly item: Candidate;
  readonly node: t.Node;
  readonly pathKey: string;
  readonly parent: ExpansionFrame | null;
  readonly blockers: Map<JavaScriptSemanticInitializer, number>;
}

type ExpansionTask =
  | {
      readonly kind: "visit";
      readonly item: Candidate;
      readonly parent: ExpansionFrame | null;
    }
  | { readonly kind: "complete"; readonly frame: ExpansionFrame };

const contextContains = (
  context: InitializerContext,
  required: InitializerContext,
): boolean => {
  for (const initializer of required.keys())
    if (!context.has(initializer)) return false;
  return true;
};

const propagateBlockers = (
  blockers: InitializerContext,
  parent: ExpansionFrame | null,
  chargeBlocker: () => boolean,
): void => {
  if (parent === null) return;
  // A parent chain is always a prefix of a descendant chain, so a blocker
  // belongs to the parent chain exactly when its depth fits the prefix.
  const parentDepth = parent.item.initializers?.depth ?? 0;
  for (const [initializer, depth] of blockers) {
    if (depth > parentDepth || parent.blockers.has(initializer)) continue;
    if (!chargeBlocker()) return;
    parent.blockers.set(initializer, depth);
  }
};

const completeExpansion = (
  frame: ExpansionFrame,
  expanded: CompletedExpansions,
  chargeBlocker: () => boolean,
): void => {
  let covered: InitializerContext | undefined;
  // Rich contexts stay uncached: re-expansion is bounded by the candidate
  // reserve, while every cached context keeps lookups and retention small.
  if (
    frame.blockers.size <= SEMANTIC_RETURNED_REFERENCE_BLOCKER_CONTEXT_LIMIT
  ) {
    const paths =
      expanded.get(frame.node) ??
      new Map<string, readonly InitializerContext[]>();
    const contexts = paths.get(frame.pathKey) ?? [];
    covered = contexts.find((context) =>
      contextContains(frame.blockers, context),
    );
    if (covered === undefined) {
      paths.set(frame.pathKey, [
        ...contexts.filter(
          (context) => !contextContains(context, frame.blockers),
        ),
        frame.blockers,
      ]);
      expanded.set(frame.node, paths);
    }
  }
  propagateBlockers(covered ?? frame.blockers, frame.parent, chargeBlocker);
};

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
): ((callee: t.Node) => readonly SemanticReturnedReference[]) => {
  const results = new WeakMap<t.Node, readonly SemanticReturnedReference[]>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee) => {
    const existing = results.get(callee);
    if (existing !== undefined) return existing;
    const functions = new Set<t.Node>();
    // Recursive reassignment webs (for example fiber locals reassigned
    // across switch arms) enumerate every simple initializer chain as a
    // distinct path. Reserve budget before each candidate or path link is
    // constructed so the candidate representations — not just completed
    // visits — stay bounded for one call target; keep the references proven
    // so far and disclose the limit through coverage instead of claiming
    // completeness.
    let remaining = SEMANTIC_RETURNED_REFERENCE_EXPANSION_LIMIT;
    let remainingLinks = SEMANTIC_RETURNED_REFERENCE_PATH_LINK_LIMIT;
    let remainingBlockers = SEMANTIC_RETURNED_REFERENCE_BLOCKER_LIMIT;
    let budgeted = false;
    const recordLimit = (limit: JavaScriptSemanticResourceLimit): void => {
      state.valueResourceLimits.add(limit);
      budgeted = true;
    };
    const reserve = (): boolean => {
      if (remaining > 0) {
        remaining -= 1;
        return true;
      }
      recordLimit("returned-reference-expansion");
      return false;
    };
    const chargeLink = (): boolean => {
      if (remainingLinks > 0) {
        remainingLinks -= 1;
        return true;
      }
      recordLimit("returned-reference-path-links");
      return false;
    };
    const chargeBlocker = (): boolean => {
      if (remainingBlockers > 0) {
        remainingBlockers -= 1;
        return true;
      }
      recordLimit("returned-reference-blockers");
      return false;
    };
    const paths = createPathInterner(chargeLink);
    const work: ExpansionTask[] = [
      {
        kind: "visit",
        item: { node: callee, path: paths.root, initializers: null },
        parent: null,
      },
    ];
    // Finish descendants before memoizing an expansion. Only actual external
    // cycle blockers affect reuse; branch history is not a dependency. An
    // acyclic expression/path is consequently expanded once across a diamond.
    const expanded: CompletedExpansions = new WeakMap();
    while (work.length > 0) {
      const task = work.pop();
      if (task === undefined) break;
      if (task.kind === "complete") {
        completeExpansion(task.frame, expanded, chargeBlocker);
        continue;
      }
      if (budgeted) break;
      const { item, parent } = task;
      const node = unwrapJavaScriptExpression(item.node).node;
      const pathKey = String(item.path.id);
      const covered = ((): InitializerContext | undefined => {
        const contexts = expanded.get(node)?.get(pathKey);
        if (contexts === undefined || contexts.length === 0) return undefined;
        const chainValues = new Set<JavaScriptSemanticInitializer>();
        for (let link = item.initializers; link !== null; link = link.parent)
          chainValues.add(link.value);
        return contexts.find((context) => {
          for (const initializer of context.keys())
            if (!chainValues.has(initializer)) return false;
          return true;
        });
      })();
      if (covered !== undefined) {
        // Cached cycle dependencies must reach the caller's proof too.
        propagateBlockers(covered, parent, chargeBlocker);
        continue;
      }
      const frame: ExpansionFrame = {
        item,
        node,
        pathKey,
        parent,
        blockers: new Map(),
      };
      work.push({ kind: "complete", frame });
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) continue;
        const selected = semanticBindingAtRead(
          binding,
          node,
          state.parentsByNode,
        ).binding;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
          const blockerLink = initializerChainLink(
            item.initializers,
            initializer,
          );
          if (blockerLink !== null) {
            if (!frame.blockers.has(initializer) && chargeBlocker())
              frame.blockers.set(initializer, blockerLink.depth);
            continue;
          }
          if (!reserve()) break;
          const path = paths.prepend(item.path, initializer.projection);
          if (path === null) break;
          pending.push({
            node: initializer.node,
            path,
            initializers: {
              parent: item.initializers,
              value: initializer,
              depth: (item.initializers?.depth ?? 0) + 1,
            },
          });
        }
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        if (reserve()) {
          const receiverPath = paths.prepend(item.path, path.reverse());
          if (receiverPath !== null)
            pending.push({ ...item, node: receiver, path: receiverPath });
        }
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        for (const child of [
          t.isConditionalExpression(node) ? node.consequent : node.left,
          t.isConditionalExpression(node) ? node.alternate : node.right,
        ])
          if (reserve()) pending.push({ ...item, node: child });
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined && reserve())
          pending.push({ ...item, node: last });
      } else if (t.isFunction(node) && item.path.length === 0)
        functions.add(node);
      else if (t.isObjectExpression(node))
        selectObjectTargets(node, item, pending, objectTargets, reserve);
      else if (t.isArrayExpression(node)) {
        const key = item.path.length === 0 ? undefined : item.path.key;
        const rest = item.path.rest ?? item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            if (reserve()) {
              const spreadPath = paths.prepend(rest, [null]);
              if (spreadPath !== null)
                pending.push({
                  ...item,
                  node: element.argument,
                  path: spreadPath,
                });
            }
          } else if (
            (index === null || uncertainOffset || index === offset) &&
            reserve()
          )
            pending.push({ ...item, node: element, path: rest });
        });
      } else if (t.isNewExpression(node)) {
        if (reserve()) pending.push({ ...item, node: node.callee });
      } else if (t.isClass(node)) {
        const key = item.path.length === 0 ? undefined : item.path.key;
        const rest = item.path.rest ?? item.path;
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              (item.path.length === 0 && member.kind === "constructor") ||
              (key !== undefined &&
                (key === null ||
                  semanticStaticPropertyKey(member.key, member.computed) ===
                    String(key)))
            ) {
              if (!reserve()) break;
              pending.push({ ...item, node: member, path: rest });
            }
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            key !== undefined &&
            (key === null ||
              semanticStaticPropertyKey(member.key, member.computed) ===
                String(key))
          ) {
            if (!reserve()) break;
            pending.push({ ...item, node: member.value, path: rest });
          }
        }
        if (
          node.superClass !== null &&
          node.superClass !== undefined &&
          reserve()
        )
          pending.push({ ...item, node: node.superClass });
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          work.push({ kind: "visit", item: child, parent: frame });
      }
    }
    const output = [...functions].flatMap((node) => {
      const callables = t.isClass(node)
        ? node.body.body.filter(
            (member) =>
              t.isClassMethod(member) && member.kind === "constructor",
          )
        : [node];
      return callables.flatMap((callable) =>
        semanticCallableResultExpressions(callable).flatMap(
          ({ node, delegated }) =>
            node === null
              ? []
              : [{ node, projection: delegated ? [null] : [] }],
        ),
      );
    });
    results.set(callee, output);
    return output;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
  reserve: () => boolean,
): void => {
  const key = item.path.length === 0 ? undefined : item.path.key;
  const rest = item.path.rest ?? item.path;
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse()) {
        if (!reserve()) return;
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path: rest }),
        });
      }
      if (reserve())
        pending.push({
          ...item,
          node: t.isObjectProperty(property) ? property.value : property,
          path: rest,
        });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      if (!reserve()) return;
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (!reserve()) return;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path: rest });
    else pending.push({ ...item, node: property, path: rest });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
