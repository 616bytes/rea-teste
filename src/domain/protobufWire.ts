import { z } from "zod";

/** Content types whose retained bodies carry protobuf or gRPC(-web) messages. */
export const PROTOBUF_FRAMING = {
  "application/grpc": "grpc",
  "application/grpc+proto": "grpc",
  "application/grpc-web": "grpc",
  "application/grpc-web+proto": "grpc",
  "application/grpc-web-text": "grpc-web-text",
  "application/grpc-web-text+proto": "grpc-web-text",
  "application/x-protobuf": "raw",
  "application/protobuf": "raw",
  "application/vnd.google.protobuf": "raw",
} as const;

const MAX_DEPTH = 8;

const wireFieldSchema: z.ZodType<WireField> = z.lazy(() =>
  z.strictObject({
    number: z.number().int().positive(),
    wire_type: z.enum(["varint", "i64", "len", "i32"]),
    offset: z.number().int().nonnegative(),
    bytes: z.number().int().positive(),
    value: z.string().exactOptional(),
    interpretation: z
      .enum(["utf8-string", "nested-message", "opaque-bytes"])
      .exactOptional(),
    inferred: z.array(z.string()).exactOptional(),
    fields: z.array(wireFieldSchema).exactOptional(),
  }),
);

/** Wire-format facts; `inferred` marks length-delimited readings no schema confirms. */
export type WireField = {
  number: number;
  wire_type: "varint" | "i64" | "len" | "i32";
  /** Byte offset of the tag, relative to the decoded message. */
  offset: number;
  /** Tag plus payload bytes. */
  bytes: number;
  /** Varint/fixed value as a decimal string (exact beyond 2^53), or redacted UTF-8 text. */
  value?: string;
  interpretation?: "utf8-string" | "nested-message" | "opaque-bytes";
  inferred?: string[];
  fields?: WireField[];
};

const messageSchema = z.strictObject({
  fields: z.array(wireFieldSchema),
  /** Set when parsing stopped before the end of the bytes. */
  error: z.string().exactOptional(),
});

const frameSchema = z.strictObject({
  kind: z.enum(["data", "trailer"]),
  offset: z.number().int().nonnegative(),
  compressed: z.boolean(),
  bytes: z.number().int().nonnegative(),
  message: messageSchema.exactOptional(),
  trailers: z.array(z.tuple([z.string(), z.string()])).exactOptional(),
});

/** Decoded protobuf view of one retained binary field. */
export const protobufDecodingSchema = z.strictObject({
  pointer: z.string(),
  content_type: z.string(),
  framing: z.enum(["raw", "grpc", "grpc-web-text"]),
  frames: z.array(frameSchema),
  error: z.string().exactOptional(),
});
export type ProtobufDecoding = z.output<typeof protobufDecodingSchema>;
type Message = z.output<typeof messageSchema>;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const strictUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};
// Printable text only: tabs, newlines and carriage returns allowed, other controls not.
const isText = (text: string): boolean =>
  text.length > 0 &&
  ![...text].some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f
    );
  });

const readVarint = (
  bytes: Uint8Array,
  start: number,
): { value: bigint; end: number } | undefined => {
  let value = 0n;
  for (let index = 0; index < 10 && start + index < bytes.length; index++) {
    const byte = bytes[start + index] as number;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if ((byte & 0x80) === 0)
      return { value: BigInt.asUintN(64, value), end: start + index + 1 };
  }
  return undefined;
};

const fixed = (bytes: Uint8Array, start: number, width: 4 | 8): string => {
  let value = 0n;
  for (let index = width - 1; index >= 0; index--)
    value = (value << 8n) | BigInt(bytes[start + index] as number);
  return value.toString();
};

/**
 * Decode protobuf wire format like `protoc --decode_raw`; the whole input must parse
 * as a message or the first malformed offset is reported with the fields before it.
 */
export const decodeProtobufWire = (
  bytes: Uint8Array,
  sensitiveRedactor: (text: string) => string = (text) => text,
  depth = 0,
): Message => {
  const fields: WireField[] = [];
  let at = 0;
  const stop = (error: string): Message => ({
    fields,
    error: `${error} at byte ${at}`,
  });
  while (at < bytes.length) {
    const tag = readVarint(bytes, at);
    if (tag === undefined) return stop("Truncated or oversized field tag");
    const number = Number(tag.value >> 3n);
    const type = Number(tag.value & 7n);
    if (number === 0 || tag.value >> 3n > 0x1fffffffn)
      return stop("Invalid field number");
    const base = { number, offset: at };
    if (type === 0) {
      const varint = readVarint(bytes, tag.end);
      if (varint === undefined) return stop("Truncated varint");
      fields.push({
        ...base,
        wire_type: "varint",
        bytes: varint.end - at,
        value: varint.value.toString(),
      });
      at = varint.end;
    } else if (type === 1 || type === 5) {
      const width = type === 1 ? 8 : 4;
      if (tag.end + width > bytes.length)
        return stop("Truncated fixed-width field");
      fields.push({
        ...base,
        wire_type: width === 8 ? "i64" : "i32",
        bytes: tag.end + width - at,
        value: fixed(bytes, tag.end, width),
      });
      at = tag.end + width;
    } else if (type === 2) {
      const length = readVarint(bytes, tag.end);
      if (length === undefined) return stop("Truncated length prefix");
      const end = length.end + Number(length.value);
      if (length.value > BigInt(bytes.length) || end > bytes.length)
        return stop("Length-delimited field exceeds the message");
      fields.push({
        ...base,
        wire_type: "len",
        bytes: end - at,
        ...inferLength(
          bytes.subarray(length.end, end),
          sensitiveRedactor,
          depth,
        ),
      });
      at = end;
    } else return stop(`Unsupported wire type ${type}`);
  }
  return { fields };
};

/** Without a schema a length-delimited value is ambiguous; report every reading that holds. */
const inferLength = (
  payload: Uint8Array,
  redact: (text: string) => string,
  depth: number,
): Partial<WireField> => {
  const nested =
    payload.length > 0 && depth < MAX_DEPTH
      ? decodeProtobufWire(payload, redact, depth + 1)
      : undefined;
  const asMessage = nested !== undefined && nested.error === undefined;
  const text = strictUtf8(payload);
  const asText = text !== undefined && isText(text);
  const inferred = [
    ...(asText ? ["utf8-string"] : []),
    ...(asMessage ? ["nested-message"] : []),
    ...(payload.length > 0 && payload.length % 4 === 0
      ? ["packed-fixed32"]
      : []),
    ...(payload.length > 0 && payload.length % 8 === 0
      ? ["packed-fixed64"]
      : []),
    "bytes",
  ];
  // A string made only of plain characters is far likelier text than a message;
  // control characters (the usual sign of small tags and lengths) favour a message.
  const plain = asText && ![...text].some((char) => char < " ");
  if (plain || (asText && !asMessage))
    return { interpretation: "utf8-string", value: redact(text), inferred };
  if (asMessage)
    return {
      interpretation: "nested-message",
      fields: nested.fields,
      inferred,
    };
  return { interpretation: "opaque-bytes", inferred };
};

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

const parseTrailers = (text: string): [string, string][] =>
  text
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      const colon = line.indexOf(":");
      return colon < 0
        ? [line, ""]
        : [
            line.slice(0, colon).trim().toLowerCase(),
            line.slice(colon + 1).trim(),
          ];
    });

/** Split gRPC / gRPC-web frames and decode each data frame's wire format. */
export const decodeProtobufBody = (
  body: Uint8Array,
  framing: "raw" | "grpc" | "grpc-web-text",
  base: { pointer: string; content_type: string },
  redact: (text: string) => string,
): ProtobufDecoding => {
  const result = (
    frames: ProtobufDecoding["frames"],
    error?: string,
  ): ProtobufDecoding => ({
    ...base,
    framing,
    frames,
    ...(error === undefined ? {} : { error }),
  });
  if (framing === "raw")
    return result([
      {
        kind: "data",
        offset: 0,
        compressed: false,
        bytes: body.length,
        message: decodeProtobufWire(body, redact),
      },
    ]);
  let data = body;
  if (framing === "grpc-web-text") {
    // Offsets below are into the base64-decoded bytes; text responses may concatenate
    // independently padded base64 chunks, so decode each padded segment.
    const text = new TextDecoder().decode(body).replace(/\s+/g, "");
    if (!BASE64.test(text.replace(/=+(?=.)/g, "")))
      return result([], "gRPC-web text body is not base64");
    data = Buffer.concat(
      (text.match(/[^=]+=*/g) ?? []).map((chunk) =>
        Buffer.from(chunk, "base64"),
      ),
    );
  }
  const frames: ProtobufDecoding["frames"] = [];
  let at = 0;
  while (at < data.length) {
    if (at + 5 > data.length)
      return result(frames, `Truncated frame header at byte ${at}`);
    const flag = data[at] as number;
    const length =
      (data[at + 1] as number) * 2 ** 24 +
      ((data[at + 2] as number) << 16) +
      ((data[at + 3] as number) << 8) +
      (data[at + 4] as number);
    if (at + 5 + length > data.length)
      return result(frames, `Frame at byte ${at} exceeds the body`);
    const payload = data.subarray(at + 5, at + 5 + length);
    const compressed = (flag & 1) === 1;
    const frame = { offset: at, compressed, bytes: length };
    if ((flag & 0x80) !== 0) {
      const text = strictUtf8(payload);
      frames.push({
        kind: "trailer",
        ...frame,
        ...(text === undefined || compressed
          ? {}
          : {
              trailers: parseTrailers(redact(text)).map(
                ([name, value]): [string, string] => [name, value],
              ),
            }),
      });
    } else
      frames.push({
        kind: "data",
        ...frame,
        // Compressed payloads need the negotiated codec; they stay opaque.
        ...(compressed ? {} : { message: decodeProtobufWire(payload, redact) }),
      });
    at += 5 + length;
  }
  return result(frames);
};

type JsonObject = Readonly<Record<string, unknown>>;
const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** Content type declared beside a HAR-style body: its `mimeType`, else the message headers. */
const declaredContentType = (
  reported: unknown,
  pointer: string,
): string | undefined => {
  const path = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent = asObject(reported);
  let message: JsonObject | undefined;
  for (const key of path.slice(0, -1)) {
    parent = asObject(parent?.[key]);
    if (key === "request" || key === "response") message = parent;
  }
  if (typeof parent?.mimeType === "string") return parent.mimeType;
  const headers = message?.headers;
  if (!Array.isArray(headers)) return undefined;
  for (const header of headers) {
    const entry = asObject(header);
    if (
      typeof entry?.name === "string" &&
      entry.name.toLowerCase() === "content-type" &&
      typeof entry.value === "string"
    )
      return entry.value;
  }
  return undefined;
};

/**
 * Decode every retained body of a record whose declared content type is protobuf.
 * Retained base64 stays the source of truth; this is a derived, inferred view.
 */
export const decodeRecordProtobuf = (
  record: {
    reported: unknown;
    binary_fields: readonly {
      pointer: string;
      state: string;
      content_base64: string | null;
    }[];
  },
  redact: (text: string) => string,
): ProtobufDecoding[] =>
  record.binary_fields.flatMap((field) => {
    if (field.state !== "retained" || field.content_base64 === null) return [];
    const declared = declaredContentType(record.reported, field.pointer);
    const essence = declared?.split(";")[0]?.trim().toLowerCase();
    const framing =
      essence === undefined
        ? undefined
        : PROTOBUF_FRAMING[essence as keyof typeof PROTOBUF_FRAMING];
    return framing === undefined || declared === undefined
      ? []
      : [
          decodeProtobufBody(
            Buffer.from(field.content_base64, "base64"),
            framing,
            { pointer: field.pointer, content_type: declared },
            redact,
          ),
        ];
  });
