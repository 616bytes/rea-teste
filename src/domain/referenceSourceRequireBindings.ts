import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascript/javascriptAstValues.js";
import { analyzeParsedJavaScriptReferences } from "./javascript/javascriptSemanticAnalysis.js";
import {
  semanticBindingId,
  semanticScopeId,
} from "./javascript/javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascript/javascriptSemanticTraversal.js";
import type { JavaScriptSemanticReference } from "./javascript/javascriptSemanticIr.js";
import {
  isExplicitModuleSourcePath,
  type ParsedJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";

/**
 * Keep calls that resolve either to Node's CommonJS wrapper loader or to a
 * direct ESM `createRequire(import.meta.url)` binding. The shared lexical
 * analyzer supplies binding ownership; this boundary accounts for the two
 * Node loader bindings without evaluating arbitrary values.
 */
export const unshadowedReferenceSourceRequireCalls = (
  file: Pick<ParsedJavaScriptSource, "program">,
  path: string,
): ReadonlySet<t.CallExpression> => {
  const references = new Map(
    analyzeParsedJavaScriptReferences(file).map((reference) => [
      `${reference.location.start.line}:${reference.location.start.column}`,
      reference,
    ]),
  );
  const programRequireBinding = semanticBindingId(
    semanticScopeId("program", file.program),
    "require",
  );
  // Syntax alone cannot establish Node's runtime mode: `.js` depends on its
  // package scope, and `.ts` may be compiled with a CommonJS module target.
  // Keep unmarked paths runtime-unknown and preserve candidate require edges.
  const allowsUnboundRequire = !isExplicitModuleSourcePath(path);
  const hasTopLevelVarRequire =
    allowsUnboundRequire && hasUninitializedTopLevelVarRequire(file.program);
  const createRequireBinding = directCreateRequireBinding(
    file.program,
    references,
  );
  const hasRequireWrite = [...references.values()].some(
    (reference) => reference.name === "require" && reference.role === "write",
  );
  const requireLoaderWasWritten =
    hasRequireWrite &&
    loaderWriteReachesProgramScope(
      file.program,
      references,
      programRequireBinding,
    );
  const isLoaderReference = (identifier: t.Identifier): boolean => {
    const start = identifier.loc?.start;
    const reference =
      start === undefined
        ? undefined
        : references.get(`${start.line}:${start.column}`);
    return (
      (allowsUnboundRequire && reference?.resolution === "unbound") ||
      (reference?.resolution === "resolved" &&
        reference.bindingId === programRequireBinding)
    );
  };
  const loaderMembersIntact = requireLoaderMembersIntact(
    file.program,
    isLoaderReference,
  );
  const calls = new Set<t.CallExpression>();

  traverseJavaScriptAst(file.program, {
    enter: (node, _parent, readAncestors) => {
      if (!t.isCallExpression(node)) return;
      const identifier = requireCalleeIdentifier(node.callee);
      const start = identifier?.loc?.start;
      if (start === undefined) return;
      if (
        readAncestors().some(
          (ancestor) =>
            t.isWithStatement(ancestor) && contains(ancestor.body, node),
        )
      )
        return;
      // `require.resolve` and `require.main` denote Node's members only
      // while no visible write or escape can have replaced them.
      if (!t.isIdentifier(node.callee) && !loaderMembersIntact) return;
      const reference = references.get(`${start.line}:${start.column}`);
      if (
        (allowsUnboundRequire &&
          !requireLoaderWasWritten &&
          reference?.resolution === "unbound") ||
        (((hasTopLevelVarRequire && !requireLoaderWasWritten) ||
          createRequireBinding) &&
          reference?.resolution === "resolved" &&
          reference.bindingId === programRequireBinding)
      )
        calls.add(node);
    },
  });
  return calls;
};

/**
 * Whether the loader's `resolve` and `main` members keep Node's identity. A
 * write to either member or to a computed member, or `require` used as a
 * value other than a call or member read (where a mutator or alias can
 * replace members), leaves that identity unknown.
 */
const requireLoaderMembersIntact = (
  program: t.Program,
  isLoaderReference: (identifier: t.Identifier) => boolean,
): boolean => {
  let intact = true;
  const isLoaderMemberTarget = (target: t.Node): boolean => {
    if (!t.isMemberExpression(target) && !t.isOptionalMemberExpression(target))
      return false;
    const object = unwrapJavaScriptExpression(target.object).node;
    if (!t.isIdentifier(object, { name: "require" })) return false;
    if (!isLoaderReference(object)) return false;
    const key = semanticStaticPropertyKey(target.property, target.computed);
    return key === null || key === "resolve" || key === "main";
  };
  traverseJavaScriptAst(program, {
    enter: (node, parent, readAncestors) => {
      if (!intact) return;
      const site = semanticWriteSiteTarget(node);
      if (site !== null) {
        for (const target of semanticWriteTargets(site))
          if (isLoaderMemberTarget(target)) intact = false;
        return;
      }
      if (
        !t.isIdentifier(node, { name: "require" }) ||
        parent === null ||
        !isLoaderReference(node)
      )
        return;
      // Inert parentheses and TypeScript wrappers do not change how the
      // loader value is used.
      let used: t.Node = node;
      let user: t.Node | undefined = parent;
      const read = readAncestors();
      const ancestors = read.at(-1) === parent ? read : [...read, parent];
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        user = ancestors[index];
        if (
          user === undefined ||
          unwrapJavaScriptExpression(user).node !== node
        )
          break;
        used = user;
      }
      const usedAsLoader =
        ((t.isCallExpression(user) || t.isOptionalCallExpression(user)) &&
          user.callee === used) ||
        ((t.isMemberExpression(user) || t.isOptionalMemberExpression(user)) &&
          user.object === used) ||
        t.isUnaryExpression(user, { operator: "typeof" });
      if (!usedAsLoader) intact = false;
    },
  });
  return intact;
};

const contains = (container: t.Node, node: t.Node): boolean =>
  typeof container.start === "number" &&
  typeof container.end === "number" &&
  typeof node.start === "number" &&
  typeof node.end === "number" &&
  container.start <= node.start &&
  node.end <= container.end;

const loaderWriteReachesProgramScope = (
  program: t.Program,
  references: ReadonlyMap<string, JavaScriptSemanticReference>,
  programRequireBinding: string,
): boolean => {
  let reached = false;
  traverseJavaScriptAst(program, {
    enter: (node, _parent, readAncestors) => {
      if (reached || !t.isIdentifier(node, { name: "require" })) return;
      const start = node.loc?.start;
      const reference =
        start === undefined
          ? undefined
          : references.get(`${start.line}:${start.column}`);
      if (reference?.role !== "write") return;
      if (
        reference.resolution === "unbound" ||
        reference.bindingId === programRequireBinding
      ) {
        reached = true;
        return;
      }
      if (
        (reference.resolution === "unknown" ||
          reference.resolution === "ambiguous") &&
        !writeShieldedByLocalBinding(node, readAncestors())
      ) {
        reached = true;
      }
    },
  });
  return reached;
};

const bindsRequireIdentifier = (
  patterns: readonly (t.Node | null | undefined)[],
): boolean => {
  const identifiers: t.Node[] = [];
  const collect = (pattern: t.Node | null | undefined): void => {
    if (pattern === null || pattern === undefined) return;
    if (t.isIdentifier(pattern)) {
      identifiers.push(pattern);
      return;
    }
    if (t.isTSParameterProperty(pattern)) {
      collect(pattern.parameter);
      return;
    }
    if (
      t.isObjectPattern(pattern) ||
      t.isArrayPattern(pattern) ||
      t.isRestElement(pattern) ||
      t.isAssignmentPattern(pattern)
    )
      identifiers.push(pattern);
  };
  for (const pattern of patterns) collect(pattern);
  return identifiers.some((identifier) =>
    Object.hasOwn(t.getBindingIdentifiers(identifier), "require"),
  );
};

/**
 * Whether a function body binds `require` at a position visible to the
 * body's own scope. Results memoize per body node: large generated files
 * hold many dynamic writes against one shared function, and each used to
 * re-traverse the same body in full.
 */
const functionBodyBindingCache = new WeakMap<t.BlockStatement, boolean>();

const functionBodyBindsRequire = (body: t.Node | null | undefined): boolean => {
  if (body === null || body === undefined || !t.isBlockStatement(body))
    return false;
  const cached = functionBodyBindingCache.get(body);
  if (cached !== undefined) return cached;
  const result = scanFunctionBodyForRequire(body);
  functionBodyBindingCache.set(body, result);
  return result;
};

const scanFunctionBodyForRequire = (body: t.BlockStatement): boolean => {
  let found = false;
  let depth = 0;
  traverseJavaScriptAst(body, {
    enter: (node, parent) => {
      if (found || node === body) return;
      if (t.isFunction(node) || t.isClass(node)) {
        if (
          t.isFunctionDeclaration(node) &&
          parent === body &&
          node.id?.name === "require"
        )
          found = true;
        depth += 1;
        return;
      }
      if (depth > 0) return;
      if (
        t.isVariableDeclaration(node, { kind: "var" }) &&
        node.declarations.some((declaration) =>
          bindsRequireIdentifier([declaration.id]),
        )
      )
        found = true;
    },
    exit: (node) => {
      if (node !== body && (t.isFunction(node) || t.isClass(node))) depth -= 1;
    },
  });
  return found;
};

const isComputedKeyOf = (scope: t.Node, child: t.Node): boolean =>
  (t.isObjectMethod(scope) || t.isClassMethod(scope)) &&
  scope.computed &&
  (scope.key === child || contains(scope.key, child));

const blockBindsLexicalRequire = (body: readonly t.Node[]): boolean =>
  body.some(
    (statement) =>
      (t.isVariableDeclaration(statement) &&
        statement.kind !== "var" &&
        statement.declarations.some((declaration) =>
          bindsRequireIdentifier([declaration.id]),
        )) ||
      (t.isClassDeclaration(statement) &&
        statement.id !== null &&
        statement.id !== undefined &&
        statement.id.name === "require"),
  );

const isRequireKey = (property: t.Node): boolean =>
  (t.isObjectProperty(property) || t.isObjectMethod(property)) &&
  !property.computed &&
  ((t.isIdentifier(property.key) && property.key.name === "require") ||
    (t.isStringLiteral(property.key) && property.key.value === "require"));

const isUnscopablesKey = (property: t.Node): boolean => {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property))
    return false;
  const key = property.key;
  if (!t.isMemberExpression(key)) return false;
  if (!t.isIdentifier(key.object, { name: "Symbol" })) return false;
  return (
    (!key.computed && t.isIdentifier(key.property, { name: "unscopables" })) ||
    (key.computed && t.isStringLiteral(key.property, { value: "unscopables" }))
  );
};

const isFalsyLiteral = (value: t.Node): boolean =>
  (t.isBooleanLiteral(value) && value.value === false) ||
  (t.isNumericLiteral(value) && value.value === 0) ||
  (t.isStringLiteral(value) && value.value === "") ||
  t.isNullLiteral(value);

const withObjectDeclaresRequire = (ancestors: readonly t.Node[]): boolean => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const scope = ancestors[index];
    if (scope === undefined) continue;
    if (t.isProgram(scope)) return false;
    if (!t.isWithStatement(scope)) continue;
    const object = scope.object;
    if (!t.isObjectExpression(object)) continue;
    if (!object.properties.some(isRequireKey)) continue;
    const unscopables = object.properties.find(isUnscopablesKey);
    if (unscopables === undefined) return true;
    if (
      !t.isObjectProperty(unscopables) ||
      !t.isObjectExpression(unscopables.value) ||
      unscopables.value.properties.some(
        (entry) =>
          t.isObjectProperty(entry) &&
          !entry.computed &&
          ((t.isIdentifier(entry.key) && entry.key.name === "require") ||
            (t.isStringLiteral(entry.key) && entry.key.value === "require")) &&
          !isFalsyLiteral(entry.value),
      )
    )
      continue;
    return true;
  }
  return false;
};

const writeShieldedByLocalBinding = (
  node: t.Node,
  ancestors: readonly t.Node[],
): boolean => {
  if (withObjectDeclaresRequire(ancestors)) return true;
  let child: t.Node = node;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const scope = ancestors[index];
    if (scope === undefined) continue;
    if (t.isProgram(scope)) return false;
    if (t.isFunction(scope)) {
      if (isComputedKeyOf(scope, child)) {
        child = scope;
        continue;
      }
      if (bindsRequireIdentifier(scope.params)) return true;
      if (
        t.isFunctionExpression(scope) &&
        scope.id !== null &&
        scope.id !== undefined &&
        scope.id.name === "require"
      )
        return true;
      if (child === scope.body && functionBodyBindsRequire(scope.body))
        return true;
      child = scope;
      continue;
    }
    if (t.isCatchClause(scope) && bindsRequireIdentifier([scope.param]))
      return true;
    if (
      t.isSwitchStatement(scope) &&
      child !== scope.discriminant &&
      !contains(scope.discriminant, child) &&
      scope.cases.some((entry) => blockBindsLexicalRequire(entry.consequent))
    )
      return true;
    if (t.isSwitchCase(scope) && blockBindsLexicalRequire(scope.consequent))
      return true;
    if (
      t.isForStatement(scope) ||
      t.isForInStatement(scope) ||
      t.isForOfStatement(scope)
    ) {
      const head = t.isForStatement(scope) ? scope.init : scope.left;
      if (
        head !== null &&
        head !== undefined &&
        t.isVariableDeclaration(head) &&
        head.kind !== "var" &&
        head.declarations.some((declaration) =>
          bindsRequireIdentifier([declaration.id]),
        )
      )
        return true;
      child = scope;
      continue;
    }
    if (!t.isBlockStatement(scope) && !t.isStaticBlock(scope)) {
      child = scope;
      continue;
    }
    if (blockBindsLexicalRequire(scope.body)) return true;
    child = scope;
  }
  return false;
};

const ITERATION_PROTOTYPES = new Set(["Object", "Array", "String"]);

/**
 * Which loop kinds a member write can affect. Plain string members of a
 * shared prototype add enumerable keys seen by `for-in`; only iterator or
 * prototype-chain changes affect `for-of` over an empty literal.
 */
interface IterationPollution {
  readonly forIn: boolean;
  readonly forOf: boolean;
}

const NO_ITERATION_POLLUTION: IterationPollution = {
  forIn: false,
  forOf: false,
};

const FULL_ITERATION_POLLUTION: IterationPollution = {
  forIn: true,
  forOf: true,
};

const memberWriteIterationPollution = (target: t.Node): IterationPollution => {
  let current: t.Node | null | undefined = target;
  let landedComputed: boolean | undefined;
  while (current !== null && current !== undefined) {
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      return NO_ITERATION_POLLUTION;
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === "__proto__") return FULL_ITERATION_POLLUTION;
    if (landedComputed === undefined)
      landedComputed = current.computed === true;
    const object: t.Node = unwrapJavaScriptExpression(current.object).node;
    if (
      t.isIdentifier(object) &&
      ITERATION_PROTOTYPES.has(object.name) &&
      key === "prototype"
    ) {
      if (current === target) return FULL_ITERATION_POLLUTION;
      return landedComputed === true
        ? FULL_ITERATION_POLLUTION
        : { forIn: true, forOf: false };
    }
    current = object;
  }
  return NO_ITERATION_POLLUTION;
};

const isReflectivePrototypeMutation = (node: t.Node): boolean => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = node.callee;
  if (
    !t.isMemberExpression(callee) ||
    callee.computed ||
    !t.isIdentifier(callee.property)
  )
    return false;
  const object = unwrapJavaScriptExpression(callee.object).node;
  if (
    !t.isIdentifier(object) ||
    (object.name !== "Object" && object.name !== "Reflect")
  )
    return false;
  if (
    callee.property.name === "defineProperty" ||
    callee.property.name === "defineProperties" ||
    callee.property.name === "setPrototypeOf"
  )
    return true;
  return (
    callee.property.name === "assign" &&
    node.arguments.length > 0 &&
    t.isMemberExpression(node.arguments[0])
  );
};

/**
 * Which loop kinds may iterate from shared-prototype mutation. Reflective
 * mutation is unprovable either way; the scan stays lazy per file.
 */
const fileIterationPollution = (program: t.Program): IterationPollution => {
  let forIn = false;
  let forOf = false;
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (forIn && forOf) return;
      if (isReflectivePrototypeMutation(node)) {
        forIn = true;
        forOf = true;
        return;
      }
      if (t.isUnaryExpression(node, { operator: "delete" })) return;
      const site = semanticWriteSiteTarget(node);
      if (site === null) return;
      for (const target of semanticWriteTargets(site)) {
        const kind = memberWriteIterationPollution(target);
        forIn ||= kind.forIn;
        forOf ||= kind.forOf;
      }
    },
  });
  return { forIn, forOf };
};

const createsNoEnumerableKeys = (node: t.Node): boolean => {
  if (t.isNullLiteral(node)) return true;
  if (!t.isObjectExpression(node)) return false;
  return node.properties.every(
    (property) =>
      t.isObjectProperty(property) &&
      !property.computed &&
      ((t.isIdentifier(property.key) && property.key.name === "__proto__") ||
        (t.isStringLiteral(property.key) &&
          property.key.value === "__proto__")) &&
      createsNoEnumerableKeys(property.value),
  );
};

const isStaticallyEmptyIterable = (
  node: t.Node | null | undefined,
  isForIn: boolean,
): boolean => {
  // `for-in` skips array holes; `for-of` yields them. Emptiness therefore
  // depends on the loop kind, never just the literal. An object whose
  // entries are all prototype setters over keyless prototypes creates
  // no enumerable keys.
  if (t.isArrayExpression(node))
    return isForIn
      ? node.elements.every((element) => element === null)
      : node.elements.length === 0;
  if (t.isObjectExpression(node)) return createsNoEnumerableKeys(node);
  if (t.isStringLiteral(node)) return node.value === "";
  return false;
};

const hasUninitializedTopLevelVarRequire = (program: t.Program): boolean => {
  let found = false;
  let initialized = false;
  let pollution: IterationPollution | undefined;
  traverseJavaScriptAst(program, {
    enter: (node, parent, readAncestors) => {
      if (!t.isVariableDeclaration(node, { kind: "var" })) return;
      if (
        readAncestors().some(
          (ancestor) => t.isFunction(ancestor) || t.isStaticBlock(ancestor),
        )
      )
        return;
      for (const declaration of node.declarations) {
        if (!Object.hasOwn(t.getBindingIdentifiers(declaration.id), "require"))
          continue;
        found = true;
        // A for-in/of head has no initializer yet assigns the binding on
        // every iteration, so it initializes the loader just as an
        // assignment does. A bare `for (var require;;)` head stays
        // uninitialized, as does a head over a statically empty iterable
        // that never assigns — unless the file may have mutated the shared
        // iteration behavior that loop kind relies on.
        if (t.isForInStatement(parent) || t.isForOfStatement(parent)) {
          if (parent.left !== node) continue;
          pollution ??= fileIterationPollution(program);
          const loopIsForIn = t.isForInStatement(parent);
          initialized ||=
            (loopIsForIn ? pollution.forIn : pollution.forOf) ||
            !isStaticallyEmptyIterable(parent.right, loopIsForIn);
          continue;
        }
        initialized ||= declaration.init !== null;
      }
    },
  });
  return found && !initialized;
};

const directCreateRequireBinding = (
  program: t.Program,
  references: ReadonlyMap<string, JavaScriptSemanticReference>,
): boolean => {
  const programScope = semanticScopeId("program", program);
  const importedNames = new Set<string>();
  for (const declaration of program.body) {
    if (
      !t.isImportDeclaration(declaration) ||
      (declaration.source.value !== "node:module" &&
        declaration.source.value !== "module")
    )
      continue;
    for (const specifier of declaration.specifiers) {
      if (
        t.isImportSpecifier(specifier) &&
        t.isIdentifier(specifier.imported, { name: "createRequire" })
      )
        importedNames.add(specifier.local.name);
    }
  }

  return program.body.some(
    (statement) =>
      t.isVariableDeclaration(statement, { kind: "const" }) &&
      statement.declarations.some((declaration) => {
        if (
          !t.isIdentifier(declaration.id, { name: "require" }) ||
          !t.isCallExpression(declaration.init) ||
          !t.isIdentifier(declaration.init.callee) ||
          !importedNames.has(declaration.init.callee.name) ||
          !isImportMetaUrl(declaration.init.arguments[0])
        )
          return false;
        const start = declaration.init.callee.loc?.start;
        if (start === undefined) return false;
        const reference = references.get(`${start.line}:${start.column}`);
        return (
          reference?.resolution === "resolved" &&
          reference.bindingId ===
            semanticBindingId(programScope, declaration.init.callee.name)
        );
      }),
  );
};

const isImportMetaUrl = (node: t.Node | undefined): boolean =>
  t.isMemberExpression(node) &&
  !node.computed &&
  t.isIdentifier(node.property, { name: "url" }) &&
  t.isMetaProperty(node.object) &&
  t.isIdentifier(node.object.meta, { name: "import" }) &&
  t.isIdentifier(node.object.property, { name: "meta" });

const requireCalleeIdentifier = (
  callee: t.Node | null | undefined,
): t.Identifier | undefined => {
  if (t.isIdentifier(callee, { name: "require" })) return callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" }) ||
    ((!t.isIdentifier(callee.property) || callee.computed) &&
      !t.isStringLiteral(callee.property))
  )
    return undefined;
  const propertyName = t.isIdentifier(callee.property)
    ? callee.property.name
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  return propertyName === "resolve" || propertyName === "main"
    ? callee.object
    : undefined;
};
