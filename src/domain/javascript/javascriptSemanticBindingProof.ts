import * as t from "@babel/types";

import { runtimeFunctionParameters } from "./javascriptAstValues.js";
import { createSemanticCallableStack } from "./javascriptSemanticCallableStack.js";
import { collectSemanticReferences } from "./javascriptSemanticProjection.js";
import {
  semanticBindingLookupAt,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

interface BindingProofExposure {
  readonly lexicalEval: boolean;
  readonly globalObject: boolean;
  readonly mappedArgumentScopes: ReadonlySet<string>;
}

// These facts describe the fixed source and lexical index, independently of
// which proof consumer or identifier read asks first.
const exposureByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  BindingProofExposure
>();

const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "window", "self"]);

/**
 * Source order selects explicit writes; it cannot exclude writes through eval,
 * a mapped arguments object, or an exposed classic-script global environment.
 * Every identifier hop in a complete value proof must consult the same owner.
 */
export const semanticBindingProofExposure = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState | undefined,
): string | undefined => {
  const exposure = sourceBindingProofExposure(state);
  if (exposure.lexicalEval)
    return "A lexical eval reference may replace source bindings.";
  if (binding === undefined) return undefined;
  if (
    exposure.mappedArgumentScopes.has(binding.scopeId) &&
    binding.definitions.some(({ kind }) => kind === "parameter")
  )
    return `Parameter ${binding.name} may be replaced through its mapped arguments object.`;
  if (
    exposure.globalObject &&
    state.scopesById.get(binding.scopeId)?.kind === "program"
  )
    return `Script binding ${binding.name} may be replaced through the exposed global object.`;
  return undefined;
};

const sourceBindingProofExposure = (
  state: JavaScriptSemanticAnalysisState,
): BindingProofExposure => {
  const cached = exposureByState.get(state);
  if (cached !== undefined) return cached;
  const references = collectSemanticReferences(state.program, state);
  const lexicalEval = references.some(({ name }) => name === "eval");
  // Reference classification belongs to the lexical index. In particular,
  // property names and declarations do not expose objects.
  const relevantSites = new Set(
    references
      .filter(
        ({ name }) => name === "arguments" || GLOBAL_OBJECT_NAMES.has(name),
      )
      .map(({ location }) =>
        referenceSite(location.start.line, location.start.column),
      ),
  );
  const mappedArgumentScopes = new Set<string>();
  const callableStack = createSemanticCallableStack((id) =>
    state.callableNodesById.get(id),
  );
  const mappedOwners = new WeakMap<t.Function, string | null>();
  let globalObject = false;
  traverseJavaScriptAst(state.program, {
    enter(node, parent) {
      callableStack.enter(node, parent);
      if (
        state.program.sourceType === "script" &&
        t.isThisExpression(node) &&
        mayExposeGlobalThis(node, state)
      )
        globalObject = true;
      if (
        !t.isIdentifier(node) ||
        node.loc == null ||
        !relevantSites.has(
          referenceSite(node.loc.start.line, node.loc.start.column),
        )
      )
        return;
      if (GLOBAL_OBJECT_NAMES.has(node.name)) {
        const lookup = semanticBindingLookupAt(state, node, node.name);
        if (
          state.program.sourceType === "script" &&
          // A `with` lookup may still select the ambient global object.
          (lookup.kind !== "binding" ||
            (lookup.binding.declarationKinds.has("var") &&
              state.scopesById.get(lookup.binding.scopeId)?.kind === "program"))
        )
          globalObject = true;
        return;
      }
      const owner = callableStack.callables.findLast(
        (callable): callable is t.Function =>
          t.isFunction(callable) && !t.isArrowFunctionExpression(callable),
      );
      const scopeId = mappedArgumentsScope(node, owner, state, mappedOwners);
      if (scopeId !== null) mappedArgumentScopes.add(scopeId);
    },
    exit(node) {
      callableStack.exit(node);
    },
  });
  const exposure = { lexicalEval, globalObject, mappedArgumentScopes };
  exposureByState.set(state, exposure);
  return exposure;
};

const mappedArgumentsScope = (
  reference: t.Identifier,
  owner: t.Function | undefined,
  state: JavaScriptSemanticAnalysisState,
  mappedOwners: WeakMap<t.Function, string | null>,
): string | null => {
  if (owner === undefined) return null;
  let scopeId = mappedOwners.get(owner);
  if (scopeId === undefined) {
    scopeId =
      runtimeFunctionParameters(owner).every((parameter) =>
        t.isIdentifier(parameter),
      ) && !isStrictFunction(owner, state)
        ? (state.scopeByNode.get(owner)?.scopeId ?? null)
        : null;
    mappedOwners.set(owner, scopeId);
  }
  if (scopeId === null) return null;
  const lookup = semanticBindingLookupAt(state, reference, "arguments");
  const shadow = "binding" in lookup ? lookup.binding : undefined;
  if (
    shadow !== undefined &&
    bindingWithinScope(shadow, scopeId, state) &&
    (shadow.scopeId !== scopeId ||
      shadow.definitions.some(
        ({ kind }) =>
          kind !== "variable" && kind !== "assignment" && kind !== "function",
      ) ||
      [...shadow.declarationKinds].some((kind) => kind !== "var") ||
      shadow.initializers.some(
        ({ node }) =>
          t.isFunctionDeclaration(node) &&
          state.parentsByNode.get(node) === owner.body,
      ))
  )
    return null;
  // An implicit arguments binding shadows OUTER declarations, including a
  // named function expression's private name. Only bindings within this
  // function can replace it. A bare `var arguments;` preserves the object.
  // Legacy conditional function declarations may retain that object too;
  // only a direct body declaration replaces it during function entry.
  return scopeId;
};

const referenceSite = (line: number, column: number): string =>
  `${String(line)}:${String(column)}`;

const bindingWithinScope = (
  binding: JavaScriptSemanticBindingState,
  scopeId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let scope = state.scopesById.get(binding.scopeId);
  while (scope !== undefined) {
    if (scope.scopeId === scopeId) return true;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return false;
};

const isStrictFunction = (
  node: t.Function,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (
      t.isClass(current) ||
      (t.isProgram(current) && current.sourceType === "module") ||
      (t.isProgram(current) &&
        current.directives.some(({ value }) => value.value === "use strict")) ||
      (t.isFunction(current) &&
        t.isBlockStatement(current.body) &&
        current.body.directives.some(
          ({ value }) => value.value === "use strict",
        ))
    )
      return true;
    current = state.parentsByNode.get(current);
  }
  return false;
};

/**
 * Sloppy ordinary calls may select the global receiver. Arrow this and
 * computed class/method keys inherit the enclosing receiver instead. A source
 * method may be extracted, so its observed call syntax does not exclude this
 * exposure; strict, module, and class-owned receivers remain independent.
 */
const mayExposeGlobalThis = (
  node: t.ThisExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let child: t.Node = node;
  let parent = state.parentsByNode.get(child);
  while (parent !== undefined) {
    if (
      t.isFunction(parent) &&
      !t.isArrowFunctionExpression(parent) &&
      !(
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.computed &&
        parent.key === child
      )
    )
      return !isStrictFunction(parent, state);
    if (
      t.isStaticBlock(parent) ||
      ((t.isClassProperty(parent) ||
        t.isClassPrivateProperty(parent) ||
        t.isClassAccessorProperty(parent)) &&
        parent.value === child)
    )
      return false;
    child = parent;
    parent = state.parentsByNode.get(parent);
  }
  return true;
};
