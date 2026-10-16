import { describe, expect, it } from "vitest";

import { selectedJvmMaxHeap } from "./GhidraLauncher.js";
import {
  ghidraJavaOutOfMemory,
  ghidraJvmMemoryArea,
} from "./GhidraMemoryExhaustion.js";

const output = (text: string) => ({ text, bytes: 0, retained_bytes: 0 });

describe("Ghidra JVM OutOfMemoryError detection", () => {
  it.each([
    [
      "ERROR Abort due to Headless analyzer error: java.lang.OutOfMemoryError: Java heap space (HeadlessAnalyzer)",
      "java.lang.OutOfMemoryError: Java heap space (HeadlessAnalyzer)",
    ],
    [
      'Exception in thread "main" java.lang.OutOfMemoryError: Metaspace\n\tat x',
      "java.lang.OutOfMemoryError: Metaspace",
    ],
    ["java.lang.OutOfMemoryError\n\tat x", "java.lang.OutOfMemoryError"],
  ])("reads %j", (text, expected) => {
    expect(ghidraJavaOutOfMemory({ stdout: output(text) })).toBe(expected);
    expect(ghidraJavaOutOfMemory({ stderr: output(text) })).toBe(expected);
  });

  it("bounds a long error detail", () => {
    const observed = ghidraJavaOutOfMemory({
      stdout: output(`java.lang.OutOfMemoryError: ${"x".repeat(500)}`),
    });
    expect(observed).toBe(`java.lang.OutOfMemoryError: ${"x".repeat(200)}`);
  });

  it.each([
    { stdout: output("OutOfMemoryError mentioned without the JVM class") },
    { stdout: "java.lang.OutOfMemoryError" },
    { target_path: "/tmp/java.lang.OutOfMemoryError" },
    {},
  ])("ignores text outside retained process streams: %j", (diagnostics) => {
    expect(ghidraJavaOutOfMemory(diagnostics)).toBeUndefined();
  });
});

describe("selected Ghidra JVM heap", () => {
  it("uses the last -Xmx passed to a POSIX JVM", () => {
    expect(
      selectedJvmMaxHeap(
        { arguments: ["-Xmx512M", "-showversion", "-Xmx4G", "ghidra.Ghidra"] },
        "darwin",
      ),
    ).toBe("4G");
    expect(selectedJvmMaxHeap({ arguments: ["-Xmx"] }, "linux")).toBe(
      undefined,
    );
    expect(selectedJvmMaxHeap({ arguments: [] }, "linux")).toBe(undefined);
  });

  it("reports only an explicit setting for the Windows script", () => {
    const heap = (environment: Record<string, string>) =>
      selectedJvmMaxHeap({ arguments: [], environment }, "win32");
    expect(heap({ GHIDRA_HEADLESS_MAXMEM: "6G", GHIDRA_MAXMEM: "3G" })).toBe(
      "6G",
    );
    expect(heap({ GHIDRA_HEADLESS_MAXMEM: "", GHIDRA_MAXMEM: "3G" })).toBe(
      "3G",
    );
    expect(heap({})).toBe(undefined);
  });
});

describe("Ghidra JVM memory area", () => {
  it.each([
    ["java.lang.OutOfMemoryError: Java heap space", "heap"],
    ["java.lang.OutOfMemoryError: GC overhead limit exceeded", "heap"],
    ["java.lang.OutOfMemoryError: Metaspace", "metaspace"],
    ["java.lang.OutOfMemoryError: Compressed class space", "metaspace"],
    [
      "java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached",
      "native",
    ],
    ["java.lang.OutOfMemoryError: Direct buffer memory", "native"],
    [
      "java.lang.OutOfMemoryError: Requested array size exceeds VM limit",
      "unknown",
    ],
    ["java.lang.OutOfMemoryError", "unknown"],
  ])("classifies %j as %s", (observed, area) => {
    expect(ghidraJvmMemoryArea(observed)).toBe(area);
  });
});
