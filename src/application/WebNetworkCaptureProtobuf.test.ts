import { expect, it } from "vitest";

it("decodes the issue's HAR through the service only for selected records", async () => {
  const entry = (mimeType: string, text: string) => ({
    request: {
      method: "POST",
      url: "https://api.example.test/x",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      redirectURL: "",
      headersSize: -1,
      bodySize: 1,
      content: { size: 1, mimeType, text, encoding: "base64" },
    },
    startedDateTime: "2026-10-18T10:00:00.000Z",
    time: 1,
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  });
  const har = JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "t", version: "1" },
      entries: [
        entry("application/grpc-web+proto", "AAAAAA4IlgESBWhlbGxvGgIIAQ=="),
        entry("application/x-protobuf", "CJYBEgVoZWxsbxoCCAE="),
      ],
    },
  });
  const { decodeHarCapture } = await import("../browser/history/HarCapture.js");
  const { WebNetworkCaptureService } =
    await import("./WebNetworkCaptureService.js");
  const { ok } = await import("../domain/result.js");
  const service = new WebNetworkCaptureService({
    inspect: () =>
      Promise.resolve(
        ok({
          ...decodeHarCapture(har, []),
          artifact: {
            path: "/c.har",
            sha256: "a".repeat(64),
            bytes: har.length,
          },
          format: "har" as const,
          runtime_attribution: "unknown" as const,
          limitations: [],
        }),
      ),
  });
  const run = async (record_ordinals?: number[]) => {
    const result = await service.inspect({
      capture_path: "/c.har",
      format: "har",
      ...(record_ordinals && { record_ordinals }),
    });
    if (!result.ok) throw result.error;
    return (
      result.value.normalized_result as {
        records: {
          protobuf?: { framing: string; frames: { bytes: number }[] }[];
        }[];
      }
    ).records;
  };
  expect((await run()).every((record) => record.protobuf === undefined)).toBe(
    true,
  );
  const [grpc, raw] = await run([0, 1]);
  expect(grpc?.protobuf?.[0]).toMatchObject({
    framing: "grpc",
    frames: [{ bytes: 14 }],
  });
  expect(raw?.protobuf?.[0]).toMatchObject({
    framing: "raw",
    frames: [{ bytes: 14 }],
  });
});
