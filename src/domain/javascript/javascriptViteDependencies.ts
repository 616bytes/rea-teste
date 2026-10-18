import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  hasJavaScriptViteInheritedIndex,
  isJavaScriptViteDefaultUndefined,
  readJavaScriptViteHelper,
  type JavaScriptViteHelperCandidate,
} from "./javascriptViteHelper.js";
import { invalidateJavaScriptViteCachesSteps } from "./javascriptViteCacheOwnership.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import type { ParsedJavaScriptSource } from "./javascriptSourceParser.js";

type ViteDependencyTable = readonly (string | undefined)[];
type ViteDependencyCall = t.CallExpression | t.OptionalCallExpression;

/** resolve emitted Vite helpers by lexical identity without executing them. */
export function* classifyParsedJavaScriptViteDependencySpecifiersSteps(
  file: ParsedJavaScriptSource,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ReadonlyMap<ViteDependencyCall, ViteDependencyTable>> {
  const candidates: JavaScriptViteHelperCandidate[] = [];
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
      const candidate = readJavaScriptViteHelper(node, state);
      if (candidate !== undefined) candidates.push(candidate);
    },
  });
  const calls = new Map<ViteDependencyCall, ViteDependencyTable>();
  if (candidates.length === 0) return calls;
  const { tables, cacheHelpers } = yield* viteBindingTablesSteps(
    candidates,
    state,
  );
  const initializations = new Set<t.Node | undefined>();
  const admittedNodes = new WeakSet<t.Node>();
  for (const [
    index,
    { table, projection, cacheReads },
  ] of candidates.entries()) {
    if (index % 1024 === 0) yield;
    initializations.add(state.parentsByNode.get(table));
    admittedNodes.add(projection);
    // These exact guard reads address the admitted helper's own cache. Other
    // default expressions, including table contents, retain ordinary effects.
    for (const read of cacheReads) admittedNodes.add(read);
  }
  yield* invalidateJavaScriptViteCachesSteps(
    file.program,
    tables,
    cacheHelpers,
    initializations,
    admittedNodes,
    state,
  );
  const classifiedCalls: {
    readonly node: ViteDependencyCall;
    readonly table: ViteDependencyTable | null | undefined;
  }[] = [];
  yield* traverseJavaScriptAstSteps(file.program, {
    enter: (node) => {
      if (
        (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
        !t.isIdentifier(node.callee, { name: "__vite__mapDeps" })
      )
        return;
      const binding = resolveSemanticBindingState(
        state,
        node.callee,
        node.callee.name,
      );
      if (binding !== undefined && tables.has(binding.bindingId))
        classifiedCalls.push({ node, table: tables.get(binding.bindingId) });
    },
  });
  for (const [index, { node, table }] of classifiedCalls.entries()) {
    if (index % 1024 === 0) yield;
    calls.set(
      node,
      yield* selectedDependencySpecifiersSteps(node, table, state),
    );
  }
  return calls;
}

function* viteBindingTablesSteps(
  candidates: readonly JavaScriptViteHelperCandidate[],
  state: JavaScriptSemanticAnalysisState,
): Generator<
  void,
  {
    tables: Map<string, ViteDependencyTable | null>;
    cacheHelpers: Map<string, JavaScriptViteHelperCandidate>;
  }
> {
  const tables = new Map<string, ViteDependencyTable | null>();
  const cacheHelpers = new Map<string, JavaScriptViteHelperCandidate>();
  for (const [index, candidate] of candidates.entries()) {
    if (index % 1024 === 0) yield;
    const { name, helper, table, uncertain } = candidate;
    const binding = resolveSemanticBindingState(state, name, name.name);
    if (binding === undefined) continue;
    cacheHelpers.set(binding.bindingId, candidate);
    const initializer = semanticStableInitializer(binding, state);
    const unchanged =
      !uncertain &&
      initializer !== undefined &&
      unwrapJavaScriptExpression(initializer.node).node === helper &&
      initializer.projection.length === 0;
    tables.set(
      binding.bindingId,
      unchanged ? yield* exactTableSlotsSteps(table) : null,
    );
  }
  return { tables, cacheHelpers };
}

function* exactTableSlotsSteps(
  table: t.ArrayExpression,
): Generator<void, ViteDependencyTable> {
  const slots: (string | undefined)[] = [];
  for (const [index, element] of table.elements.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (t.isSpreadElement(element)) {
      // the known prefix cannot prove that the remaining cache is dense.
      slots.push(undefined);
      break;
    }
    const literal =
      element === null ? undefined : readExactJavaScriptLiteral(element);
    slots.push(
      literal?.found && typeof literal.value === "string"
        ? literal.value
        : undefined,
    );
  }
  return slots;
}

/** An inert unary index cannot execute code; unsupported slots stay unknown. */
const inertIndexSlot = (
  value: t.Node,
): { readonly numeric?: number } | undefined => {
  if (
    !t.isUnaryExpression(value) ||
    !(value.operator === "+" || value.operator === "-") ||
    !t.isNumericLiteral(value.argument)
  )
    return undefined;
  return {
    numeric:
      value.operator === "+" ? value.argument.value : -value.argument.value,
  };
};

function* selectedDependencySpecifiersSteps(
  node: ViteDependencyCall,
  table: ViteDependencyTable | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, ViteDependencyTable> {
  if (table == null || !(yield* usesDefaultTableSteps(node, state)))
    return [undefined];
  const argument = node.arguments[0];
  if (argument === undefined) return [undefined];
  const indexes = unwrapJavaScriptExpression(argument).node;
  if (!t.isArrayExpression(indexes)) return [undefined];
  const selected: (string | undefined)[] = [];
  for (const [index, element] of indexes.elements.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (element === null) {
      // native map visits inherited indexes even when the input has an elision.
      if (hasJavaScriptViteInheritedIndex(index, state))
        selected.push(undefined);
      continue;
    }
    const value = unwrapJavaScriptExpression(element).node;
    const inert = inertIndexSlot(value);
    if (
      !t.isIdentifier(value) &&
      !readExactJavaScriptLiteral(value).found &&
      inert === undefined
    )
      return [undefined];
    const numeric = t.isNumericLiteral(value) ? value.value : inert?.numeric;
    selected.push(
      numeric !== undefined && Number.isSafeInteger(numeric) && numeric >= 0
        ? table[numeric]
        : undefined,
    );
  }
  return selected;
}

function* usesDefaultTableSteps(
  node: ViteDependencyCall,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, boolean> {
  for (let index = 0; index < Math.min(node.arguments.length, 3); index++)
    if (t.isSpreadElement(node.arguments[index])) return false;
  for (const index of [1, 2]) {
    const argument = node.arguments[index];
    if (
      argument !== undefined &&
      !isJavaScriptViteDefaultUndefined(argument, state)
    )
      return false;
  }
  for (let index = 3; index < node.arguments.length; index++) {
    if (index % 1024 === 0) yield;
    const argument = node.arguments[index];
    if (
      argument === undefined ||
      (!readExactJavaScriptLiteral(argument).found &&
        !isJavaScriptViteDefaultUndefined(argument, state))
    )
      return false;
  }
  return true;
}
