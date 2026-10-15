import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import {
  createViteCacheReadProofSteps,
  type ViteCacheReadProof,
} from "./javascriptViteCacheReads.js";
import { ViteCacheIdentities } from "./javascriptViteCacheIdentities.js";
import type {
  ViteCacheAllocation,
  ViteCacheIdentity,
  ViteCacheWrite,
} from "./javascriptViteCacheIdentityTypes.js";
import { semanticObjectPropertyReferencesSteps } from "./javascriptSemanticObjectReferences.js";

type CacheTable = readonly (string | undefined)[];
type CachePath = readonly (string | null)[];
type Call = t.CallExpression | t.OptionalCallExpression;

const ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

const identityPaths = (
  identity: ViteCacheIdentity | undefined,
): readonly CachePath[] => {
  if (identity?.owner === undefined) return [];
  const allocation = identity.allocation;
  if (allocation?.kind === "container" || allocation?.kind === "foreign")
    return [];
  return [
    [
      allocation?.kind ?? "unknown",
      allocation?.kind === "helper"
        ? (allocation.owner ?? null)
        : identity.owner,
    ],
  ];
};

const numericSlot = (key: string | null | undefined): boolean =>
  key === null ||
  key === undefined ||
  key === "length" ||
  semanticArrayIndex(key) !== null;

const arrayInvocation = (
  invocation: JavaScriptIntrinsicInvocation | undefined,
): boolean =>
  invocation?.path.length === 4 &&
  invocation.path.slice(0, 3).join(".") === "intrinsic.Array.prototype";

/** invalidate admitted Vite caches through shared identity and mutation owners. */
export function* invalidateJavaScriptViteCachesSteps(
  program: t.Program,
  tables: Map<string, CacheTable | null>,
  initializations: ReadonlySet<t.Node | undefined>,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const interop = createSemanticModuleInterop(state);
  const identities = new ViteCacheIdentities(
    state,
    interop.intrinsicInvocation,
  );
  const objectPrototypeUncertain = yield* collectIntrinsicWritesSteps(
    program,
    interop,
  );
  const { writes, calls, constructors } = yield* indexCacheEffectsSteps(
    program,
    identities,
    initializations,
  );
  const reads = yield* createViteCacheReadProofSteps(tables, state, (node) =>
    identities.read(node),
  );
  const dataDefinitions = yield* retainObjectWritesSteps(calls, writes, {
    interop,
    state,
    objectPrototypeUncertain,
  });
  const context: CacheEffectContext = {
    identities,
    interop,
    reads,
    objectPrototypeUncertain,
    dataDefinitions,
    unsafeTargets: new Set(),
  };
  yield* identities.initializeSteps(tables.keys());
  yield* identities.solveSteps();
  context.unsafeTargets = yield* unsafeAssignmentTargetsSteps(
    { calls, constructors, writes },
    context,
  );
  const escapes = yield* indexCallExposuresSteps(calls, context);
  yield* retainConstructorExposuresSteps(constructors, escapes);
  let examined = 0;
  yield* identities.retainSnapshotsSteps(writes, escapes);
  yield* identities.solveSteps();
  let allOwners = false;
  const invalidate = (owner: string | null | undefined): void => {
    if (
      owner === null ||
      (owner !== undefined && identities.ambiguousCacheFamily)
    )
      allOwners = true;
    else if (owner !== undefined && tables.has(owner)) tables.set(owner, null);
  };
  const retain = (node: t.Node, path: CachePath): void => {
    if (initializations.has(node)) return;
    const [kind, owner, key] = path;
    reads.recordWrite(path);
    if (kind === "helper" && path.length > 2 && key !== "f" && key !== null)
      return;
    if (kind === "cache" && !numericSlot(key)) return;
    invalidate(owner);
  };
  for (const escape of escapes) {
    if (examined++ % 1024 === 0) yield;
    invalidate(identities.read(escape.value)?.owner);
  }
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (node, kind) =>
      kind === "member" ? identityPaths(identities.read(node)) : [],
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    retain,
  );
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    yield* retainCallEffectsSteps(call, context, invalidate);
  }
  for (const write of writes) {
    if (examined++ % 1024 === 0) yield;
    const receiver = identities.read(write.receiver);
    // storing a cache in an unresolved receiver exposes it to unexamined code.
    if (
      write.value !== undefined &&
      receiver?.allocation?.kind !== "container" &&
      receiver?.allocation?.kind !== "cache" &&
      receiver?.allocation?.kind !== "helper"
    )
      invalidate(identities.read(write.value)?.owner);
  }
  if (
    state.ambientWrites.covers(["global", "Function", "prototype", "f"]) ||
    state.ambientWrites.covers(["global", "Object", "prototype", "f"])
  )
    allOwners = true;
  if (allOwners)
    for (const owner of tables.keys()) {
      if (examined++ % 1024 === 0) yield;
      tables.set(owner, null);
    }
}

type Interop = ReturnType<typeof createSemanticModuleInterop>;

/** retain value exposure separately from known receiver mutation semantics. */
function* indexCallExposuresSteps(
  calls: readonly Call[],
  context: CacheEffectContext,
): Generator<void, { readonly node: t.Node; readonly value: t.Node }[]> {
  const exposures: { readonly node: t.Node; readonly value: t.Node }[] = [];
  let examined = 0;
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = context.interop.intrinsicInvocation(call);
    const path =
      invocation?.kind === "known" ? invocation.path.join(".") : undefined;
    if (
      (context.dataDefinitions.has(call) ||
        (path === "intrinsic.Object.assign" &&
          (yield* dataOnlyAssignSourcesSteps(
            invocation?.arguments,
            context,
          )))) &&
      (yield* freshAssignDestinationSteps(invocation?.arguments?.[0], context))
    )
      continue;
    const values =
      invocation?.kind === "known"
        ? (invocation.arguments ?? call.arguments)
        : call.arguments;
    const selected = intrinsicValuePositions(path);
    for (let index = 0; index < values.length; index++) {
      if (examined++ % 1024 === 0) yield;
      if (selected !== undefined && !selected.has(index)) continue;
      if (path === "intrinsic.Object.assign" && index === 0) continue;
      if (path === "intrinsic.Object.create" && index === 0) continue;
      const value = values[index];
      if (
        path === "intrinsic.Object.assign" &&
        value !== undefined &&
        context.identities.read(
          t.isSpreadElement(value) ? value.argument : value,
        )?.owner === undefined
      )
        continue;
      if (value !== undefined)
        exposures.push({
          node: call,
          value: t.isSpreadElement(value) ? value.argument : value,
        });
    }
  }
  return exposures;
}

function* dataOnlyAssignSourcesSteps(
  values: JavaScriptIntrinsicInvocation["arguments"],
  context: CacheEffectContext,
): Generator<void, boolean> {
  if (values === undefined || context.objectPrototypeUncertain) return false;
  let examined = 0;
  for (let index = 1; index < values.length; index++) {
    if (examined++ % 1024 === 0) yield;
    const source = values[index];
    if (source === undefined || t.isSpreadElement(source)) return false;
    const allocation = context.identities.read(source)?.allocation;
    if (allocation === null || allocation === undefined) return false;
    if (context.unsafeTargets.has(allocation)) return false;
    if (allocation.kind === "helper" || allocation.kind === "cache") continue;
    if (
      allocation.kind !== "container" ||
      !t.isObjectExpression(allocation.node) ||
      !(yield* ordinaryObjectLiteralSteps(allocation.node))
    )
      return false;
  }
  return true;
}

/** a proven data-only literal allocation cannot dispatch to an unexamined setter. */
function* freshAssignDestinationSteps(
  target: t.Node | undefined,
  context: CacheEffectContext,
): Generator<void, boolean> {
  if (
    context.objectPrototypeUncertain ||
    target === undefined ||
    t.isSpreadElement(target)
  )
    return false;
  const allocation = context.identities.read(target)?.allocation;
  if (
    allocation?.kind !== "container" ||
    context.unsafeTargets.has(allocation) ||
    !t.isObjectExpression(allocation.node)
  )
    return false;
  return yield* ordinaryObjectLiteralSteps(allocation.node);
}

function* ordinaryObjectLiteralSteps(
  expression: t.ObjectExpression,
): Generator<void, boolean> {
  let examined = 0;
  for (const property of expression.properties) {
    if (examined++ % 1024 === 0) yield;
    if (
      !t.isObjectProperty(property) &&
      !(t.isObjectMethod(property) && property.kind === "method")
    )
      return false;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null || key === "__proto__") return false;
  }
  return true;
}

function* unsafeAssignmentTargetsSteps(
  events: {
    readonly calls: readonly Call[];
    readonly constructors: readonly t.NewExpression[];
    readonly writes: readonly ViteCacheWrite[];
  },
  context: CacheEffectContext,
): Generator<void, ReadonlySet<ViteCacheAllocation>> {
  const inputs: t.Node[] = [];
  let examined = 0;
  for (const write of events.writes) {
    if (examined++ % 1024 === 0) yield;
    if (
      write.propertySource === undefined &&
      (write.key === null || write.key === "__proto__")
    )
      inputs.push(write.receiver);
  }
  for (const call of events.calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = context.interop.intrinsicInvocation(call);
    const path =
      invocation?.kind === "known" ? invocation.path.join(".") : undefined;
    if (
      path === "intrinsic.Object.assign" ||
      path === "intrinsic.Object.create" ||
      context.dataDefinitions.has(call) ||
      context.identities.read(call.callee)?.allocation?.kind === "helper"
    )
      continue;
    for (const argument of invocation?.arguments ?? call.arguments) {
      if (examined++ % 1024 === 0) yield;
      inputs.push(t.isSpreadElement(argument) ? argument.argument : argument);
    }
    const direct = directArrayMethod(call);
    if (direct !== undefined && invocation === undefined)
      inputs.push(direct.receiver);
  }
  for (const constructor of events.constructors)
    for (const argument of constructor.arguments) {
      if (examined++ % 1024 === 0) yield;
      inputs.push(t.isSpreadElement(argument) ? argument.argument : argument);
    }
  return yield* context.identities.escapedAllocationsSteps(inputs);
}

function* retainConstructorExposuresSteps(
  constructors: readonly t.NewExpression[],
  exposures: { readonly node: t.Node; readonly value: t.Node }[],
): Generator<void> {
  let examined = 0;
  for (const constructor of constructors) {
    if (examined++ % 1024 === 0) yield;
    for (const argument of constructor.arguments) {
      if (examined++ % 1024 === 0) yield;
      exposures.push({
        node: constructor,
        value: t.isSpreadElement(argument) ? argument.argument : argument,
      });
    }
  }
}

const intrinsicValuePositions = (
  path: string | undefined,
): ReadonlySet<number> | undefined => {
  if (
    path === "intrinsic.Reflect.set" ||
    path === "intrinsic.Object.defineProperty" ||
    path === "intrinsic.Reflect.defineProperty"
  )
    return new Set([2]);
  if (
    path === "intrinsic.Object.defineProperties" ||
    path === "intrinsic.Object.setPrototypeOf" ||
    path === "intrinsic.Reflect.setPrototypeOf"
  )
    return new Set([1]);
  if (path === "intrinsic.Reflect.deleteProperty") return new Set();
  return undefined;
};

/** normalize supported object writes once while preserving their target identity. */
function* retainObjectWritesSteps(
  calls: readonly Call[],
  writes: ViteCacheWrite[],
  context: {
    readonly interop: Interop;
    readonly state: JavaScriptSemanticAnalysisState;
    readonly objectPrototypeUncertain: boolean;
  },
): Generator<void, ReadonlySet<Call>> {
  const { interop } = context;
  const dataDefinitions = new Set<Call>();
  let examined = 0;
  for (const call of calls) {
    if (examined++ % 1024 === 0) yield;
    const invocation = interop.intrinsicInvocation(call);
    if (invocation?.kind !== "known") continue;
    const path = invocation.path.join(".");
    if (
      path === "intrinsic.Object.defineProperty" ||
      path === "intrinsic.Reflect.defineProperty"
    ) {
      const target = invocation.arguments?.[0];
      const key = interop.staticString(invocation.arguments?.[1]);
      const value = yield* dataDescriptorValueSteps(
        invocation.arguments?.[2],
        context,
      );
      if (t.isExpression(target) && key !== undefined && value !== undefined) {
        writes.push({ node: call, receiver: target, key, value });
        dataDefinitions.add(call);
      }
      continue;
    }
    if (path !== "intrinsic.Object.assign") continue;
    const target = invocation.arguments?.[0];
    if (!t.isExpression(target)) continue;
    const properties: t.SpreadElement[] = [];
    for (const source of invocation.arguments?.slice(1) ?? []) {
      if (examined++ % 1024 === 0) yield;
      properties.push(
        t.spreadElement(
          t.isSpreadElement(source)
            ? source.argument
            : t.isExpression(source)
              ? source
              : t.identifier("undefined"),
        ),
      );
    }
    const value = t.objectExpression(properties);
    writes.push({
      node: call,
      receiver: target,
      key: null,
      value,
      propertySource: value,
    });
  }
  return dataDefinitions;
}

function* dataDescriptorValueSteps(
  node: t.Node | undefined,
  context: {
    readonly state: JavaScriptSemanticAnalysisState;
    readonly objectPrototypeUncertain: boolean;
  },
): Generator<void, t.Node | undefined> {
  if (node === undefined || context.objectPrototypeUncertain) return undefined;
  const descriptor = unwrapJavaScriptExpression(node).node;
  if (
    !t.isObjectExpression(descriptor) ||
    !(yield* ordinaryObjectLiteralSteps(descriptor))
  )
    return undefined;
  let examined = 0;
  for (const property of descriptor.properties) {
    if (examined++ % 1024 === 0) yield;
    if (!t.isObjectProperty(property)) return undefined;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== "value" &&
      key !== "writable" &&
      key !== "enumerable" &&
      key !== "configurable"
    )
      return undefined;
  }
  const references = yield* semanticObjectPropertyReferencesSteps(
    descriptor,
    ["value"],
    context.state,
  );
  const reference = references[0];
  return references.length === 1 && reference?.path.length === 0
    ? reference.node
    : undefined;
}
interface CacheEffectContext {
  readonly identities: ViteCacheIdentities;
  readonly interop: Interop;
  readonly reads: ViteCacheReadProof;
  readonly objectPrototypeUncertain: boolean;
  readonly dataDefinitions: ReadonlySet<Call>;
  unsafeTargets: ReadonlySet<ViteCacheAllocation>;
}

function* indexCacheEffectsSteps(
  program: t.Program,
  identities: ViteCacheIdentities,
  initializations: ReadonlySet<t.Node | undefined>,
): Generator<
  void,
  { writes: ViteCacheWrite[]; calls: Call[]; constructors: t.NewExpression[] }
> {
  const writes: ViteCacheWrite[] = [];
  const calls: Call[] = [];
  const constructors: t.NewExpression[] = [];
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node) => {
      if (t.isExpression(node)) identities.normalize(node);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        calls.push(node);
      if (t.isNewExpression(node)) constructors.push(node);
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node)
          ? node.argument
          : t.isUnaryExpression(node, { operator: "delete" })
            ? node.argument
            : t.isForOfStatement(node) || t.isForInStatement(node)
              ? node.left
              : undefined;
      if (target === undefined || initializations.has(node)) return;
      for (const leaf of semanticWriteTargets(target)) {
        const member = unwrapJavaScriptExpression(leaf).node;
        if (
          !t.isMemberExpression(member) &&
          !t.isOptionalMemberExpression(member)
        )
          continue;
        writes.push({
          node,
          receiver: member.object,
          key: semanticStaticPropertyKey(member.property, member.computed),
          ...(t.isAssignmentExpression(node, { operator: "=" })
            ? { value: node.right }
            : {}),
        });
      }
    },
  });
  return { writes, calls, constructors };
}

function* collectIntrinsicWritesSteps(
  program: t.Program,
  interop: Interop,
): Generator<void, boolean> {
  let objectPrototypeUncertain = false;
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (node, kind) => {
      if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
      if (kind === "binding") return [];
      const { root, members } = electronMemberPath(node);
      const path =
        interop.intrinsicPath(root) ?? interop.boundIntrinsic(root)?.path;
      return path === undefined ? [] : [[...path, ...members]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      const [root, namespace, property] = path;
      if (
        root === "opaque-intrinsic" ||
        (root === "intrinsic" &&
          (namespace === undefined ||
            namespace === null ||
            namespace === "Object") &&
          (property === undefined ||
            property === null ||
            property === "prototype"))
      )
        objectPrototypeUncertain = true;
      interop.retainWrite(node, path);
    },
  );
  return objectPrototypeUncertain;
}

const directArrayMethod = (
  call: Call,
):
  | { readonly receiver: t.Node; readonly method: string | null }
  | undefined => {
  const callee = unwrapJavaScriptExpression(call.callee).node;
  return t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
    ? {
        receiver: callee.object,
        method: semanticStaticPropertyKey(callee.property, callee.computed),
      }
    : undefined;
};

function* retainCallEffectsSteps(
  call: Call,
  context: CacheEffectContext,
  invalidate: (owner: string | null | undefined) => void,
): Generator<void> {
  const { identities, interop, reads } = context;
  const invocation = interop.intrinsicInvocation(call);
  const direct = directArrayMethod(call);
  if (direct !== undefined && invocation?.kind !== "known") {
    if (
      !(yield* reads.isReadSteps(
        direct.receiver,
        direct.method,
        call.arguments,
      ))
    )
      invalidate(identities.read(direct.receiver)?.owner);
  }
  if (!arrayInvocation(invocation) || invocation?.receiver === undefined)
    return;
  const receiver = identities.read(invocation.receiver);
  const method = invocation.path.at(-1) ?? null;
  if (
    invocation.kind === "known" &&
    receiver?.allocation?.kind === "helper" &&
    ARRAY_MUTATORS.has(method ?? "")
  )
    return;
  if (
    invocation.kind !== "known" ||
    !(yield* reads.isReadSteps(
      invocation.receiver,
      method,
      invocation.arguments,
      true,
    ))
  )
    invalidate(receiver?.owner);
}
