import * as t from "@babel/types";

import type {
  JavaScriptSemanticArgumentFlow,
  JavaScriptSemanticCallable,
} from "./javascriptSemanticIr.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import {
  SEMANTIC_EXPRESSION_DEPTH_LIMIT,
  SEMANTIC_CALLABLE_EXPANSION_LIMIT,
  semanticResourceLimitReason,
} from "./javascriptSemanticResourceLimits.js";
import { semanticBindingProofExposure } from "./javascriptSemanticBindingProof.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  unwrapJavaScriptExpression,
  runtimeFunctionParameters,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

/** Resolution of one call target within the currently analyzed source. */
export interface LocalCallableResolution {
  readonly callableIds: readonly string[];
  readonly complete: boolean;
  readonly reason: string;
  /** A cycle cut depends on the active alias path and cannot be memoized. */
  readonly cycleDependent?: true;
  /** A depth cut can hide a cycle that would change work on another path. */
  readonly depthDependent?: true;
  /** Exhausted work depends on the caller's remaining query budget. */
  readonly budgetDependent?: true;
}

/** A cached read retains the proof work it replaces, as well as consumed depth. */
export type LocalCallableResolutionCache = WeakMap<
  t.Identifier,
  Map<
    number,
    { readonly resolution: LocalCallableResolution; readonly work: number }
  >
>;

interface CallResolutionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly activeInitializers: Set<JavaScriptSemanticInitializer>;
  readonly budget: { remaining: number };
  readonly bindingCache: LocalCallableResolutionCache;
}

/** Inputs needed to resolve one local call target. */
export interface ResolveLocalCallablesInput {
  readonly node: t.Node;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly bindingCache: LocalCallableResolutionCache;
}

/** Resolve local callable candidates without following dynamic properties. */
export const resolveLocalCallables = (
  input: ResolveLocalCallablesInput,
): LocalCallableResolution =>
  resolveCallables(
    input.node,
    {
      state: input.state,
      callableById: input.callableById,
      activeInitializers: new Set(),
      budget: { remaining: SEMANTIC_CALLABLE_EXPANSION_LIMIT },
      bindingCache: input.bindingCache,
    },
    0,
  );

const resolveCallables = (
  input: t.Node,
  context: CallResolutionContext,
  depth: number,
): LocalCallableResolution => {
  if (context.budget.remaining === 0) {
    context.state.valueResourceLimits.add("callable-expansion");
    return {
      callableIds: [],
      complete: false,
      budgetDependent: true,
      reason: semanticResourceLimitReason("callable-expansion"),
    };
  }
  context.budget.remaining--;
  const unwrapped = unwrapJavaScriptExpression(input);
  const node = unwrapped.node;
  depth += unwrapped.depth;
  if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
    context.state.valueResourceLimits.add("expression-depth");
    return {
      callableIds: [],
      complete: false,
      depthDependent: true,
      reason: semanticResourceLimitReason("expression-depth"),
    };
  }
  const direct = semanticCallableIdForNode(node);
  if (direct !== null && context.callableById.has(direct))
    return {
      callableIds: [direct],
      complete: true,
      reason: "Direct local callable.",
    };
  if (t.isIdentifier(node)) return resolveIdentifier(node, context, depth);
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node))
    return resolveAlternatives(
      t.isConditionalExpression(node) ? node.consequent : node.left,
      t.isConditionalExpression(node) ? node.alternate : node.right,
      context,
      depth + 1,
    );
  return {
    callableIds: [],
    complete: false,
    reason: `Unsupported ${node.type} call target.`,
  };
};

const resolveIdentifier = (
  node: t.Identifier,
  context: CallResolutionContext,
  depth: number,
): LocalCallableResolution => {
  const cached = context.bindingCache.get(node)?.get(depth);
  // Charge the same semantic work on a cache hit. Otherwise warming a shared
  // subtree could turn an exhausted cold proof into a complete warm proof.
  if (cached !== undefined && cached.work <= context.budget.remaining) {
    context.budget.remaining -= cached.work;
    return cached.resolution;
  }
  const remainingBefore = context.budget.remaining;
  const binding = resolveSemanticBindingState(context.state, node, node.name);
  if (binding === undefined)
    return {
      callableIds: [],
      complete: false,
      reason: `Unresolved call target ${node.name}.`,
    };
  const read = semanticBindingAtRead(
    binding,
    node,
    context.state.parentsByNode,
  );
  const candidates = resolveBindingCallables(read.binding, context, depth + 1);
  const exposure = semanticBindingProofExposure(context.state, binding);
  // Knowing every local candidate does not prove that any write replaced the
  // incoming value, or that a write in another activation precedes this read.
  const covered =
    read.hasDefiniteInitializer ||
    semanticStableInitializer(binding, context.state) !== undefined;
  const resolution =
    exposure !== undefined
      ? { ...candidates, complete: false, reason: exposure }
      : candidates.complete && !covered
        ? {
            ...candidates,
            complete: false,
            reason: `Call target ${binding.name} may retain an incoming value or an unordered assignment.`,
          }
        : candidates;
  // Immutable reads and depth distinguish temporal snapshots and remaining
  // nesting. Truncated paths may hide active cycles, so neither those results
  // nor explicit cycle cuts or exhausted work can be reused across entry paths.
  if (
    !resolution.cycleDependent &&
    !resolution.depthDependent &&
    !resolution.budgetDependent
  ) {
    const depths = context.bindingCache.get(node) ?? new Map();
    depths.set(depth, {
      resolution,
      work: remainingBefore - context.budget.remaining,
    });
    context.bindingCache.set(node, depths);
  }
  return resolution;
};

const resolveAlternatives = (
  left: t.Node,
  right: t.Node,
  context: CallResolutionContext,
  depth: number,
): LocalCallableResolution => {
  const candidates = [left, right].map((candidate) =>
    resolveCallables(candidate, context, depth),
  );
  return {
    callableIds: uniqueCallableIds(
      candidates.flatMap(({ callableIds }) => callableIds),
    ),
    complete: candidates.every(({ complete }) => complete),
    reason: "Conditional or logical call target has multiple candidates.",
    ...(candidates.some((candidate) => candidate.cycleDependent)
      ? { cycleDependent: true as const }
      : {}),
    ...(candidates.some((candidate) => candidate.depthDependent)
      ? { depthDependent: true as const }
      : {}),
    ...(candidates.some((candidate) => candidate.budgetDependent)
      ? { budgetDependent: true as const }
      : {}),
  };
};

const resolveBindingCallables = (
  binding: JavaScriptSemanticBindingState,
  context: CallResolutionContext,
  depth: number,
): LocalCallableResolution => {
  if (binding.initializers.length === 0)
    return missingBindingInitializer(binding);
  const candidates = binding.initializers.map(
    (initializer): LocalCallableResolution => {
      if (context.activeInitializers.has(initializer))
        return {
          callableIds: [],
          complete: false,
          cycleDependent: true,
          reason: `Call target initializer cycle at ${binding.name}.`,
        };
      if (initializer.projection.length !== 0)
        return {
          callableIds: [],
          complete: false,
          reason: `Projected call target ${binding.name} is unresolved.`,
        };
      context.activeInitializers.add(initializer);
      try {
        return resolveCallables(initializer.node, context, depth);
      } finally {
        context.activeInitializers.delete(initializer);
      }
    },
  );
  const callableIds = uniqueCallableIds(
    candidates.flatMap((candidate) => candidate.callableIds),
  );
  const resolution = {
    callableIds,
    complete: candidates.every(({ complete }) => complete),
    reason:
      callableIds.length === 1 && candidates.every(({ complete }) => complete)
        ? "Unique local callable target."
        : `Call target ${binding.name} has ambiguous or unsupported assignments.`,
    ...(candidates.some((candidate) => candidate.cycleDependent)
      ? { cycleDependent: true as const }
      : {}),
    ...(candidates.some((candidate) => candidate.depthDependent)
      ? { depthDependent: true as const }
      : {}),
    ...(candidates.some((candidate) => candidate.budgetDependent)
      ? { budgetDependent: true as const }
      : {}),
  };
  return resolution;
};

const missingBindingInitializer = (
  binding: JavaScriptSemanticBindingState,
): LocalCallableResolution => ({
  callableIds: [],
  complete: false,
  reason:
    binding.kind === "import"
      ? `Call target ${binding.name} is imported from outside this source.`
      : `Call target ${binding.name} has no local initializer.`,
});

/** Find all bindings introduced by one positional parameter pattern. */
export const parameterBindings = (
  callable: JavaScriptSemanticCallable,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState[] => {
  if (callable.bodyScopeId === null) return [];
  const scope = state.scopesById.get(callable.bodyScopeId);
  if (scope === undefined) return [];
  return [...scope.bindings.values()]
    .filter(
      (binding) =>
        binding.kind === "parameter" &&
        binding.definitions.some(
          ({ kind, location }) =>
            kind === "parameter" &&
            parameterAcceptsArgument(callable, location, index, state),
        ),
    )
    .sort((left, right) =>
      compareUnicodeCodePoints(left.bindingId, right.bindingId),
    );
};

const parameterAcceptsArgument = (
  callable: JavaScriptSemanticCallable,
  location: JavaScriptSemanticArgumentFlow["parameterLocation"],
  argumentIndex: number,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const node = state.callableNodesById.get(callable.callableId);
  if (!t.isFunction(node)) return false;
  const parameters = runtimeFunctionParameters(node);
  const parameterIndex = parameters.findIndex((parameter) =>
    rangeContains(range(parameter), location),
  );
  if (parameterIndex === argumentIndex) return true;
  return (
    parameterIndex >= 0 &&
    parameterIndex < argumentIndex &&
    t.isRestElement(parameters[parameterIndex])
  );
};

const rangeContains = (
  outer: JavaScriptSemanticArgumentFlow["parameterLocation"],
  inner: JavaScriptSemanticArgumentFlow["parameterLocation"],
): boolean =>
  (outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line &&
      outer.start.column <= inner.start.column)) &&
  (outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line &&
      outer.end.column >= inner.end.column));

const uniqueCallableIds = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);
