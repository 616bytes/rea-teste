import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: nested default destructuring", () => {
  it("keeps the known source slot for a defaulted nested array pattern", () => {
    const ir = analyzeJavaScriptSemantics(`
      const obj = {a: [1], b: 2};
      const arr = [1, 2, 3];
      const {a: [plain]} = obj;
      const {a: [fallback] = []} = obj;
      const {a, ...rest} = obj;
      const [x, ...ys] = arr;
      const {b: scalar = 0} = obj;
    `);

    const destructures = ir.objectOperations.filter(
      ({ kind }) => kind === "destructure",
    );
    const byBinding = new Map(
      destructures.map(({ targetBindingId, propertyPath, resolution }) => [
        targetBindingId,
        { propertyPath, resolution },
      ]),
    );

    const plainId = topLevelBinding(ir, "plain").bindingId;
    const fallbackId = topLevelBinding(ir, "fallback").bindingId;
    const scalarId = topLevelBinding(ir, "scalar").bindingId;

    // The plain nested control keeps the known obj.a[0] slot, and the
    // defaulted nested pattern must keep the same known slot: the default
    // value only applies when the slot is absent, it does not change the
    // statically known dependency while the value is present.
    expect(byBinding.get(plainId)).toEqual({
      propertyPath: ["a", "0"],
      resolution: "complete",
    });
    expect(byBinding.get(fallbackId)).toEqual({
      propertyPath: ["a", "0"],
      resolution: "complete",
    });
    expect(byBinding.get(scalarId)).toEqual({
      propertyPath: ["b"],
      resolution: "complete",
    });
  });
});
