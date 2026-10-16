import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

interface GeneratorPrefixFacts {
  readonly before: WeakMap<t.Node, number>;
  readonly yielded: readonly t.YieldExpression[];
}
const prefixes = new WeakMap<t.Node, GeneratorPrefixFacts>();

/** Index only straight-line owned yields; uncertain branches do not prove a resume phase. */
const generatorPrefixes = (
  body: t.Node,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): GeneratorPrefixFacts => {
  const cached = prefixes.get(body);
  if (cached !== undefined) return cached;
  const before = new WeakMap<t.Node, number>();
  const yielded: t.YieldExpression[] = [];
  let completed = 0;
  const pending: { node: t.Node; exit?: true }[] = [{ node: body }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = unwrapJavaScriptExpression(entry.node).node;
    if (entry.exit === true) {
      if (t.isYieldExpression(node)) {
        if (node.delegate) completed = -1;
        else if (completed >= 0) {
          yielded.push(node);
          completed += 1;
        }
      }
      continue;
    }
    before.set(node, completed);
    if (t.isFunction(node)) continue;
    if (
      (t.isIfStatement(node) ||
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node) ||
        t.isLoop(node) ||
        t.isSwitchStatement(node) ||
        t.isTryStatement(node)) &&
      maySuspend(node)
    )
      completed = -1;
    if (t.isYieldExpression(node)) pending.push({ node, exit: true });
    const children = ordered(node);
    for (const child of children.toReversed()) pending.push({ node: child });
  }
  const facts = { before, yielded };
  prefixes.set(body, facts);
  return facts;
};

/** Only a selected, completed earlier default can delay the next iterator step. */
export const semanticPatternSuspendsBeforeGeneratorRead = ({
  read,
  body,
  pattern,
  state,
  ordered,
  maySuspend,
  completedSuspension,
}: {
  readonly read: t.Node;
  readonly body: t.Node;
  readonly pattern: t.ArrayPattern;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly ordered: (node: t.Node) => readonly t.Node[];
  readonly maySuspend: (node: t.Node) => boolean;
  readonly completedSuspension: (node: t.Node) => boolean;
}): boolean => {
  const facts = generatorPrefixes(body, ordered, maySuspend);
  const count = facts.before.get(unwrapJavaScriptExpression(read).node);
  if (count === undefined || count < 0) return false;
  for (
    let index = 0;
    index < Math.min(count, pattern.elements.length);
    index += 1
  ) {
    const element = pattern.elements[index];
    if (t.isRestElement(element)) break;
    if (!t.isAssignmentPattern(element)) continue;
    const yielded = facts.yielded[index];
    if (yielded === undefined) return false;
    const argument =
      yielded.argument == null
        ? undefined
        : unwrapJavaScriptExpression(yielded.argument).node;
    const undefinedValue =
      argument === undefined ||
      (t.isIdentifier(argument, { name: "undefined" }) &&
        resolveSemanticBindingState(state, argument, "undefined") ===
          undefined) ||
      (t.isUnaryExpression(argument, { operator: "void" }) &&
        readExactJavaScriptLiteral(argument.argument).found);
    if (undefinedValue && completedSuspension(element.right)) return true;
  }
  return false;
};
