import { describe, expect, it } from "vitest";

import { mapDexWorkError } from "./dexFailures.js";

describe("mapDexWorkError", () => {
  it("carries facts about the bytes read on every refusal", () => {
    const fact =
      "x.dex has 5 bytes after its declared file_size; they were not read.";
    for (const error of [
      { kind: "work-budget-exceeded", limit: 10 },
      { kind: "duplicate-class-definition", count: 2 },
      { kind: "unreadable-class-identity", count: 1 },
      { kind: "malformed-class-data", classDataOff: 64 },
      { kind: "output-budget-exceeded", projectedBytes: 9, limit: 8 },
    ] as const) {
      const mapped = mapDexWorkError(error, [fact]);
      expect(JSON.stringify(mapped) + mapped.message).toContain(
        "5 bytes after",
      );
      expect(JSON.stringify(mapDexWorkError(error))).not.toContain(
        "bytes after",
      );
    }
  });
});
