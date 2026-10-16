import type {
  ProcessIdentityObservation,
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import {
  classifyProcessRunToken,
  readProcessRunTokens,
} from "./ProcessRunTokenObservations.js";
import { readLiveProcessTable } from "./ProcessOwnershipProcessTree.js";

export const TOKEN_READ_RETRY_ATTEMPTS = 3;
export const TOKEN_READ_RETRY_DELAY_MS = 40;

/** Proven OS withholding exonerates only unrelated candidates, never linked members. */
export const environmentWithheldFromInspection = (
  entry: ProcessTableEntry,
  diagnostic: string,
): boolean => {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  return (
    (uid !== undefined && entry.uid !== undefined && entry.uid !== uid) ||
    diagnostic === "platform_binary_environment_withheld" ||
    diagnostic === "restricted_process_environment_withheld"
  );
};

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
  | { readonly state: "exited" }
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
): Promise<{
  readonly observations: readonly {
    readonly process: ProcessTableEntry;
    readonly ownership: CandidateOwnership;
  }[];
  readonly refreshedProcesses?: readonly ProcessTableEntry[];
  readonly failure?: string;
}> => {
  if (processes.length === 0) return { observations: [] };
  const identities = new Map(expectedIdentities);
  const initial = await inspectCandidateSnapshot(
    processes,
    runId,
    host,
    identities,
  );
  for (const [pid, identity] of initial.identities)
    if (!identities.has(pid)) identities.set(pid, identity);
  let observations = initial.observations;
  let refreshedProcesses: readonly ProcessTableEntry[] | undefined;
  if (!observations.some(({ ownership }) => ownership.state === "unavailable"))
    return { observations };
  for (let attempt = 0; attempt < TOKEN_READ_RETRY_ATTEMPTS; attempt++) {
    const table = await readLiveProcessTable(host);
    if (!table.available)
      return {
        observations: observations.map((entry) =>
          entry.ownership.state === "unavailable"
            ? {
                ...entry,
                ownership: {
                  ...entry.ownership,
                  diagnostic: `${entry.ownership.diagnostic}; process liveness recheck failed: ${table.reason}`,
                },
              }
            : entry,
        ),
        ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
        failure: `process liveness recheck failed: ${table.reason}`,
      };
    refreshedProcesses = table.processes;
    const live = new Map(table.processes.map((entry) => [entry.pid, entry]));
    observations = observations.map((entry) =>
      entry.ownership.state !== "foreign" && !live.has(entry.process.pid)
        ? { ...entry, ownership: { state: "exited" } }
        : entry,
    );
    const pending = observations
      .filter(
        ({ ownership }) =>
          ownership.state === "unavailable" &&
          ownership.reason === "environment-unreadable",
      )
      .flatMap(({ process }) => {
        const current = live.get(process.pid);
        return current === undefined ? [] : [current];
      });
    if (pending.length === 0 || attempt === TOKEN_READ_RETRY_ATTEMPTS - 1)
      break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, TOKEN_READ_RETRY_DELAY_MS),
    );
    const retried = await inspectCandidateSnapshot(
      pending,
      runId,
      host,
      identities,
    );
    const replacements = new Map(
      retried.observations.map((entry) => [entry.process.pid, entry]),
    );
    observations = observations.map(
      (entry) => replacements.get(entry.process.pid) ?? entry,
    );
    // A recovered token still needs a post-read table; do not publish an older
    // refresh when that read reveals another live child or fails entirely.
  }
  return {
    observations,
    ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
  };
};

const inspectCandidateSnapshot = async (
  processes: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null>,
): Promise<{
  readonly observations: readonly {
    readonly process: ProcessTableEntry;
    readonly ownership: CandidateOwnership;
  }[];
  readonly identities: ReadonlyMap<number, string | null>;
}> => {
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
  const observations: {
    readonly process: ProcessTableEntry;
    readonly ownership: CandidateOwnership;
  }[] = processes.map((process) => {
    const token = tokens.get(process.pid);
    // A positive foreign token needs no signaling identity. Preserve it even
    // if that unrelated process exits before the post-read identity snapshot.
    if (token?.state === "foreign" && !expectedIdentities.has(process.pid))
      return { process, ownership: token };
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
  return {
    observations,
    identities: new Map(
      processes.map(({ pid }) => {
        const identity = before?.get(pid);
        return [pid, identity?.state === "readable" ? identity.identity : null];
      }),
    ),
  };
};
