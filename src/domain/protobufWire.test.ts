import { expect, it } from "vitest";
import {
  decodeProtobufBody,
  decodeProtobufWire,
  decodeRecordProtobuf,
} from "./protobufWire.js";

// 08 96 01 | 12 05 "hello" | 1a 02 08 01  (the issue's synthetic message)
const message = Buffer.from("089601120568656c6c6f1a020801", "hex");
const same = (text: string) => text;

it("decodes the wire format like protoc --decode_raw, with offsets and inference", () => {
  const { fields, error } = decodeProtobufWire(message);
  expect(error).toBeUndefined();
  expect(fields).toMatchObject([
    { number: 1, wire_type: "varint", offset: 0, bytes: 3, value: "150" },
    {
      number: 2,
      wire_type: "len",
      offset: 3,
      bytes: 7,
      interpretation: "utf8-string",
      value: "hello",
    },
    {
      number: 3,
      offset: 10,
      bytes: 4,
      interpretation: "nested-message",
      fields: [{ number: 1, value: "1" }],
    },
  ]);
  expect(fields[1]?.inferred).toContain("bytes");
});

it("keeps fields decoded before a malformed offset", () => {
  const { fields, error } = decodeProtobufWire(message.subarray(0, 12));
  expect(fields).toHaveLength(2);
  expect(error).toContain("exceeds the message");
});

it("splits gRPC-web frames, including trailers and base64 text bodies", () => {
  const trailer = Buffer.from("grpc-status: 0\r\ngrpc-message: ok\r\n");
  const frames = Buffer.concat([
    Buffer.from([0, 0, 0, 0, message.length]),
    message,
    Buffer.from([0x80, 0, 0, 0, trailer.length]),
    trailer,
  ]);
  const base = { pointer: "/response/content/text", content_type: "x" };
  for (const [framing, body] of [
    ["grpc", frames],
    ["grpc-web-text", Buffer.from(frames.toString("base64"))],
  ] as const) {
    const decoded = decodeProtobufBody(body, framing, base, same);
    expect(decoded.error).toBeUndefined();
    expect(decoded.frames).toMatchObject([
      { kind: "data", offset: 0, compressed: false, bytes: 14 },
      {
        kind: "trailer",
        trailers: [
          ["grpc-status", "0"],
          ["grpc-message", "ok"],
        ],
      },
    ]);
  }
});

it("reports truncated frames and leaves compressed payloads undecoded", () => {
  const base = { pointer: "/p", content_type: "x" };
  expect(
    decodeProtobufBody(Buffer.from([0, 0, 0, 0, 9, 1]), "grpc", base, same)
      .error,
  ).toContain("exceeds the body");
  const compressed = decodeProtobufBody(
    Buffer.from([1, 0, 0, 0, 2, 8, 1]),
    "grpc",
    base,
    same,
  );
  expect(compressed.frames[0]).toMatchObject({ compressed: true });
  expect(compressed.frames[0]).not.toHaveProperty("message");
});

it("decodes only retained bodies declared as protobuf and redacts strings", () => {
  const field = (pointer: string) => ({
    pointer,
    state: "retained",
    content_base64: message.toString("base64"),
  });
  const decoded = decodeRecordProtobuf(
    {
      reported: {
        response: {
          headers: [
            { name: "Content-Type", value: "application/x-protobuf; v=1" },
          ],
          content: { mimeType: "text/plain" },
        },
        request: { postData: { mimeType: "application/x-protobuf" } },
      },
      binary_fields: [
        field("/response/content/text"),
        field("/request/postData/text"),
      ],
    },
    (text) => text.replaceAll("hello", "[REDACTED]"),
  );
  // The response mimeType wins over its headers; only the request body is protobuf.
  expect(decoded.map((item) => item.pointer)).toEqual([
    "/request/postData/text",
  ]);
  expect(decoded[0]?.frames[0]?.message?.fields[1]?.value).toBe("[REDACTED]");
});
