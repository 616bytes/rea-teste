import type {
  ProcessIdentityObservation,
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import {
  classifyProcessRunToken,
  readProcessRunTokens,
} from "./ProcessRunTokenObservations.js";

/** A refreshed row is new evidence when its PID or observed relation changes. */
export const refreshedProcessCandidates = (
  previous: readonly ProcessTableEntry[],
  refreshed: readonly ProcessTableEntry[],
): readonly ProcessTableEntry[] => {
  const before = new Map(previous.map((entry) => [entry.pid, entry]));
  return refreshed.filter(({ pid, parentPid, processGroupId }) => {
    const old = before.get(pid);
    return (
      old === undefined ||
      old.parentPid !== parentPid ||
      old.processGroupId !== processGroupId
    );
  });
};

type CandidateOwnership =
  | { readonly state: "owned"; readonly identity: string | null }
  | { readonly state: "foreign" }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "environment-unreadable"
        | "process-identity-unavailable";
      readonly diagnostic: string;
    };

const identityDiagnostic = (
  observation: ProcessIdentityObservation | undefined,
): string =>
  observation?.state === "readable"
    ? "process start identity changed during refreshed ownership inspection"
    : `process start identity unavailable during refreshed ownership inspection: ${observation?.reason ?? "process identity was not returned"}`;

/** Token proof and native start identity travel together across refresh consumers. */
export const readProcessOwnershipCandidates = async (
  processes: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null> = new Map(),
): Promise<
  readonly {
    readonly process: ProcessTableEntry;
    readonly ownership: CandidateOwnership;
  }[]
> => {
  if (processes.length === 0) return [];
  const before = await host.processIdentities?.(processes);
  const readable = processes.filter(
    ({ pid }) => before === undefined || before.get(pid)?.state === "readable",
  );
  const tokens = new Map<number, ReturnType<typeof classifyProcessRunToken>>();
  for await (const { process, observation } of readProcessRunTokens(
    host,
    readable,
  ))
    tokens.set(process.pid, classifyProcessRunToken(observation, runId));
  const after = await host.processIdentities?.(readable);
  return processes.map((process) => {
    const initial = before?.get(process.pid);
    const current = after?.get(process.pid);
    if (
      before !== undefined &&
      (initial?.state !== "readable" ||
        current?.state !== "readable" ||
        initial.identity !== current.identity ||
        (expectedIdentities.has(process.pid) &&
          current.identity !== expectedIdentities.get(process.pid)))
    )
      return {
        process,
        ownership: {
          state: "unavailable",
          reason: "process-identity-unavailable",
          diagnostic: identityDiagnostic(
            initial?.state === "readable" ? current : initial,
          ),
        },
      };
    const token = tokens.get(process.pid);
    if (token?.state === "foreign") return { process, ownership: token };
    if (token?.state === "owned")
      return {
        process,
        ownership: {
          state: "owned",
          identity: initial?.state === "readable" ? initial.identity : null,
        },
      };
    return {
      process,
      ownership: {
        state: "unavailable",
        reason: "environment-unreadable",
        diagnostic: token?.reason ?? "run token was not returned",
      },
    };
  });
};
