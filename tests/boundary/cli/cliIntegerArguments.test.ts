import { describe, expect, it } from "vitest";

import { serveCli } from "./cliServeHarness.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";

// `z.coerce.number()` reads "" and whitespace as 0 and also accepts hex,
// binary and exponent spellings, so an unset shell variable became a valid
// index or Cutter generation instead of a validation error.
const NOT_DECIMAL = ["", " ", "0x1", "0b1", "1e0", "+1", "1.0"];

describe("CLI integer positional arguments", () => {
  it.each(NOT_DECIMAL)(
    "rejects %j as a Cutter expected generation",
    async (value) => {
      const result = await serveCli([
        "cutter-command",
        SESSION_ID,
        value,
        "pdi",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [expect.objectContaining({ path: "expectedGeneration" })],
      });
    },
  );

  it.each(NOT_DECIMAL)(
    "rejects %j as a web module script index",
    async (value) => {
      const result = await serveCli([
        "trace-web-module-imports",
        "/nonexistent/manifest.json",
        value,
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [expect.objectContaining({ path: "scriptIndex" })],
      });
    },
  );
});
