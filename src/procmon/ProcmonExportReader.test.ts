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
