import { randomUUID } from "node:crypto";

/** Label fixture-owned peers without replacing an explicitly selected run token. */
export const fixtureProcessEnvironment = (
  environment: Readonly<Record<string, string>>,
): Record<string, string> => ({
  REA_PROCESS_RUN_ID: randomUUID(),
  ...environment,
});
