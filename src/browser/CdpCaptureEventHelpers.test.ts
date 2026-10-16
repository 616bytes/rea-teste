import { describe, expect, it } from "vitest";

import { decodeBase64 } from "./CdpCaptureEventHelpers.js";

describe("decodeBase64", () => {
  it.each(["", "QQ==", "QUI=", "QUJD", "QUJDRA=="])(
    "decodes canonical base64 %j",
    (value) => {
      expect(decodeBase64(value)).toEqual(Buffer.from(value, "base64"));
    },
  );

  it.each([
    "Q",
    "QQ=",
    "Q===",
    "====",
    "QU=I",
    "QU JD",
    "QUJD!A==",
    "QUJDR===",
  ])("rejects non-canonical base64 %j", (value) => {
    expect(decodeBase64(value)).toBeUndefined();
  });

  it("validates a large payload without exhausting the stack", () => {
    const payload = Buffer.alloc(12 * 1024 * 1024, 7);

    expect(decodeBase64(payload.toString("base64"))?.equals(payload)).toBe(
      true,
    );
  });
});
