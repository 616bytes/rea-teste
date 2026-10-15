import {
  PROCMON_EXPORT_LIMITS,
  type ProcmonCoreColumn,
  type ProcmonEvent,
  type ProcmonExport,
} from "../domain/procmon/procmonExport.js";

/** The export is not a readable Process Monitor XML or CSV document. */
export class ProcmonExportFormatFailure extends Error {
  constructor(
    readonly kind: "format" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcmonExportFormatFailure";
  }
}

/** The selected event window does not fit the inline output budget. */
export class ProcmonExportOutputFailure extends Error {
  constructor(readonly retainedEvents: number) {
    super(
      `Selected events exceed the ${PROCMON_EXPORT_LIMITS.output_bytes}-byte inline output budget after ${retainedEvents} events; choose a smaller event_limit.`,
    );
    this.name = "ProcmonExportOutputFailure";
  }
}

export type ProcmonCoverage = ProcmonExport["coverage"];

/** Format-independent facts one parser reports about the whole export. */
export interface ParsedProcmonExport {
  readonly columns: string[];
  readonly nested: string[];
  readonly coverage: ProcmonCoverage;
}

export const partialCoverage = (
  reason: "truncated" | "malformed",
  message: string,
  line: number | null,
): ProcmonCoverage => ({ status: "partial", reason, message, line });

/** XML field names spell spaces as underscores. */
export const procmonColumnName = (column: string): string =>
  column.replaceAll("_", " ");

const CORE_FIELDS: Readonly<
  Record<
    ProcmonCoreColumn,
    Exclude<keyof ProcmonEvent, "ordinal" | "additional">
  >
> = {
  "Time of Day": "time_of_day",
  "Process Name": "process_name",
  PID: "pid",
  Operation: "operation",
  Path: "path",
  Result: "result",
  Detail: "detail",
};

/** The named event field for a projected column, or undefined for others. */
export const procmonCoreField = (column: string) => {
  const name = procmonColumnName(column);
  return Object.hasOwn(CORE_FIELDS, name)
    ? CORE_FIELDS[name as ProcmonCoreColumn]
    : undefined;
};

/** Count every event in source order; build and admit only the selected window. */
export class ProcmonEventWindow {
  examined = 0;
  readonly events: ProcmonEvent[] = [];
  #bytes = 0;
  constructor(
    readonly offset: number,
    readonly limit: number | null,
  ) {}

  add(fields: ReadonlyMap<string, string>): void {
    this.examined += 1;
    if (
      this.examined <= this.offset ||
      (this.limit !== null && this.events.length >= this.limit)
    )
      return;
    const event: ProcmonEvent = {
      ordinal: this.examined,
      time_of_day: null,
      process_name: null,
      pid: null,
      operation: null,
      path: null,
      result: null,
      detail: null,
      additional: {},
    };
    for (const [column, value] of fields) {
      const field = procmonCoreField(column);
      if (field === undefined) event.additional[column] = value;
      else event[field] = value;
    }
    this.#bytes += Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (this.#bytes > PROCMON_EXPORT_LIMITS.output_bytes)
      throw new ProcmonExportOutputFailure(this.events.length);
    this.events.push(event);
  }
}
