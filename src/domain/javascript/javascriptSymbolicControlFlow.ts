import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  javaScriptOptionalOperandsMayBeSkipped,
} from "./javascriptAstValues.js";
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
    ].includes(left.kind)
      ? false
      : undefined;
  }
  const truth = symbolicTruth(left);
  return truth === undefined ? undefined : operator === "&&" ? truth : !truth;
};

/** Only definite synchronous exits; unsupported control flow stays unknown. */
export const symbolicDefiniteExit = (
  node: t.Node | null | undefined,
  depth = 0,
): boolean => {
  if (!node || depth >= 128) return false;
  if (t.isReturnStatement(node) || t.isThrowStatement(node)) return true;
  if (t.isBlockStatement(node))
    return node.body.some((child) => symbolicDefiniteExit(child, depth + 1));
  return (
    t.isIfStatement(node) &&
    symbolicDefiniteExit(node.consequent, depth + 1) &&
    symbolicDefiniteExit(node.alternate, depth + 1)
  );
};

/** Prove a syntax-local path is unconditional; unknown branches remain unknown. */
export const createUnconditionalEvaluationProof = (
  parents: WeakMap<t.Node, t.Node>,
): ((node: t.Node) => boolean) => {
  const reachableStatements = new WeakMap<
    t.Program | t.BlockStatement,
    ReadonlySet<t.Node>
  >();
  const truth = (node: t.Node): boolean | undefined => {
    const literal = readExactJavaScriptLiteral(node);
    return literal.found ? Boolean(literal.value) : undefined;
  };
  return (node) => {
    let child = node;
    for (;;) {
      const parent = parents.get(child);
      if (parent === undefined) return true;
      if (t.isIfStatement(parent) || t.isConditionalExpression(parent)) {
        if (child !== parent.test) {
          const selected = truth(parent.test);
          if (
            selected === undefined ||
            (child === parent.consequent) !== selected
          )
            return false;
        }
      } else if (t.isLogicalExpression(parent) && child === parent.right) {
        const literal = readExactJavaScriptLiteral(parent.left);
        if (
          !literal.found ||
          symbolicLogicalRight(parent.operator, {
            kind: "literal",
            value: literal.value,
          }) !== true
        )
          return false;
      } else if (t.isWhileStatement(parent) && child === parent.body) {
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
      else if (t.isSwitchCase(parent) || t.isCatchClause(parent)) return false;
      else if (t.isAssignmentPattern(parent) && child === parent.right)
        return false;
      else if (
        t.isAssignmentExpression(parent) &&
        parent.operator !== "=" &&
        child === parent.right
      )
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
      if (t.isBlockStatement(parent) || t.isProgram(parent)) {
        let reachable = reachableStatements.get(parent);
        if (reachable === undefined) {
          const statements = new Set<t.Node>();
          for (const statement of parent.body) {
            statements.add(statement);
            if (symbolicDefiniteExit(statement)) break;
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
        return true;
      child = parent;
    }
  };
};
