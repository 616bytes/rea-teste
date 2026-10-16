import { describe, expect, it } from "vitest";

import { mapDexWorkError } from "./dexFailures.js";

describe("mapDexWorkError", () => {
  it("names the member and carries facts about the bytes read on every refusal", () => {
    const fact =
      "x.dex has 5 bytes after its declared file_size; they were not read.";
    for (const error of [
      { kind: "work-budget-exceeded", limit: 10 },
      { kind: "duplicate-class-definition", count: 2 },
      { kind: "unreadable-class-identity", count: 1 },
      { kind: "malformed-class-data", classDataOff: 64 },
      { kind: "output-budget-exceeded", projectedBytes: 9, limit: 8 },
    ] as const) {
      const mapped = mapDexWorkError(error, "app.apk!classes2.dex", [fact]);
      const text = JSON.stringify(mapped) + mapped.message;
      expect(text).toContain("5 bytes after");
      expect(text).toContain("app.apk!classes2.dex");
      expect(JSON.stringify(mapDexWorkError(error, "x.dex"))).not.toContain(
        "bytes after",
      );
    }
  });
});
