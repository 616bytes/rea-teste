import {
  decodeXmlPlistText,
  XmlPlistTextDecodeError,
} from "../domain/propertyListXmlText.js";
import {
  PROCMON_CORE_COLUMNS,
  type InspectProcmonExportInput,
  type ProcmonExport,
} from "../domain/procmon/procmonExport.js";
import { readProcmonCsv } from "./ProcmonCsvExport.js";
import {
  partialCoverage,
  procmonCoreColumn,
  ProcmonEventWindow,
  ProcmonExportFormatFailure,
  type ParsedProcmonExport,
} from "./ProcmonExportEvents.js";
import { readProcmonXml } from "./ProcmonXmlExport.js";

export type ProcmonExportReading = Pick<
  ProcmonExport,
  | "source"
  | "missing_columns"
  | "omitted_nested_fields"
  | "events"
  | "output_window"
  | "coverage"
>;

type Encoding = ProcmonExport["source"]["encoding"];

/** Parse one export in source order, retaining only the caller-selected window. */
export const readProcmonExport = async (
  bytes: Uint8Array,
  selection: Pick<
    InspectProcmonExportInput,
    "format" | "event_offset" | "event_limit"
  >,
  signal?: AbortSignal,
): Promise<ProcmonExportReading> => {
  const { encoding, byteOrderMark } = detectEncoding(bytes);
  const format =
    selection.format === "auto"
      ? detectFormat(bytes, encoding)
      : selection.format;
  const window = new ProcmonEventWindow(
    format,
    selection.event_offset,
    selection.event_limit,
  );
  const decoded =
    format === "xml" ? decodeXml(bytes, encoding) : decodeText(bytes, encoding);
  signal?.throwIfAborted();
  const parsed =
    format === "xml"
      ? await readProcmonXml(decoded.text, window, signal)
      : await readProcmonCsv(
          decoded.text,
          window,
          signal,
          decoded.cutBytes > 0,
        );
  const present = new Set(
    parsed.columns.map((column) => procmonCoreColumn(column, format)),
  );
  return {
    source: {
      format,
      encoding,
      byte_order_mark: byteOrderMark,
      columns: parsed.columns,
    },
    missing_columns: PROCMON_CORE_COLUMNS.filter(
      (column) => !present.has(column),
    ),
    omitted_nested_fields: parsed.nested,
    events: window.events,
    output_window: {
      examined_events: window.examined,
      returned_events: window.events.length,
      has_more: window.examined > selection.event_offset + window.events.length,
    },
    coverage: withCutCharacter(parsed, decoded.cutBytes),
  };
};

/** A character cut off at the end is truncation, unless parsing stopped earlier. */
const withCutCharacter = (
  parsed: ParsedProcmonExport,
  cutBytes: number,
): ProcmonExport["coverage"] =>
  cutBytes === 0 || parsed.coverage.status === "partial"
    ? parsed.coverage
    : partialCoverage(
        "truncated",
        `The export ends with an incomplete or invalid character; its last ${cutBytes} bytes were not read.`,
        null,
      );

const detectEncoding = (
  bytes: Uint8Array,
): { encoding: Encoding; byteOrderMark: boolean } => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { encoding: "utf-8", byteOrderMark: true };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { encoding: "utf-16le", byteOrderMark: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { encoding: "utf-16be", byteOrderMark: true };
  return { encoding: "utf-8", byteOrderMark: false };
};

/** The first non-whitespace character selects the format; parsing validates it. */
const detectFormat = (bytes: Uint8Array, encoding: Encoding): "xml" | "csv" => {
  const unit = encoding === "utf-8" ? 1 : 2;
  const bom = encoding === "utf-8" ? (bytes[0] === 0xef ? 3 : 0) : 2;
  for (let at = bom; at + unit <= bytes.length; at += unit) {
    const code =
      encoding === "utf-8"
        ? (bytes[at] ?? 0)
        : encoding === "utf-16le"
          ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
          : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
    if (![0x20, 0x09, 0x0a, 0x0d].includes(code))
      return code === 0x3c ? "xml" : "csv";
  }
  return "csv";
};

interface DecodedExport {
  readonly text: string;
  /** Trailing bytes of an incomplete final character that were not decoded. */
  readonly cutBytes: number;
}

/**
 * Decode strictly. When only the final character is incomplete, as in an
 * export cut off mid-write, decode the bytes before it and report the cut.
 * Invalid bytes anywhere else still reject the export.
 */
const decodeWithCutTail = (
  bytes: Uint8Array,
  encoding: Encoding,
  decode: (bytes: Uint8Array) => string,
  isInvalidBytes: (cause: unknown) => boolean,
): DecodedExport => {
  let first: unknown;
  for (let cut = 0; cut <= 3 && cut <= bytes.length; cut += 1) {
    if (
      cut > 0 &&
      !isIncompleteCharacter(bytes.subarray(bytes.length - cut), encoding)
    )
      continue;
    try {
      return {
        text: decode(bytes.subarray(0, bytes.length - cut)),
        cutBytes: cut,
      };
    } catch (cause: unknown) {
      if (!isInvalidBytes(cause)) throw cause;
      first ??= cause;
    }
  }
  throw first;
};

/** Whether `tail` is the start of one character whose remaining bytes are missing. */
const isIncompleteCharacter = (
  tail: Uint8Array,
  encoding: Encoding,
): boolean => {
  if (encoding === "utf-8") {
    const lead = tail[0] ?? 0;
    const length =
      lead >= 0xc2 && lead <= 0xdf
        ? 2
        : lead >= 0xe0 && lead <= 0xef
          ? 3
          : lead >= 0xf0 && lead <= 0xf4
            ? 4
            : 0;
    return (
      tail.length < length &&
      tail.subarray(1).every((byte) => byte >= 0x80 && byte <= 0xbf)
    );
  }
  // UTF-16: an odd final byte, a high surrogate, or a high surrogate and one byte.
  if (tail.length === 1) return true;
  const high = encoding === "utf-16le" ? tail[1] : tail[0];
  return high !== undefined && high >= 0xd8 && high <= 0xdb;
};

const decodeText = (bytes: Uint8Array, encoding: Encoding): DecodedExport => {
  try {
    return decodeWithCutTail(
      bytes,
      encoding,
      (prefix) => new TextDecoder(encoding, { fatal: true }).decode(prefix),
      (cause) => cause instanceof TypeError,
    );
  } catch (cause: unknown) {
    throw new ProcmonExportFormatFailure(
      "unsupported",
      `Export bytes are not valid ${encoding}. Supported encodings are UTF-8 and BOM-marked UTF-16; re-save the export as UTF-8.`,
      { cause },
    );
  }
};

const decodeXml = (bytes: Uint8Array, encoding: Encoding): DecodedExport => {
  try {
    return decodeWithCutTail(
      bytes,
      encoding,
      decodeXmlPlistText,
      (cause) =>
        cause instanceof XmlPlistTextDecodeError &&
        cause.reason === "invalid-bytes",
    );
  } catch (cause: unknown) {
    if (!(cause instanceof XmlPlistTextDecodeError)) throw cause;
    if (cause.reason === "unsupported-encoding")
      throw new ProcmonExportFormatFailure(
        "unsupported",
        `XML export declares unsupported encoding ${cause.declaredEncoding}.`,
        { cause },
      );
    if (cause.reason === "encoding-mismatch")
      throw new ProcmonExportFormatFailure(
        "format",
        "XML export encoding declaration disagrees with its bytes.",
        { cause },
      );
    throw new ProcmonExportFormatFailure(
      "unsupported",
      "XML export must use UTF-8 or BOM-marked UTF-16.",
      { cause },
    );
  }
};
