import * as t from "@babel/types";
import {
  javaScriptExactResultOperand,
  readExactJavaScriptLiteral,
} from "./javascriptAstValues.js";
import { javaScriptOptionalOperandsMayBeSkipped } from "./javascriptSemanticEvaluationOrder.js";
import {
  symbolicTruth,
  type SymbolicValue,
} from "./javascriptSymbolicValues.js";

/** Whether short-circuit evaluation reaches the right operand; unknown stays unknown. */
export const symbolicLogicalRight = (
  operator: t.LogicalExpression["operator"],
  left: SymbolicValue,
): boolean | undefined => {
  if (left.kind === "union") {
    const choices = left.values.map((value) =>
      symbolicLogicalRight(operator, value),
    );
    return choices.length > 0 &&
      choices.every((choice) => choice === choices[0])
      ? choices[0]
      : undefined;
  }
  if (operator === "??") {
    if (left.kind === "literal")
      return left.value === null || left.value === undefined;
    return [
      "function",
      "object",
      "namespace",
      "array",
      "record",
      "loader",
      "promise",
      "iterator",
    ].includes(left.kind)
      ? false
      : undefined;
  }
  const truth = symbolicTruth(left);
  return truth === undefined ? undefined : operator === "&&" ? truth : !truth;
};

/** Syntax-proven branch operands, shared by reachability and continuation proofs. */
export const syntaxUnconditionalOperands = (
  node: t.Node,
): readonly t.Node[] | undefined => {
  if (t.isConditionalExpression(node)) {
    const branch = javaScriptExactResultOperand(node);
    return branch === undefined ? [node.test] : [node.test, branch];
  }
  if (t.isIfStatement(node)) {
    const test = readExactJavaScriptLiteral(node.test);
    const branch = test.found
      ? test.value
        ? node.consequent
        : node.alternate
      : undefined;
    return branch == null ? [node.test] : [node.test, branch];
  }
  if (t.isLogicalExpression(node)) {
    return javaScriptExactResultOperand(node) === node.right
      ? [node.left, node.right]
      : [node.left];
  }
  if (t.isAssignmentExpression(node)) {
    if (
      node.operator === "=" &&
      (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
    )
      return [node.right, node.left];
    // Only logical assignments can short-circuit the RHS. Non-logical
    // compound operators read the left value, then always evaluate the RHS.
    return ["&&=", "||=", "??="].includes(node.operator)
      ? [node.left]
      : [node.left, node.right];
  }
  return undefined;
};

type SyntaxAbruptCompletion =
  | { readonly kind: "return" | "throw" | "unknown" }
  | { readonly kind: "break" | "continue"; readonly label: string | null };

interface SyntaxCompletion {
  readonly normal: boolean;
  readonly abrupt: readonly SyntaxAbruptCompletion[];
}

const normalCompletion: SyntaxCompletion = { normal: true, abrupt: [] };
type CompleteSyntax = (node: t.Node | null | undefined) => SyntaxCompletion;

const syntaxSequenceCompletion = (
  statements: readonly t.Node[],
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const abrupt: SyntaxAbruptCompletion[] = [];
  for (const statement of statements) {
    const completion = complete(statement);
    for (const exit of completion.abrupt) abrupt.push(exit);
    if (!completion.normal) return { normal: false, abrupt };
  }
  return { normal: true, abrupt };
};

const syntaxTryCompletion = (
  node: t.TryStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  let completion = complete(node.block);
  if (node.handler != null) {
    const handler = complete(node.handler.body);
    // Expressions may throw even when their ordinary completion is known.
    // A catch must also exit before a try/catch can prove a definite exit.
    completion = {
      normal: completion.normal || handler.normal,
      abrupt: [
        ...completion.abrupt.filter(({ kind }) => kind !== "throw"),
        ...handler.abrupt,
      ],
    };
  }
  if (node.finalizer == null) return completion;
  const finalizer = complete(node.finalizer);
  return {
    normal: completion.normal && finalizer.normal,
    abrupt: [
      ...(finalizer.normal ? completion.abrupt : []),
      ...finalizer.abrupt,
    ],
  };
};

const syntaxLabeledCompletion = (
  node: t.LabeledStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const body = complete(node.body);
  let target = node.body;
  while (t.isLabeledStatement(target)) target = target.body;
  let consumed = false;
  const abrupt = body.abrupt.filter((exit) => {
    const owned =
      (exit.kind === "break" ||
        (exit.kind === "continue" && t.isLoop(target))) &&
      exit.label === node.label.name;
    consumed ||= owned;
    return !owned;
  });
  return { normal: body.normal || consumed, abrupt };
};

const syntaxLoopCompletion = (
  node: t.Loop,
  complete: CompleteSyntax,
): SyntaxCompletion => ({
  // Loop termination is deliberately not proven from syntax alone.
  normal: true,
  abrupt: complete(node.body).abrupt.filter(
    (exit) =>
      (exit.kind !== "break" && exit.kind !== "continue") ||
      exit.label !== null,
  ),
});

const syntaxIfCompletion = (
  node: t.IfStatement,
  complete: CompleteSyntax,
): SyntaxCompletion => {
  const test = readExactJavaScriptLiteral(node.test);
  if (test.found)
    return complete(test.value ? node.consequent : node.alternate);
  const consequent = complete(node.consequent);
  const alternate = complete(node.alternate);
  return {
    normal: consequent.normal || alternate.normal,
    abrupt: [...consequent.abrupt, ...alternate.abrupt],
  };
};

/** Each structured statement consumes its own jumps before facts escape it. */
const syntaxCompletion = (
  node: t.Node | null | undefined,
  depth: number,
): SyntaxCompletion => {
  if (node == null) return normalCompletion;
  if (depth >= 128) return { normal: true, abrupt: [{ kind: "unknown" }] };
  const complete = (child: t.Node | null | undefined) =>
    syntaxCompletion(child, depth + 1);
  if (t.isReturnStatement(node) || t.isThrowStatement(node))
    return {
      normal: false,
      abrupt: [{ kind: t.isReturnStatement(node) ? "return" : "throw" }],
    };
  if (t.isBreakStatement(node) || t.isContinueStatement(node))
    return {
      normal: false,
      abrupt: [
        {
          kind: t.isBreakStatement(node) ? "break" : "continue",
          label: node.label?.name ?? null,
        },
      ],
    };
  if (t.isBlockStatement(node) || t.isStaticBlock(node) || t.isProgram(node))
    return syntaxSequenceCompletion(node.body, complete);
  if (t.isIfStatement(node)) return syntaxIfCompletion(node, complete);
  if (t.isTryStatement(node)) return syntaxTryCompletion(node, complete);
  if (t.isLoop(node)) return syntaxLoopCompletion(node, complete);
  if (t.isSwitchStatement(node))
    return {
      normal: true,
      abrupt: node.cases.flatMap((item) =>
        syntaxSequenceCompletion(item.consequent, complete).abrupt.filter(
          (exit) => exit.kind !== "break" || exit.label !== null,
        ),
      ),
    };
  if (t.isLabeledStatement(node))
    return syntaxLabeledCompletion(node, complete);
  if (t.isWithStatement(node)) return complete(node.body);
  return normalCompletion;
};

/** Only outward jumps can skip a containing phase; nested owners consume theirs. */
export const syntaxMayExitByJump = (node: t.Node): boolean =>
  syntaxCompletion(node, 0).abrupt.some(
    ({ kind }) => kind === "break" || kind === "continue" || kind === "unknown",
  );

/** Recognize abrupt prefixes without treating a loop's jump as a function exit. */
const syntaxDefiniteExit = (
  node: t.Node | null | undefined,
  depth: number,
  includeJumps: boolean,
): boolean => {
  const completion = syntaxCompletion(node, depth);
  return (
    !completion.normal &&
    completion.abrupt.every(
      ({ kind }) => kind === "return" || kind === "throw" || includeJumps,
    )
  );
};

/** Only definite synchronous exits; unsupported control flow stays unknown. */
export const symbolicDefiniteExit = (
  node: t.Node | null | undefined,
  depth = 0,
): boolean => syntaxDefiniteExit(node, depth, false);

/** Prove a syntax-local path is unconditional; unknown branches remain unknown. */
export const createUnconditionalEvaluationProof = (
  parents: WeakMap<t.Node, t.Node>,
): ((node: t.Node, boundary?: t.Node) => boolean) => {
  const reachableStatements = new WeakMap<
    t.Program | t.BlockStatement | t.SwitchCase,
    ReadonlySet<t.Node>
  >();
  const truth = (node: t.Node): boolean | undefined => {
    const literal = readExactJavaScriptLiteral(node);
    return literal.found ? Boolean(literal.value) : undefined;
  };
  return (node, boundary) => {
    let child = node;
    for (;;) {
      if (child === boundary) return true;
      const parent = parents.get(child);
      if (parent === undefined) return boundary === undefined;
      const operands = syntaxUnconditionalOperands(parent);
      if (operands !== undefined && !operands.includes(child)) return false;
      if (t.isWhileStatement(parent) && child === parent.body) {
        if (truth(parent.test) !== true) return false;
      } else if (t.isForStatement(parent)) {
        if (child === parent.update) return false;
        if (
          child === parent.body &&
          parent.test != null &&
          truth(parent.test) !== true
        )
          return false;
      } else if (
        (t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
        child !== parent.right
      )
        return false;
      else if (t.isDoWhileStatement(parent) && child === parent.test)
        return false;
      else if (
        (t.isSwitchCase(parent) && parent !== boundary) ||
        t.isCatchClause(parent)
      )
        return false;
      else if (t.isAssignmentPattern(parent) && child === parent.right)
        return false;
      else if (
        t.isOptionalMemberExpression(parent) &&
        child === parent.property &&
        parent.computed &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      else if (
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.arguments.includes(child as t.Expression) &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      if (
        t.isBlockStatement(parent) ||
        t.isProgram(parent) ||
        t.isSwitchCase(parent)
      ) {
        let reachable = reachableStatements.get(parent);
        if (reachable === undefined) {
          const statements = new Set<t.Node>();
          for (const statement of t.isSwitchCase(parent)
            ? parent.consequent
            : parent.body) {
            statements.add(statement);
            if (syntaxDefiniteExit(statement, 0, true)) break;
          }
          reachable = statements;
          reachableStatements.set(parent, reachable);
        }
        if (!reachable.has(child)) return false;
      }
      if (
        t.isFunction(parent) &&
        !(
          (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
          parent.computed &&
          parent.key === child
        )
      )
        return boundary === undefined;
      child = parent;
    }
  };
};
