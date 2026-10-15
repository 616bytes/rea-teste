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
  procmonColumnName,
  ProcmonEventWindow,
  ProcmonExportFormatFailure,
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
export const readProcmonExport = (
  bytes: Uint8Array,
  selection: Pick<
    InspectProcmonExportInput,
    "format" | "event_offset" | "event_limit"
  >,
): ProcmonExportReading => {
  const { encoding, byteOrderMark } = detectEncoding(bytes);
  const format =
    selection.format === "auto"
      ? detectFormat(bytes, encoding)
      : selection.format;
  const window = new ProcmonEventWindow(
    selection.event_offset,
    selection.event_limit,
  );
  const parsed =
    format === "xml"
      ? readProcmonXml(decodeXml(bytes), window)
      : readProcmonCsv(decodeText(bytes, encoding), window);
  const present = new Set(parsed.columns.map(procmonColumnName));
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
    coverage: parsed.coverage,
  };
};

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

/** Only the leading bytes select the format; the full parse validates them. */
const detectFormat = (bytes: Uint8Array, encoding: Encoding): "xml" | "csv" => {
  const prefix = new TextDecoder(encoding).decode(bytes.subarray(0, 1024));
  return /^\s*</u.test(prefix) ? "xml" : "csv";
};

const decodeText = (bytes: Uint8Array, encoding: Encoding): string => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new ProcmonExportFormatFailure(
      "unsupported",
      `Export bytes are not valid ${encoding}. Supported encodings are UTF-8 and BOM-marked UTF-16; re-save the export as UTF-8.`,
      { cause },
    );
  }
};

const decodeXml = (bytes: Uint8Array): string => {
  try {
    return decodeXmlPlistText(bytes);
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
