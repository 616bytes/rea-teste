import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  semanticStaticPropertyKey,
  staticObjectProperty,
} from "./javascriptAstValues.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";

it("limits unary-plus keys to transparent numeric literals", () => {
  const wrapped = t.tsAsExpression(t.numericLiteral(1), t.tsNumberKeyword());
  expect(semanticStaticPropertyKey(t.unaryExpression("+", wrapped), true)).toBe(
    "1",
  );
  for (const argument of [
    t.stringLiteral("1"),
    t.bigIntLiteral(1n),
    t.identifier("input"),
  ])
    expect(
      semanticStaticPropertyKey(t.unaryExpression("+", argument), true),
    ).toBeNull();
});

it("bounds nested inline object spreads without losing a shallow final property", () => {
  let object = t.objectExpression([
    t.objectProperty(t.identifier("stdio"), t.stringLiteral("inherit")),
  ]);
  for (let depth = 0; depth < SEMANTIC_EXPRESSION_DEPTH_LIMIT; depth++)
    object = t.objectExpression([t.spreadElement(object)]);
  expect(staticObjectProperty(object, "stdio").status).toBe("explicit");
  expect(
    staticObjectProperty(t.objectExpression([t.spreadElement(object)]), "stdio")
      .status,
  ).toBe("dynamic");
});
