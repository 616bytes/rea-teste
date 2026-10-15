import { describe, expect, it } from "vitest";
import { readProcmonExport } from "./ProcmonExportReader.js";

const selection = { format: "auto", event_offset: 0, event_limit: 1 } as const;
const header = '"Process Name","Operation"\n';

describe("readProcmonExport cancellation", () => {
  it("stops between parsing slices once the caller aborts", async () => {
    const bytes = Buffer.from(header + '"a.exe","Read"\n'.repeat(20_000));
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(
      readProcmonExport(bytes, selection, controller.signal),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports cancellation instead of partial coverage for XML", async () => {
    const event = "<event><Process_Name>a.exe</Process_Name></event>";
    const bytes = Buffer.from(
      `<procmon><eventlist>${event.repeat(60_000)}</eventlist></procmon>`,
    );
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(
      readProcmonExport(bytes, selection, controller.signal),
    ).rejects.toThrow();
  });
});

describe("readProcmonExport damaged and large exports", () => {
  it("does not return a final row whose last character was cut off", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`${header}"a.exe","Read"\n"b.exe",caf`),
      Buffer.from([0xc3]),
    ]);
    const reading = await readProcmonExport(bytes, {
      ...selection,
      event_limit: null,
    });
    expect(reading.events.map((event) => event.process_name)).toEqual([
      "a.exe",
    ]);
    expect(reading.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
      line: 3,
    });
  });

  it("admits a page whose serialized events fit the output budget", async () => {
    const columns =
      '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"\n';
    const row = `"9:41:07.1234567 AM","sample.exe","4120","ReadFile","C:\\\\data\\\\file.bin","SUCCESS","${"d".repeat(90)}"\n`;
    const bytes = Buffer.from(columns + row.repeat(28_000));
    const reading = await readProcmonExport(bytes, {
      ...selection,
      event_limit: null,
    });
    const serialized = Buffer.byteLength(JSON.stringify(reading.events));
    expect(reading.events).toHaveLength(28_000);
    expect(serialized).toBeGreaterThan(7 * 1024 * 1024);
    expect(serialized).toBeLessThan(8 * 1024 * 1024);
  });
});
