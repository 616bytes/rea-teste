import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { SEMANTIC_RETURNED_REFERENCE_EXPANSION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  readonly path: readonly (string | number | null)[];
  readonly initializers: InitializerChain | null;
}

/** Entered-initializer ancestry shared across children: O(1) to extend. */
interface InitializerChain {
  readonly parent: InitializerChain | null;
  readonly value: JavaScriptSemanticInitializer;
}

const initializerChainHas = (
  chain: InitializerChain | null,
  target: JavaScriptSemanticInitializer,
): boolean => {
  for (let link = chain; link !== null; link = link.parent)
    if (link.value === target) return true;
  return false;
};

const initializerChainCovers = (
  chain: InitializerChain | null,
  required: InitializerContext,
): boolean => {
  for (const initializer of required)
    if (!initializerChainHas(chain, initializer)) return false;
  return true;
};

type InitializerContext = ReadonlySet<JavaScriptSemanticInitializer>;
type CompletedExpansions = WeakMap<
  t.Node,
  Map<string, readonly InitializerContext[]>
>;

interface ExpansionFrame {
  readonly item: Candidate;
  readonly node: t.Node;
  readonly pathKey: string;
  readonly parent: ExpansionFrame | null;
  readonly blockers: Set<JavaScriptSemanticInitializer>;
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
  for (const initializer of required)
    if (!context.has(initializer)) return false;
  return true;
};

const propagateBlockers = (
  blockers: InitializerContext,
  parent: ExpansionFrame | null,
): void => {
  if (parent === null) return;
  for (const initializer of blockers)
    if (initializerChainHas(parent.item.initializers, initializer))
      parent.blockers.add(initializer);
};

const completeExpansion = (
  frame: ExpansionFrame,
  expanded: CompletedExpansions,
): void => {
  const paths =
    expanded.get(frame.node) ??
    new Map<string, readonly InitializerContext[]>();
  const contexts = paths.get(frame.pathKey) ?? [];
  const covered = contexts.find((context) =>
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
  propagateBlockers(covered ?? frame.blockers, frame.parent);
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
    const work: ExpansionTask[] = [
      {
        kind: "visit",
        item: { node: callee, path: [], initializers: null },
        parent: null,
      },
    ];
    // Finish descendants before memoizing an expansion. Only actual external
    // cycle blockers affect reuse; branch history is not a dependency. An
    // acyclic expression/path is consequently expanded once across a diamond.
    const expanded: CompletedExpansions = new WeakMap();
    // Recursive reassignment webs (for example fiber locals reassigned
    // across switch arms) enumerate every simple initializer chain as a
    // distinct path. Reserve budget before each child is constructed so the
    // candidate representations — not just completed visits — stay bounded
    // for one call target; keep the references proven so far and disclose
    // the limit through coverage instead of claiming completeness.
    let remaining = SEMANTIC_RETURNED_REFERENCE_EXPANSION_LIMIT;
    let budgeted = false;
    const reserve = (): boolean => {
      if (remaining > 0) {
        remaining -= 1;
        return true;
      }
      if (!budgeted) {
        state.valueResourceLimits.add("returned-reference-expansion");
        budgeted = true;
      }
      return false;
    };
    while (work.length > 0) {
      const task = work.pop();
      if (task === undefined) break;
      if (task.kind === "complete") {
        completeExpansion(task.frame, expanded);
        continue;
      }
      if (budgeted) break;
      const { item, parent } = task;
      const node = unwrapJavaScriptExpression(item.node).node;
      const pathKey = JSON.stringify(item.path);
      const covered = expanded
        .get(node)
        ?.get(pathKey)
        ?.find((context) => initializerChainCovers(item.initializers, context));
      if (covered !== undefined) {
        // Cached cycle dependencies must reach the caller's proof too.
        propagateBlockers(covered, parent);
        continue;
      }
      const frame: ExpansionFrame = {
        item,
        node,
        pathKey,
        parent,
        blockers: new Set(),
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
          if (initializerChainHas(item.initializers, initializer)) {
            frame.blockers.add(initializer);
            continue;
          }
          if (!reserve()) break;
          pending.push({
            node: initializer.node,
            path: [...initializer.projection, ...item.path],
            initializers: { parent: item.initializers, value: initializer },
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
        if (reserve())
          pending.push({
            ...item,
            node: receiver,
            path: [...path.reverse(), ...item.path],
          });
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
        const [key, ...path] = item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            if (reserve())
              pending.push({
                ...item,
                node: element.argument,
                path: [null, ...path],
              });
          } else if (
            (index === null || uncertainOffset || index === offset) &&
            reserve()
          )
            pending.push({ ...item, node: element, path });
        });
      } else if (t.isNewExpression(node)) {
        if (reserve()) pending.push({ ...item, node: node.callee });
      } else if (t.isClass(node)) {
        const [key, ...path] = item.path;
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
              pending.push({ ...item, node: member, path });
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
            pending.push({ ...item, node: member.value, path });
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
  const [key, ...path] = item.path;
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
          ...(t.isSpreadElement(unknown) ? {} : { path }),
        });
      }
      if (reserve())
        pending.push({
          ...item,
          node: t.isObjectProperty(property) ? property.value : property,
          path,
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
      pending.push({ ...item, node: property.value, path });
    else pending.push({ ...item, node: property, path });
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
