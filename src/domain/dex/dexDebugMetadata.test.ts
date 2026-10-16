import { describe, expect, it } from "vitest";

import { dexWorkBudget } from "./dexDebugInfo.js";
import {
  assembleClassDetail,
  type DexWork,
  summarizeDex,
} from "./dexDebugMetadata.js";
import { parseDexFile } from "./dexFile.js";
import { debuggableDex } from "../../../tests/fixtures/dexFile.js";

const work = (limit = 1_000_000, cancelled = false): DexWork => ({
  budget: dexWorkBudget(limit),
  cancelled: () => cancelled,
});
const OUTPUT_LIMIT = 8 * 1024 * 1024;

describe("dexDebugMetadata assembly", () => {
  it("summarizes a debuggable dex with resolved tallies and readiness", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = summarizeDex(parsed.value, debuggableDex(), work());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;
    expect(summary.classCount).toBe(1);
    expect(summary.methodsWithCode).toBe(1);
    expect(summary.methodsWithDebugInfo).toBe(1);
    expect(summary.methodsWithParameterNames).toBe(1);
    expect(summary.linePositions).toBe(1);
    expect(summary.localDeclarations).toBe(1);
    expect(summary.sourceFilePresent).toBe(1);
    expect(summary.distinctSourceFiles).toEqual({
      count: 1,
      sample: ["Foo.java"],
    });
    expect(summary.readiness).toBe("present");
  });

  it("resolves full per-method detail for a selected class", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = assembleClassDetail(
      parsed.value,
      debuggableDex(),
      "Lcom/example/Foo;",
      work(),
      OUTPUT_LIMIT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const detail = result.value;
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.sourceFile).toBe("Foo.java");
    expect(detail.methods).toHaveLength(1);
    const method = detail.methods[0]!;
    expect(method.name).toBe("run");
    expect(method.descriptor).toBe("(I)V");
    expect(method.state).toBe("present");
    expect(method.parameterNames).toEqual(["x"]);
    expect(method.locals).toHaveLength(1);
    expect(method.locals[0]).toMatchObject({
      register: 0,
      name: "x",
      type: "I",
      outOfRange: false,
    });
  });

  it("returns null for a class descriptor not present", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = assembleClassDetail(
      parsed.value,
      debuggableDex(),
      "LNope;",
      work(),
      OUTPUT_LIMIT,
    );
    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("dexDebugMetadata work and output bounds", () => {
  it("refuses once the call-wide opcode budget is spent", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(summarizeDex(parsed.value, debuggableDex(), work(1))).toEqual({
      ok: false,
      error: { kind: "work-budget-exceeded", limit: 1 },
    });
  });

  it("stops when the caller cancels", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      summarizeDex(parsed.value, debuggableDex(), work(1_000_000, true)),
    ).toEqual({ ok: false, error: { kind: "cancelled" } });
  });

  it("refuses a class detail past the output limit before building it", () => {
    const parsed = parseDexFile(debuggableDex());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = assembleClassDetail(
      parsed.value,
      debuggableDex(),
      "Lcom/example/Foo;",
      work(),
      1200,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("output-budget-exceeded");
  });
});

describe("dexDebugMetadata unreadable structures", () => {
  it("reports unreadable class_data and reads readiness as unknown, not stripped", () => {
    const bytes = debuggableDex();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const classDefsOff = view.getUint32(100, true);
    view.setUint32(classDefsOff + 24, bytes.length + 100, true); // class_data_off past the file
    const parsed = parseDexFile(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = summarizeDex(parsed.value, bytes, work());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unreadable.classData).toBe(1);
    expect(result.value.readiness).toBe("unknown");
  });
});

/** Byte offsets of the fixture's class_def, class_data, code_item and debug_info. */
const layoutOf = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const classDefsOff = view.getUint32(100, true);
  const classDataOff = view.getUint32(classDefsOff + 24, true);
  const codeOff = classDataOff - 24; // 16-byte header + 4 code units
  return {
    view,
    classDefsOff,
    classDataOff,
    codeOff,
    debugInfoOff: codeOff - 5,
  };
};

/** The fixture with a second class_def (a copy whose class_idx is `classIdx`). */
const withSecondClassDef = (classIdx: number): Uint8Array => {
  const base = debuggableDex();
  const { classDefsOff } = layoutOf(base);
  const bytes = new Uint8Array(base.length + 32);
  bytes.set(base);
  bytes.set(base.subarray(classDefsOff, classDefsOff + 32), base.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(base.length, classIdx, true);
  view.setUint32(32, bytes.length, true); // file_size
  view.setUint32(96, 2, true); // class_defs_size
  return bytes;
};

const summaryOf = (bytes: Uint8Array) => {
  const parsed = parseDexFile(bytes);
  if (!parsed.ok) throw new Error("fixture must frame");
  const result = summarizeDex(parsed.value, bytes, work());
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
};

const detailOf = (bytes: Uint8Array, limit = OUTPUT_LIMIT) => {
  const parsed = parseDexFile(bytes);
  if (!parsed.ok) throw new Error("fixture must frame");
  return assembleClassDetail(
    parsed.value,
    bytes,
    "Lcom/example/Foo;",
    work(),
    limit,
  );
};

describe("dexDebugMetadata fails closed on unverifiable facts", () => {
  it("reports an unreadable class identity as unknown, never as absent", () => {
    const result = detailOf(withSecondClassDef(0xfffe));
    expect(result).toEqual({
      ok: false,
      error: { kind: "unreadable-class-identity", count: 1 },
    });
  });

  it("refuses a class declared by two class_defs as ambiguous", () => {
    const result = detailOf(withSecondClassDef(0));
    expect(result).toEqual({
      ok: false,
      error: { kind: "duplicate-class-definition", count: 2 },
    });
  });

  it("refuses an oversized methodless class before decoding its source file", () => {
    const bytes = debuggableDex();
    const { view, classDefsOff } = layoutOf(bytes);
    view.setUint32(classDefsOff + 24, 0, true); // no class_data
    const result = detailOf(bytes, 1030);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("output-budget-exceeded");
  });

  it("treats instructions running past the member as an unreadable code_item", () => {
    const bytes = debuggableDex();
    const { view, codeOff } = layoutOf(bytes);
    view.setUint32(codeOff + 12, 0x7fff_ffff, true); // insns_size
    const summary = summaryOf(bytes);
    expect(summary.unreadable.codeItems).toBe(1);
    expect(summary.linePositions).toBe(0);
    expect(summary.readiness).toBe("unknown");
  });

  it("marks a parameter-name count that disagrees with the proto malformed", () => {
    const bytes = debuggableDex();
    const { debugInfoOff } = layoutOf(bytes);
    bytes[debugInfoOff + 1] = 0; // parameters_size 0 for a one-parameter proto
    const summary = summaryOf(bytes);
    expect(summary.unreadable.debugInfo).toBe(1);
    expect(summary.methodsWithParameterNames).toBe(0);
    expect(summary.readiness).toBe("unknown");
  });

  it("does not count a local declaration that fails validation", () => {
    const bytes = debuggableDex();
    const { debugInfoOff } = layoutOf(bytes);
    bytes[debugInfoOff + 3] = 0x03; // DBG_START_LOCAL
    bytes[debugInfoOff + 4] = 0x05; // register 5 of a 1-register frame
    const summary = summaryOf(bytes);
    expect(summary.unreadable.debugInfo).toBe(1);
    expect(summary.explicitLocalDeclarations).toBe(0);
  });
});

describe("dexDebugMetadata validates the frame and class identities", () => {
  it("marks a method whose ins_size disagrees with its proto malformed", () => {
    const bytes = debuggableDex();
    const { view, codeOff } = layoutOf(bytes);
    view.setUint16(codeOff + 2, 0, true); // ins_size 0 for a one-int static method
    const summary = summaryOf(bytes);
    expect(summary.unreadable.debugInfo).toBe(1);
    expect(summary.readiness).toBe("unknown");
  });

  it("treats more incoming arguments than registers as an unreadable code_item", () => {
    const bytes = debuggableDex();
    const { view, codeOff } = layoutOf(bytes);
    view.setUint16(codeOff + 2, 2, true); // ins_size 2 of a 1-register frame
    expect(summaryOf(bytes).unreadable.codeItems).toBe(1);
  });

  it("matches a class by its modified-UTF-8 bytes, not a near miss", () => {
    const result = detailOf(debuggableDex());
    expect(result.ok && result.value?.descriptor).toBe("Lcom/example/Foo;");
    const parsed = parseDexFile(debuggableDex());
    if (!parsed.ok) throw new Error("fixture must frame");
    for (const near of ["Lcom/example/Foo", "Lcom/example/Fo\u00f6;", ""])
      expect(
        assembleClassDetail(
          parsed.value,
          debuggableDex(),
          near,
          work(),
          OUTPUT_LIMIT,
        ),
      ).toEqual({ ok: true, value: null });
  });
});
