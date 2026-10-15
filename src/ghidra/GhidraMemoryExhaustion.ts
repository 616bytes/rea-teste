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

/**
 * Classify a failed Ghidra session as memory exhaustion when its own output
 * shows a JVM OutOfMemoryError. The observed error does not establish which
 * allocation failed, so the reported limit is the configured maximum heap.
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
  return new AnalysisResourceConstraintError(
    operation,
    "memory",
    `Ghidra's JVM ran out of memory (${observed}) with ${maxHeap === null ? "an unknown maximum heap" : `a maximum heap of ${maxHeap}`}.`,
    { jvm_max_heap: maxHeap },
    {
      ...context,
      remediationAction: `Set GHIDRA_HEADLESS_MAXMEM${maxHeap === null ? "" : ` above ${maxHeap}`} in the environment that starts REA, keeping it within available host memory, or skip heavy analyzers with REA_GHIDRA_DISABLED_ANALYZERS. Then open the target again. \`rea doctor\` does not check heap size.`,
    },
  );
};
