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
      t.isVariableDeclaration(statement) &&
      statement.kind !== "var" &&
      statement.declarations.some((declaration) =>
        bindsRequireIdentifier([declaration.id]),
      ),
  );

const writeShieldedByLocalBinding = (
  node: t.Node,
  ancestors: readonly t.Node[],
): boolean => {
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
      if (child === scope.body && functionBodyBindsRequire(scope.body))
        return true;
      child = scope;
      continue;
    }
    if (t.isCatchClause(scope) && bindsRequireIdentifier([scope.param]))
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
 * Whether a member write can affect iteration over fresh literals. A write
 * through `X.prototype` (or through `__proto__`) mutates shared iteration
 * behavior: `for-in` then sees inherited keys on `{}`/`[]`, and a replaced
 * `Symbol.iterator` makes `for-of []` iterate. Reflective mutation
 * (`defineProperty`, `Reflect`, `setPrototypeOf`) is not covered — see the
 * residual note on `fileMayPolluteIteration`.
 */
const memberWriteTouchesSharedPrototype = (target: t.Node): boolean => {
  let current: t.Node | null | undefined = target;
  while (current !== null && current !== undefined) {
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      return false;
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === "__proto__") return true;
    const object: t.Node = unwrapJavaScriptExpression(current.object).node;
    if (
      t.isIdentifier(object) &&
      ITERATION_PROTOTYPES.has(object.name) &&
      key === "prototype"
    )
      return true;
    current = object;
  }
  return false;
};

/**
 * Whether this file may have mutated shared iteration behavior before any
 * loop runs. The scan is whole-file and order-insensitive (a later write
 * still disables the exemption), which is conservative: a polluted file
 * loses a static-emptiness shortcut it cannot prove. Deletion is excluded —
 * removing keys or iterators cannot make an empty literal iterate.
 */
const fileMayPolluteIteration = (program: t.Program): boolean => {
  let polluted = false;
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (polluted) return;
      if (t.isUnaryExpression(node, { operator: "delete" })) return;
      const site = semanticWriteSiteTarget(node);
      if (site === null) return;
      for (const target of semanticWriteTargets(site)) {
        if (memberWriteTouchesSharedPrototype(target)) {
          polluted = true;
          return;
        }
      }
    },
  });
  return polluted;
};

const isStaticallyEmptyIterable = (
  node: t.Node | null | undefined,
  isForIn: boolean,
): boolean => {
  // `for-in` skips array holes; `for-of` yields them. Emptiness therefore
  // depends on the loop kind, never just the literal.
  if (t.isArrayExpression(node))
    return isForIn
      ? node.elements.every((element) => element === null)
      : node.elements.length === 0;
  if (t.isObjectExpression(node)) return node.properties.length === 0;
  if (t.isStringLiteral(node)) return node.value === "";
  return false;
};

const hasUninitializedTopLevelVarRequire = (program: t.Program): boolean => {
  let found = false;
  let initialized = false;
  // Computed once per file: the exemption below infers non-iteration from
  // literal contents, which holds only while shared prototypes are intact.
  const mayPollute = fileMayPolluteIteration(program);
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
        // that never assigns — unless the file may have mutated shared
        // iteration behavior, in which case no literal proves emptiness.
        if (t.isForInStatement(parent) || t.isForOfStatement(parent)) {
          if (parent.left !== node) continue;
          initialized ||=
            mayPollute ||
            !isStaticallyEmptyIterable(
              parent.right,
              t.isForInStatement(parent),
            );
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
