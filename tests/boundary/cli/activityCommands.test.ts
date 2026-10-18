import { describe, expect, it } from "vitest";

import { sanitizeActivityText } from "../../../src/cli/activityCommands.js";

describe("activity command output", () => {
  it("removes terminal control sequences from tool names", () => {
    expect(sanitizeActivityText("binary\u001b[2J\u001b[H_overview\n")).toBe(
      "binary_overview",
    );
  });
});
