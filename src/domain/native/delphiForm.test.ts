import { z } from "zod";
import { describe, expect, it } from "vitest";
import { delphiFormResourceSchema } from "./delphiForm.js";

describe("delphi form advertised schema", () => {
  it("keeps known fields and discriminators machine-readable", () => {
    const advertised = JSON.stringify(z.toJSONSchema(delphiFormResourceSchema));
    // The recursive positions relax only their child/item edges; every known
    // field and discriminator stays discoverable for generated clients.
    for (const field of [
      '"kind"',
      '"class_name"',
      '"component_name"',
      '"location"',
      '"value_type"',
      '"items"',
      '"children"',
      '"position"',
      '"declared_code_page"',
    ])
      expect(advertised).toContain(field);
  });

  it("advertises without recursive definitions", () => {
    const advertised = JSON.stringify(z.toJSONSchema(delphiFormResourceSchema));
    expect(advertised).not.toContain("__schema");
  });
});
