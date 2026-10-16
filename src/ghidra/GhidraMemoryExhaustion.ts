import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";

const JAVA_OUT_OF_MEMORY =
  /java\.lang\.OutOfMemoryError(?::[ \t]*([^\r\n]*))?/u;
const MAX_DETAIL_CHARACTERS = 200;

const streamText = (stream: JsonValue | undefined): string | undefined =>
  typeof stream === "object" &&
  stream !== null &&
  !Array.isArray(stream) &&
  typeof stream.text === "string"
    ? stream.text
    : undefined;

/** The first JVM OutOfMemoryError in Ghidra's retained process output, if any. */
export const ghidraJavaOutOfMemory = (
  diagnostics: Readonly<Record<string, JsonValue>>,
): string | undefined => {
  for (const stream of [diagnostics.stdout, diagnostics.stderr]) {
    const text = streamText(stream);
    const match = text === undefined ? null : JAVA_OUT_OF_MEMORY.exec(text);
    if (match === null) continue;
    const detail = (match[1] ?? "").trim().slice(0, MAX_DETAIL_CHARACTERS);
    return detail === ""
      ? "java.lang.OutOfMemoryError"
      : `java.lang.OutOfMemoryError: ${detail}`;
  }
  return undefined;
};

/** Which JVM memory area an OutOfMemoryError detail names; only "heap" follows -Xmx. */
type GhidraJvmMemoryArea = "heap" | "metaspace" | "native" | "unknown";

export const ghidraJvmMemoryArea = (observed: string): GhidraJvmMemoryArea => {
  const detail = observed.replace(/^java\.lang\.OutOfMemoryError:?\s*/u, "");
  if (/^(?:Java heap space|GC overhead limit exceeded)/u.test(detail))
    return "heap";
  if (/^(?:Metaspace|Compressed class space)/u.test(detail)) return "metaspace";
  if (
    /^(?:unable to create (?:new )?native thread|Direct buffer memory)/u.test(
      detail,
    )
  )
    return "native";
  return "unknown";
};

const remediation = (
  area: GhidraJvmMemoryArea,
  maxHeap: string | null,
): string => {
  const analyzers =
    "skip heavy analyzers with REA_GHIDRA_DISABLED_ANALYZERS. Then open the target again. `rea doctor` does not check memory limits.";
  if (area === "heap")
    return `Set GHIDRA_HEADLESS_MAXMEM${maxHeap === null ? "" : ` above ${maxHeap}`} in the environment that starts REA, keeping it within available host memory, or ${analyzers}`;
  const outside =
    area === "native"
      ? "Check available host memory and the process and thread limits of the account that runs REA"
      : area === "metaspace"
        ? "Check available host memory; Java metaspace is not sized by the heap setting"
        : "Check which JVM memory area was exhausted in details.diagnostics and the available host memory";
  return `${outside}. GHIDRA_HEADLESS_MAXMEM only sets the Java heap (-Xmx) and may not help here, and a larger heap leaves less memory for the rest of the JVM. You can also ${analyzers}`;
};

/**
 * Classify a failed Ghidra session as memory exhaustion when its own output
 * shows a JVM OutOfMemoryError. The observed error does not establish which
 * allocation failed, so the reported limit is the configured maximum heap and
 * the JVM memory area its detail names.
 */
export const ghidraMemoryExhaustionError = (
  operation: string,
  failure: GhidraSessionError,
  context: AnalysisErrorOptions,
): AnalysisResourceConstraintError | undefined => {
  if (failure.kind === "cancelled" || failure.kind === "remote")
    return undefined;
  const observed = ghidraJavaOutOfMemory(failure.diagnostics);
  if (observed === undefined) return undefined;
  const heap = failure.diagnostics.jvm_max_heap;
  const maxHeap = typeof heap === "string" && heap !== "" ? heap : null;
  const area = ghidraJvmMemoryArea(observed);
  return new AnalysisResourceConstraintError(
    operation,
    "memory",
    `Ghidra's JVM ran out of memory (${observed}) with ${maxHeap === null ? "an unknown maximum heap" : `a maximum heap of ${maxHeap}`}.`,
    { jvm_max_heap: maxHeap, jvm_memory_area: area },
    { ...context, remediationAction: remediation(area, maxHeap) },
  );
};
