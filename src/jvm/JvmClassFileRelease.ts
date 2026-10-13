/** Identity of REA's in-process JVM class-file reader (no external engine). */
export const JVM_PROVIDER_IDENTITY = {
  id: "jvm-class-file",
  name: "REA JVM class-file reader",
  version: null,
} as const;

export const JVM_LIMITS = {
  /** A single class file far exceeding this is rejected before allocation. */
  inputBytes: 32 * 1024 * 1024,
  /**
   * Inline result ceiling. Input bounds alone do not bound the projected
   * result: a crafted class can declare millions of fixed-stride table entries
   * that expand into a far larger JSON object. Reject past this budget rather
   * than returning oversized Evidence, mirroring the Go/Rust in-process readers.
   */
  outputBytes: 8 * 1024 * 1024,
} as const;
