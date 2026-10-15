import {
  PROCMON_CORE_COLUMNS,
  PROCMON_EXPORT_LIMITS,
} from "../domain/procmon/procmonExport.js";
import {
  partialCoverage,
  procmonCoreColumn,
  ProcmonExportFormatFailure,
  yieldToEventLoop,
  type ParsedProcmonExport,
  type ProcmonEventWindow,
} from "./ProcmonExportEvents.js";

/** Rows, or UTF-16 code units, parsed between event-loop yields. */
const ROWS_PER_SLICE = 4096;
const CHARACTERS_PER_SLICE = 1024 * 1024;

/** A syntax problem that ends reading; earlier rows remain valid. */
class CsvSyntaxStop {
  constructor(
    readonly reason: "truncated" | "malformed",
    readonly message: string,
    readonly line: number,
  ) {}
}

interface CsvRecord {
  readonly fields: string[];
  readonly line: number;
  readonly terminated: boolean;
  /** Source offset after the record, for yielding on characters read. */
  readonly end: number;
}

const isFieldEnd = (character: string | undefined): boolean =>
  character === undefined ||
  character === "," ||
  character === "\n" ||
  character === "\r";

const countLineFeeds = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1))
    count += 1;
  return count;
};

/** The next comma or row ending; a native search keeps long fields fast. */
const FIELD_END = /[,\r\n]/gu;

/** RFC 4180 fields with CRLF, LF or CR row endings. */
class CsvCursor {
  index = 0;
  line = 1;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.index >= this.text.length;
  }

  /** Consume one row ending; false when none is present. */
  lineEnding(): boolean {
    const { text, index } = this;
    if (text[index] === "\r" && text[index + 1] === "\n") this.index += 2;
    else if (text[index] === "\n" || text[index] === "\r") this.index += 1;
    else return false;
    this.line += 1;
    return true;
  }

  comma(): boolean {
    if (this.text[this.index] !== ",") return false;
    this.index += 1;
    return true;
  }

  field(recordLine: number): string {
    return this.text[this.index] === '"'
      ? this.#quoted(recordLine)
      : this.#unquoted();
  }

  #quoted(recordLine: number): string {
    this.index += 1;
    let value = "";
    for (;;) {
      const close = this.text.indexOf('"', this.index);
      if (close < 0)
        throw new CsvSyntaxStop(
          "truncated",
          "A quoted field is not closed before the end of the export.",
          recordLine,
        );
      const chunk = this.text.slice(this.index, close);
      value += chunk;
      this.line += countLineFeeds(chunk);
      this.index = close + 1;
      if (this.text[this.index] !== '"') break;
      value += '"';
      this.index += 1;
    }
    if (!isFieldEnd(this.text[this.index]))
      throw new CsvSyntaxStop(
        "malformed",
        "Unexpected text follows a closing quote.",
        this.line,
      );
    return value;
  }

  #unquoted(): string {
    FIELD_END.lastIndex = this.index;
    const end = FIELD_END.test(this.text)
      ? FIELD_END.lastIndex - 1
      : this.text.length;
    const value = this.text.slice(this.index, end);
    if (value.includes('"'))
      throw new CsvSyntaxStop(
        "malformed",
        "A quote appears inside an unquoted field.",
        this.line,
      );
    this.index = end;
    return value;
  }
}

/**
 * Records in source order; blank lines are skipped. A row stops before it
 * holds more than `width.maximum` fields, so a comma-filled line cannot
 * allocate one field per comma.
 */
function* csvRecords(
  text: string,
  width: { maximum: number },
): Generator<CsvRecord> {
  const cursor = new CsvCursor(text);
  while (!cursor.done) {
    if (cursor.lineEnding()) continue;
    const line = cursor.line;
    const fields: string[] = [];
    do {
      if (fields.length === width.maximum)
        throw new CsvSyntaxStop(
          "malformed",
          `Row has more than ${width.maximum} fields.`,
          line,
        );
      fields.push(cursor.field(line));
    } while (cursor.comma());
    const terminated = cursor.lineEnding();
    yield { fields, line, terminated, end: cursor.index };
  }
}

const readHeader = (records: Generator<CsvRecord>): string[] => {
  let first: IteratorResult<CsvRecord>;
  try {
    first = records.next();
  } catch (cause: unknown) {
    if (!(cause instanceof CsvSyntaxStop)) throw cause;
    throw new ProcmonExportFormatFailure(
      "format",
      `CSV header row is unreadable: ${cause.message}`,
    );
  }
  if (first.done === true)
    throw new ProcmonExportFormatFailure(
      "format",
      "CSV export is empty; expected a header row.",
    );
  validateHeader(first.value.fields);
  return first.value.fields;
};

const validateHeader = (header: readonly string[]): void => {
  const seen = new Set<string>();
  for (const column of header) {
    if (column === "")
      throw new ProcmonExportFormatFailure(
        "format",
        "CSV header contains an empty column name.",
      );
    if (seen.has(column))
      throw new ProcmonExportFormatFailure(
        "format",
        `CSV header repeats column ${JSON.stringify(column.slice(0, 200))}.`,
      );
    seen.add(column);
  }
  if (!header.some((column) => procmonCoreColumn(column, "csv") !== undefined))
    throw new ProcmonExportFormatFailure(
      "format",
      `CSV header names none of the Process Monitor columns ${PROCMON_CORE_COLUMNS.join(", ")}.`,
    );
};

/** A final row without its line ending and with too few fields was cut off. */
const mismatchCoverage = (record: CsvRecord, width: number) =>
  !record.terminated && record.fields.length < width
    ? partialCoverage(
        "truncated",
        `The final row has ${record.fields.length} of ${width} fields and no line ending.`,
        record.line,
      )
    : partialCoverage(
        "malformed",
        `Row has ${record.fields.length} fields; the header has ${width}.`,
        record.line,
      );

/** Read a header row, then one event per row until the end or the first bad row. */
export const readProcmonCsv = async (
  text: string,
  window: ProcmonEventWindow,
  signal?: AbortSignal,
  endsInsideCharacter = false,
): Promise<ParsedProcmonExport> => {
  const width: { maximum: number } = {
    maximum: PROCMON_EXPORT_LIMITS.columns,
  };
  const records = csvRecords(text, width);
  const columns = readHeader(records);
  for (const column of columns) window.charge(column);
  width.maximum = columns.length;
  const stop = (coverage: ParsedProcmonExport["coverage"]) => ({
    columns,
    nested: [],
    coverage,
  });
  try {
    let rows = 0;
    let yieldedAt = 0;
    for (const record of records) {
      // The unterminated final row lost the bytes of its cut character.
      if (endsInsideCharacter && !record.terminated)
        return stop(
          partialCoverage(
            "truncated",
            "The final row ends inside a character and was not read.",
            record.line,
          ),
        );
      if (record.fields.length !== columns.length)
        return stop(mismatchCoverage(record, columns.length));
      window.add(
        new Map(columns.map((column, at) => [column, record.fields[at] ?? ""])),
      );
      rows += 1;
      if (
        rows % ROWS_PER_SLICE === 0 ||
        record.end - yieldedAt >= CHARACTERS_PER_SLICE
      ) {
        yieldedAt = record.end;
        await yieldToEventLoop(signal);
      }
    }
  } catch (cause: unknown) {
    if (!(cause instanceof CsvSyntaxStop)) throw cause;
    return stop(partialCoverage(cause.reason, cause.message, cause.line));
  }
  return stop({ status: "complete" });
};
