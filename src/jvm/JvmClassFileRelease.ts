/** Identity of REA's in-process JVM class-file reader (no external engine). */
export const JVM_PROVIDER_IDENTITY = {
  id: "jvm-class-file",
  name: "REA JVM class-file reader",
  version: null,
} as const;

export const JVM_LIMITS = {
  /** A single class file far exceeding this is rejected before allocation. */
  inputBytes: 32 * 1024 * 1024,
} as const;
