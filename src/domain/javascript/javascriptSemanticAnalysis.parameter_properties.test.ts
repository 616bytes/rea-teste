import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  onlyBinding,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("TypeScript parameter-property references", () => {
  it.each([
    "public x: number",
    "private x: number",
    "protected x: number",
    "readonly x: number",
    "public readonly x: number",
    "public x?: number",
    "public x = 1",
    "private readonly x = 1",
    "x: number",
    "x = 1",
  ])("retains %s as a definition without inventing a read", (parameter) => {
    const ir = analyzeJavaScriptSemantics(
      `class C { constructor(${parameter}) {} }`,
    );
    expect(onlyBinding(ir, "x").definitions).toContainEqual(
      expect.objectContaining({ kind: "parameter" }),
    );
    expect(ir.references.filter(({ name }) => name === "x")).toEqual([]);
  });

  it("retains the real default-initializer read and its outer binding", () => {
    const ir = analyzeJavaScriptSemantics(
      "const seed = 7; class C { constructor(public x = seed) {} }",
    );
    expect(ir.references.filter(({ name }) => name === "x")).toEqual([]);
    expect(ir.references.filter(({ name }) => name === "seed")).toEqual([
      expect.objectContaining({
        role: "read",
        bindingId: topLevelBinding(ir, "seed").bindingId,
        resolution: "resolved",
      }),
    ]);
  });

  it("retains a closure capture in the default expression rather than its declaration", () => {
    const source = "class C { constructor(public x = () => x) {} }";
    const ir = analyzeJavaScriptSemantics(source);
    const references = ir.references.filter(({ name }) => name === "x");
    expect(references).toEqual([
      expect.objectContaining({
        role: "read",
        bindingId: onlyBinding(ir, "x").bindingId,
        location: expect.objectContaining({
          start: { line: 1, column: source.lastIndexOf("x") },
        }),
      }),
    ]);
  });

  it("preserves body reads and read-modify-write roles on the parameter binding", () => {
    const ir = analyzeJavaScriptSemantics(
      "const x = 0; class C { constructor(public x: number) { x++; consume(x); } }",
    );
    const parameter = ir.bindings.find(
      (binding) =>
        binding.name === "x" &&
        binding.definitions.some(({ kind }) => kind === "parameter"),
    );
    expect(parameter).toBeDefined();
    expect(ir.references.filter(({ name }) => name === "x")).toEqual([
      expect.objectContaining({
        role: "read",
        bindingId: parameter?.bindingId,
      }),
      expect.objectContaining({
        role: "write",
        bindingId: parameter?.bindingId,
      }),
      expect.objectContaining({
        role: "read",
        bindingId: parameter?.bindingId,
      }),
    ]);
    expect(parameter?.bindingId).not.toBe(topLevelBinding(ir, "x").bindingId);
  });
});
