import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessOwnershipHost,
  type ProcessIdentityObservation,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ownership } from "./ProcessOwnership.fixture.js";
import { ProcessCaptureResourceScope } from "./capture/ProcessCaptureLifecycle.js";

const launcher: ProcessTableEntry = {
  pid: 100,
  parentPid: 1,
  processGroupId: 100,
  state: "S",
  command: "fixture",
};

const reparentedIdentityInspector =
  (context: {
    readonly token: string;
    readonly childPid: number;
    readonly childReads: () => number;
    readonly observeExit: () => void;
  }): NonNullable<ProcessOwnershipHost["processIdentities"]> =>
  async (members) =>
    new Map<number, ProcessIdentityObservation>(
      members.map(({ pid }) => {
        const isChild = pid === context.childPid;
        const reads = context.childReads();
        const foreignExited =
          isChild &&
          context.token === "foreign-afterread-unavailable" &&
          reads > 0;
        if ((isChild && context.token === "identity-exited") || foreignExited)
          context.observeExit();
        if (
          isChild &&
          (context.token === "identity-unavailable" ||
            context.token === "identity-exited")
        )
          return [pid, { state: "unavailable", reason: "inspection denied" }];
        if (foreignExited)
          return [
            pid,
            { state: "unavailable", reason: "exited after foreign token read" },
          ];
        const reused =
          isChild &&
          ((context.token === "reused" && reads > 0) ||
            (context.token === "recovered-reused" && reads > 1));
        return [
          pid,
          {
            state: "readable",
            identity: reused ? "replacement-start" : `start-${String(pid)}`,
          },
        ];
      }),
    );

it("reports exhausted sweep discovery as incomplete coverage rather than a PID identity failure", async () => {
  let generation = 0;
  const signalGroup = vi.fn();
  const result = await verifyNoTokenOwnedProcesses(ownership.runId, {
    listProcesses: async () => [
      {
        ...launcher,
        pid: 1000 + ++generation,
        processGroupId: 1000 + generation,
      },
    ],
    processIdentities: async (members) =>
      new Map(
        members.map(({ pid }) => [
          pid,
          { state: "readable" as const, identity: `start-${String(pid)}` },
        ]),
      ),
    environment: async () => ({ REA_PROCESS_RUN_ID: "other-run" }),
    signalGroup,
  });
  expect(result).toEqual({
    cleaned: false,
    reason:
      "process ownership discovery could not complete within its retry budget; unexamined live candidates 1004=processes kept changing during bounded ownership sweep",
    failures: [
      {
        pid: 1004,
        reason: "process-discovery-incomplete",
        diagnostic: "processes kept changing during bounded ownership sweep",
      },
    ],
  });
  expect(generation).toBe(4);
  expect(signalGroup).not.toHaveBeenCalled();
});

it("keeps newer ownership failures from refreshed sweeps attached to their groups", async () => {
  const peer = { ...launcher, pid: 200, processGroupId: 200 };
  const neighbor = { ...launcher, pid: 900, processGroupId: 900 };
  let rows = [launcher, peer, neighbor];
  let launcherReads = 0;
  let recovered = false;
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const adapter: ProcessOwnershipHost = {
    listProcesses: async () => rows,
    environment: async (pid) => {
      if (pid === neighbor.pid) return { REA_PROCESS_RUN_ID: "other-run" };
      if (pid === launcher.pid && ++launcherReads >= 4 && !recovered) return {};
      return { REA_PROCESS_RUN_ID: ownership.runId };
    },
    signalGroup,
  };
  const swept = { ...ownership, sweepTokenOwnedProcesses: true };
  const result = await cleanupOwnedProcessGroup(swept, adapter);
  expect(result).toMatchObject({
    cleaned: false,
    failures: [{ pid: launcher.pid, reason: "environment-unreadable" }],
  });
  expect(signalGroup.mock.calls).toEqual([[200, "SIGKILL"]]);
  expect(rows).toEqual([launcher, neighbor]);
  recovered = true;
  await expect(cleanupOwnedProcessGroup(swept, adapter)).resolves.toEqual({
    cleaned: true,
    signaled: true,
  });
  expect(signalGroup.mock.calls).toEqual([
    [200, "SIGKILL"],
    [100, "SIGKILL"],
  ]);
  expect(rows).toEqual([neighbor]);
});

it.each(["recovered", "reused"])(
  "reconciles pre-signal sweep uncertainty against the final %s ownership check",
  async (state) => {
    const neighbor = { ...launcher, pid: 900, processGroupId: 900 };
    let launcherReads = 0;
    const signalGroup = vi.fn();
    const result = await cleanupOwnedProcessGroup(
      { ...ownership, sweepTokenOwnedProcesses: true, captureBaseline: [] },
      {
        listProcesses: async () => [launcher, neighbor],
        processIdentities: async (members) =>
          new Map(
            members.map(({ pid }) => [
              pid,
              {
                state: "readable" as const,
                identity:
                  pid === launcher.pid &&
                  state === "reused" &&
                  launcherReads >= 7
                    ? "replacement-start"
                    : `start-${String(pid)}`,
              },
            ]),
          ),
        environment: async (pid) => {
          if (pid === neighbor.pid) return { REA_PROCESS_RUN_ID: "other-run" };
          launcherReads++;
          return launcherReads >= 3 && launcherReads < 7
            ? {}
            : { REA_PROCESS_RUN_ID: ownership.runId };
        },
        signalGroup,
      },
    );
    if (state === "recovered") {
      expect(result).toEqual({ cleaned: true, signaled: true });
      expect(signalGroup).toHaveBeenCalledExactlyOnceWith(100, "SIGKILL");
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          { pid: launcher.pid, reason: "process-identity-unavailable" },
        ],
      });
      expect(signalGroup).not.toHaveBeenCalled();
    }
  },
);

it("preserves native identity failure diagnostics through capture cleanup and retry", async () => {
  let rows = [launcher];
  let inspectionUnavailable = true;
  const adapter: ProcessOwnershipHost = {
    platform: "darwin",
    listProcesses: async () => rows,
    processIdentities: async (members) =>
      new Map<number, ProcessIdentityObservation>(
        members.map(({ pid }) => [
          pid,
          inspectionUnavailable
            ? { state: "unavailable", reason: "process_table_failed_12" }
            : { state: "readable", identity: `start-${String(pid)}` },
        ]),
      ),
    environment: async () => ({ REA_PROCESS_RUN_ID: ownership.runId }),
    signalGroup: () => {
      rows = [];
    },
  };
  const removeTemporaryRoot = vi.fn(async () => undefined);
  const scope = new ProcessCaptureResourceScope();
  try {
    const report = await scope.release({
      timers: new Set(),
      terminal: { pid: launcher.pid },
      renderer: undefined,
      runId: ownership.runId,
      temporaryRoot: "/fixture/root",
      captureBaseline: [],
      host: {
        platform: "darwin",
        cleanupProcessGroup: (owned) =>
          cleanupOwnedProcessGroup(owned, adapter),
        verifyTokenOwnedProcesses: (runId, _host, baseline, relation) =>
          verifyNoTokenOwnedProcesses(runId, adapter, baseline, relation),
        removeTemporaryRoot,
      },
    });
    expect(report.owned_process_group).toEqual({
      state: "unverified",
      reason:
        "process identity could not be revalidated; live candidates 100=process identity changed or became unavailable before signal: process_table_failed_12",
    });
    expect(report.temporary_root.state).toBe("unverified");
    expect(removeTemporaryRoot).not.toHaveBeenCalled();
    inspectionUnavailable = false;
    await scope.retryCleanup();
    expect(rows).toEqual([]);
    expect(removeTemporaryRoot).toHaveBeenCalledExactlyOnceWith(
      "/fixture/root",
    );
  } finally {
    inspectionUnavailable = false;
    await scope.close();
  }
});

it("retains captured start identities when discovering another group forces replanning", async () => {
  const child = { ...launcher, pid: 300, processGroupId: 300 };
  const neighbor = { ...launcher, pid: 900, processGroupId: 900 };
  let rows = [launcher, neighbor];
  let launcherReads = 0;
  let reused = false;
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const result = await cleanupOwnedProcessGroup(
    { ...ownership, sweepTokenOwnedProcesses: true, captureBaseline: [] },
    {
      listProcesses: async () => rows,
      processIdentities: async (members) =>
        new Map(
          members.map(({ pid }) => [
            pid,
            {
              state: "readable" as const,
              identity:
                pid === launcher.pid && reused
                  ? "replacement-start"
                  : `start-${String(pid)}`,
            },
          ]),
        ),
      environment: async (pid) => {
        if (pid === neighbor.pid) return { REA_PROCESS_RUN_ID: "other-run" };
        if (pid === launcher.pid && ++launcherReads === 2) {
          reused = true;
          rows = [launcher, child, neighbor];
          return {};
        }
        return { REA_PROCESS_RUN_ID: ownership.runId };
      },
      signalGroup,
    },
  );
  expect(result).toMatchObject({
    cleaned: false,
    failures: [{ pid: launcher.pid, reason: "process-identity-unavailable" }],
  });
  expect(signalGroup.mock.calls).toEqual([[300, "SIGKILL"]]);
  expect(rows).toEqual([launcher, neighbor]);
});

it("retains a known member that changes groups during a generic liveness refresh", async () => {
  const peer = { ...launcher, pid: 101, parentPid: launcher.pid };
  const exiting = { ...launcher, pid: 102, parentPid: launcher.pid };
  let rows = [launcher, peer, exiting];
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const result = await cleanupOwnedProcessGroup(ownership, {
    listProcesses: async () => rows,
    environment: async (pid) => {
      if (pid === exiting.pid) {
        rows = [launcher, { ...peer, processGroupId: peer.pid }];
        return {};
      }
      return { REA_PROCESS_RUN_ID: ownership.runId };
    },
    signalGroup,
  });
  expect(result).toEqual({ cleaned: true, signaled: true });
  expect(rows).toEqual([]);
  expect(signalGroup.mock.calls).toEqual([
    [100, "SIGKILL"],
    [101, "SIGKILL"],
  ]);
});

it.each([
  { phase: "planning", token: "owned" },
  { phase: "signaling", token: "owned" },
  { phase: "planning", token: "foreign" },
  { phase: "signaling", token: "foreign" },
  { phase: "planning", token: "missing" },
  { phase: "signaling", token: "missing" },
])(
  "retains and validates a new $token descendant group during generic $phase cleanup",
  async ({ phase, token }) => {
    const peer = { ...launcher, pid: 101, parentPid: launcher.pid };
    const exiting = { ...launcher, pid: 102, parentPid: launcher.pid };
    const child = {
      ...launcher,
      pid: 200,
      parentPid: peer.pid,
      processGroupId: 200,
    };
    const neighbor = { ...launcher, pid: 900, processGroupId: 900 };
    let rows = [launcher, peer, exiting, neighbor];
    let exitingReads = 0;
    const environment = vi.fn(async (pid: number) => {
      if (pid === neighbor.pid)
        throw new Error("Generic cleanup must not inspect unrelated groups");
      if (
        pid === exiting.pid &&
        ++exitingReads === (phase === "planning" ? 1 : 2)
      ) {
        rows = [launcher, peer, child, neighbor];
        return {};
      }
      if (pid === child.pid) {
        if (token === "missing") return {};
        if (token === "foreign") return { REA_PROCESS_RUN_ID: "other-run" };
      }
      return { REA_PROCESS_RUN_ID: ownership.runId };
    });
    const signalGroup = vi.fn((groupId: number) => {
      rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
    });
    const result = await cleanupOwnedProcessGroup(ownership, {
      listProcesses: async () => rows,
      environment,
      signalGroup,
    });
    expect(environment).toHaveBeenCalledWith(child.pid);
    if (token === "owned") {
      expect(result).toEqual({ cleaned: true, signaled: true });
      expect(rows).toEqual([neighbor]);
      expect(signalGroup.mock.calls).toEqual([
        [100, "SIGKILL"],
        [200, "SIGKILL"],
      ]);
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: child.pid,
            reason:
              token === "foreign"
                ? "run-token-mismatch"
                : "environment-unreadable",
          },
        ],
      });
      expect(signalGroup).not.toHaveBeenCalled();
    }
  },
);

it("retains a final sweep liveness failure after an earlier exit proof", async () => {
  const candidate = { ...launcher, pid: 200, processGroupId: 200 };
  let reads = 0;
  const result = await verifyNoTokenOwnedProcesses(ownership.runId, {
    listProcesses: async () => {
      if (++reads === 1) return [candidate];
      if (reads === 2) return [];
      throw new Error("final process table denied");
    },
    environment: async () => ({}),
    signalGroup: vi.fn(),
  });
  expect(result).toMatchObject({
    cleaned: false,
    reason: expect.stringContaining("final process table denied"),
  });
});

it.each([
  { phase: "planning", token: "owned" },
  { phase: "signaling", token: "owned" },
  { phase: "planning", token: "foreign" },
  { phase: "signaling", token: "missing" },
  { phase: "planning", token: "identity-unavailable" },
  { phase: "signaling", token: "reused" },
  { phase: "planning", token: "exited" },
  { phase: "signaling", token: "identity-exited" },
  { phase: "signaling", token: "replacement-owned" },
  { phase: "planning", token: "replacement-missing" },
  { phase: "planning", token: "replacement-foreign" },
  { phase: "signaling", token: "foreign-uid" },
  { phase: "planning", token: "same-uid-denied" },
  { phase: "signaling", token: "liveness-denied" },
  { phase: "planning", token: "foreign-afterread-unavailable" },
  { phase: "planning", token: "recovered-foreign" },
  { phase: "signaling", token: "recovered-owned" },
  { phase: "signaling", token: "recovered-reused" },
])(
  "examines a reparented $token child during generic $phase cleanup",
  async ({ phase, token }) => {
    const parent = { ...launcher, pid: 101, parentPid: launcher.pid };
    const child = {
      ...launcher,
      pid: 200,
      processGroupId: 200,
      uid: (process.getuid?.() ?? 0) + (token === "foreign-uid" ? 1 : 0),
    };
    const replacement = { ...launcher, pid: 201, processGroupId: 201 };
    const neighbor = { ...launcher, pid: 900, processGroupId: 900 };
    let rows = [launcher, parent, neighbor];
    let parentReads = 0;
    let childReads = 0;
    const environment = vi.fn(async (pid: number) => {
      if (pid === neighbor.pid)
        throw new Error("Stable unrelated rows must not become candidates");
      if (
        pid === parent.pid &&
        ++parentReads === (phase === "planning" ? 1 : 2)
      ) {
        rows = [launcher, child, neighbor];
        return {};
      }
      if (pid === child.pid) {
        childReads++;
        if (token.startsWith("recovered-") && childReads === 1) return {};
        if (token === "recovered-foreign")
          return { REA_PROCESS_RUN_ID: "other-run" };
        if (token === "foreign-uid" || token === "same-uid-denied")
          throw new Error("EACCES: environment permission denied");
        if (token === "liveness-denied") return {};
        if (token === "exited" || token.startsWith("replacement-")) {
          rows =
            token === "exited"
              ? [launcher, neighbor]
              : [launcher, replacement, neighbor];
          return {};
        }
        if (token === "missing") return {};
        if (token === "foreign" || token === "foreign-afterread-unavailable")
          return { REA_PROCESS_RUN_ID: "other-run" };
      }
      if (pid === replacement.pid) {
        if (token === "replacement-missing") return {};
        if (token === "replacement-foreign")
          return { REA_PROCESS_RUN_ID: "other-run" };
      }
      return { REA_PROCESS_RUN_ID: ownership.runId };
    });
    const signalGroup = vi.fn((groupId: number) => {
      rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
    });
    const result = await cleanupOwnedProcessGroup(ownership, {
      listProcesses: async () => {
        if (token === "liveness-denied" && childReads > 0)
          throw new Error("process table denied");
        return rows;
      },
      processIdentities: reparentedIdentityInspector({
        token,
        childPid: child.pid,
        childReads: () => childReads,
        observeExit: () => {
          rows = [launcher, neighbor];
        },
      }),
      environment,
      signalGroup,
    });
    if (
      [
        "owned",
        "foreign",
        "exited",
        "identity-exited",
        "replacement-owned",
        "replacement-foreign",
        "foreign-uid",
        "foreign-afterread-unavailable",
        "recovered-foreign",
        "recovered-owned",
      ].includes(token)
    ) {
      expect(result).toEqual({
        cleaned: true,
        signaled: true,
        ...(token === "foreign-uid"
          ? {
              unverified: [
                {
                  pid: child.pid,
                  diagnostic: "EACCES: environment permission denied",
                },
              ],
            }
          : {}),
      });
      expect(rows).toEqual(
        token === "foreign" ||
          token === "foreign-uid" ||
          token === "recovered-foreign"
          ? [child, neighbor]
          : token === "replacement-foreign"
            ? [replacement, neighbor]
            : [neighbor],
      );
      expect(signalGroup.mock.calls).toEqual(
        token === "owned" ||
          token === "replacement-owned" ||
          token === "recovered-owned"
          ? [
              [100, "SIGKILL"],
              [token === "replacement-owned" ? 201 : 200, "SIGKILL"],
            ]
          : [[100, "SIGKILL"]],
      );
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: token === "replacement-missing" ? replacement.pid : child.pid,
            reason: [
              "missing",
              "replacement-missing",
              "same-uid-denied",
              "liveness-denied",
            ].includes(token)
              ? "environment-unreadable"
              : "process-identity-unavailable",
          },
        ],
      });
      expect(signalGroup).not.toHaveBeenCalled();
    }
    if (token !== "identity-unavailable" && token !== "identity-exited")
      expect(environment).toHaveBeenCalledWith(child.pid);
    if (token.startsWith("replacement-"))
      expect(environment).toHaveBeenCalledWith(replacement.pid);
    expect(environment).not.toHaveBeenCalledWith(neighbor.pid);
  },
);

it.each([
  { token: "owned", exitAfterReads: 1 },
  { token: "missing", exitAfterReads: 1 },
  { token: "foreign", exitAfterReads: 1 },
  { token: "owned", exitAfterReads: 4 },
])(
  "examines a $token replacement after $exitAfterReads sweep token reads in cleanup and verification",
  async ({ token, exitAfterReads }) => {
    const parent = { ...launcher, pid: 200, processGroupId: 200 };
    const child = {
      ...launcher,
      pid: 201,
      parentPid: 200,
      processGroupId: 201,
    };
    const makeHost = () => {
      let rows = [parent];
      let reads = 0;
      const environment = vi.fn(async (pid: number) => {
        if (pid === parent.pid) {
          if (++reads === exitAfterReads) rows = [child];
          return {};
        }
        return token === "missing"
          ? {}
          : {
              REA_PROCESS_RUN_ID:
                token === "owned" ? ownership.runId : "other-run",
            };
      });
      const signalGroup = vi.fn((groupId: number) => {
        rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
      });
      return {
        adapter: { listProcesses: async () => rows, environment, signalGroup },
        environment,
        signalGroup,
      };
    };
    const cleanupHost = makeHost();
    const verificationHost = makeHost();
    const cleanup = await cleanupOwnedProcessGroup(
      { ...ownership, sweepTokenOwnedProcesses: true },
      cleanupHost.adapter,
    );
    const verification = await verifyNoTokenOwnedProcesses(
      ownership.runId,
      verificationHost.adapter,
    );
    for (const { environment } of [cleanupHost, verificationHost])
      expect(environment).toHaveBeenCalledWith(child.pid);
    expect(cleanup.cleaned).toBe(token !== "missing");
    expect(verification.cleaned).toBe(token === "foreign");
    expect(cleanupHost.signalGroup.mock.calls).toEqual(
      token === "owned" ? [[201, "SIGKILL"]] : [],
    );
    if (token === "missing")
      for (const result of [cleanup, verification])
        expect(result).toMatchObject({
          failures: [{ pid: child.pid, reason: "environment-unreadable" }],
        });
  },
);

it("retains an owned reparented group while a newly discovered peer exits during inspection", async () => {
  const parent = { ...launcher, pid: 101, parentPid: launcher.pid };
  const owned = { ...launcher, pid: 200, processGroupId: 200 };
  const transient = { ...launcher, pid: 300, processGroupId: 300 };
  const foreign = { ...launcher, pid: 400, processGroupId: 400 };
  let rows = [launcher, parent];
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const result = await cleanupOwnedProcessGroup(ownership, {
    listProcesses: async () => rows,
    processIdentities: async (members) =>
      new Map(
        members.map(({ pid }) => [
          pid,
          { state: "readable" as const, identity: `start-${String(pid)}` },
        ]),
      ),
    environment: async (pid) => {
      if (pid === parent.pid) {
        rows = [launcher, owned, transient];
        return {};
      }
      if (pid === transient.pid) {
        rows = [launcher, owned, foreign];
        return {};
      }
      return {
        REA_PROCESS_RUN_ID: pid === foreign.pid ? "other-run" : ownership.runId,
      };
    },
    signalGroup,
  });
  expect(result).toEqual({ cleaned: true, signaled: true });
  expect(signalGroup.mock.calls).toEqual([
    [100, "SIGKILL"],
    [200, "SIGKILL"],
  ]);
  expect(rows).toEqual([foreign]);
});

it("bounds repeated unlinked candidate replacement without accepting unexamined ownership", async () => {
  const parent = { ...launcher, pid: 101, parentPid: launcher.pid };
  let nextPid = 200;
  let rows = [launcher, parent];
  const signalGroup = vi.fn();
  const result = await cleanupOwnedProcessGroup(ownership, {
    listProcesses: async () => rows,
    environment: async (pid) => {
      if (pid === launcher.pid) return { REA_PROCESS_RUN_ID: ownership.runId };
      rows = [
        launcher,
        { ...launcher, pid: nextPid, processGroupId: nextPid++ },
      ];
      return {};
    },
    signalGroup,
  });
  expect(result).toMatchObject({
    cleaned: false,
    failures: [{ pid: rows[1]!.pid, reason: "process-discovery-incomplete" }],
  });
  expect(nextPid).toBeLessThan(210);
  expect(signalGroup).not.toHaveBeenCalled();
});

it("keeps final liveness failure after a refreshed candidate recovers its token", async () => {
  const parent = { ...launcher, pid: 101, parentPid: launcher.pid };
  const child = { ...launcher, pid: 200, processGroupId: 200 };
  let rows = [launcher, parent];
  let childReads = 0;
  const signalGroup = vi.fn();
  const result = await cleanupOwnedProcessGroup(ownership, {
    listProcesses: async () => {
      if (childReads >= 2) throw new Error("final candidate table denied");
      return rows;
    },
    environment: async (pid) => {
      if (pid === parent.pid) {
        rows = [launcher, child];
        return {};
      }
      if (pid === child.pid && ++childReads === 1) return {};
      return { REA_PROCESS_RUN_ID: ownership.runId };
    },
    signalGroup,
  });
  expect(childReads).toBe(2);
  expect(result).toMatchObject({
    cleaned: false,
    reason: expect.stringContaining("final candidate table denied"),
  });
  expect(signalGroup).not.toHaveBeenCalled();
});

it("examines a replacement discovered while sweep start identity is unavailable", async () => {
  const parent = { ...launcher, pid: 200, processGroupId: 200 };
  const child = { ...launcher, pid: 201, parentPid: 200, processGroupId: 201 };
  let rows = [parent];
  const environment = vi.fn(async (pid: number) => {
    if (pid === parent.pid)
      throw new Error("An unavailable identity cannot authorize a token read");
    return { REA_PROCESS_RUN_ID: ownership.runId };
  });
  const signalGroup = vi.fn((groupId: number) => {
    rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
  });
  const result = await cleanupOwnedProcessGroup(
    { ...ownership, sweepTokenOwnedProcesses: true, captureBaseline: [] },
    {
      listProcesses: async () => rows,
      processIdentities: async (members) =>
        new Map<number, ProcessIdentityObservation>(
          members.map(({ pid }) => {
            if (pid === parent.pid) {
              rows = [child];
              return [
                pid,
                {
                  state: "unavailable" as const,
                  reason: "exited during identity inspection",
                },
              ];
            }
            return [
              pid,
              { state: "readable" as const, identity: "child-start" },
            ];
          }),
        ),
      environment,
      signalGroup,
    },
  );
  expect(result).toEqual({ cleaned: true, signaled: true });
  expect(environment).toHaveBeenCalledWith(child.pid);
  expect(signalGroup).toHaveBeenCalledExactlyOnceWith(201, "SIGKILL");
});

it.each(["planning", "signaling"])(
  "detects a reused baseline PID in the same unplanned PGID during %s",
  async (phase) => {
    const old = { ...launcher, pid: 200, processGroupId: 200 };
    let launcherReads = 0;
    let replaced = false;
    let rows = [launcher, old];
    const environment = vi.fn(async (pid: number) => {
      if (
        pid === launcher.pid &&
        ++launcherReads === (phase === "planning" ? 2 : 3)
      ) {
        replaced = true;
        rows = [old];
        return {};
      }
      return { REA_PROCESS_RUN_ID: ownership.runId };
    });
    const signalGroup = vi.fn((groupId: number) => {
      rows = rows.filter(({ processGroupId }) => processGroupId !== groupId);
    });
    const result = await cleanupOwnedProcessGroup(
      {
        ...ownership,
        sweepTokenOwnedProcesses: true,
        captureBaseline: [{ pid: old.pid, identity: "baseline-start" }],
      },
      {
        listProcesses: async () => rows,
        processIdentities: async (members) =>
          new Map(
            members.map(({ pid }) => [
              pid,
              {
                state: "readable" as const,
                identity:
                  pid === old.pid
                    ? replaced
                      ? "replacement-start"
                      : "baseline-start"
                    : "launcher-start",
              },
            ]),
          ),
        environment,
        signalGroup,
      },
    );
    expect(result).toEqual({ cleaned: true, signaled: true });
    expect(environment).toHaveBeenCalledWith(old.pid);
    expect(signalGroup).toHaveBeenCalledExactlyOnceWith(200, "SIGKILL");
  },
);

it("retains newly observed withheld-process diagnostics from pre-signal sweeps", async () => {
  const withheld = { ...launcher, pid: 900, processGroupId: 900 };
  let reads = 0;
  const result = await cleanupOwnedProcessGroup(
    { ...ownership, sweepTokenOwnedProcesses: true },
    {
      listProcesses: async () =>
        ++reads >= 3 ? [launcher, withheld] : [launcher],
      environment: async (pid) => {
        if (pid === withheld.pid)
          throw new Error("platform_binary_environment_withheld");
        return { REA_PROCESS_RUN_ID: ownership.runId };
      },
      signalGroup: vi.fn(),
    },
  );
  expect(result).toEqual({
    cleaned: true,
    signaled: true,
    unverified: [
      { pid: withheld.pid, diagnostic: "platform_binary_environment_withheld" },
    ],
  });
});

it.each(["planning", "signaling", "signaling without new groups"])(
  "cleans verified peers and retains the capture owner when a live token disappears during %s",
  async (phase) => {
    const peer = { ...launcher, pid: 200, processGroupId: 200 };
    const discovered = { ...launcher, pid: 300, processGroupId: 300 };
    let processes = [launcher, peer];
    let launcherReads = 0;
    let uncertain = false;
    let recovered = false;
    const signalGroup = vi.fn((groupId: number) => {
      processes = processes.filter(
        ({ processGroupId }) => processGroupId !== groupId,
      );
    });
    const adapter: ProcessOwnershipHost = {
      listProcesses: async () => processes,
      processIdentities: async (members) =>
        new Map(
          members.map(({ pid }) => [
            pid,
            {
              state: "readable" as const,
              identity: `start-${String(pid)}`,
            },
          ]),
        ),
      environment: async (pid) => {
        if (pid === launcher.pid) {
          launcherReads++;
          if (launcherReads === (phase === "planning" ? 2 : 3)) {
            uncertain = true;
            if (phase !== "signaling without new groups")
              processes = [...processes, discovered];
          }
          if (uncertain && !recovered) return {};
        }
        return { REA_PROCESS_RUN_ID: ownership.runId };
      },
      signalGroup,
    };
    const removeTemporaryRoot = vi.fn(async () => undefined);
    const scope = new ProcessCaptureResourceScope();
    try {
      const report = await scope.release({
        timers: new Set(),
        terminal: { pid: launcher.pid },
        renderer: undefined,
        runId: ownership.runId,
        temporaryRoot: "/fixture/root",
        captureBaseline: [],
        host: {
          platform: "linux",
          cleanupProcessGroup: (owned) =>
            cleanupOwnedProcessGroup(owned, adapter),
          verifyTokenOwnedProcesses: (runId, _host, baseline, relation) =>
            verifyNoTokenOwnedProcesses(runId, adapter, baseline, relation),
          removeTemporaryRoot,
        },
      });
      expect(report.owned_process_group).toMatchObject({
        state: "unverified",
        reason: expect.stringContaining("100=run_token_missing"),
      });
      expect(report.temporary_root.state).toBe("unverified");
      expect(signalGroup.mock.calls).toEqual(
        phase === "signaling without new groups"
          ? [[200, "SIGKILL"]]
          : [
              [200, "SIGKILL"],
              [300, "SIGKILL"],
            ],
      );
      expect(processes).toEqual([launcher]);
      expect(removeTemporaryRoot).not.toHaveBeenCalled();

      await expect(scope.retryCleanup()).rejects.toThrow(
        "cleanup remains incomplete",
      );
      expect(processes).toEqual([launcher]);
      expect(removeTemporaryRoot).not.toHaveBeenCalled();
      const cleanedPeerCount = signalGroup.mock.calls.length;
      recovered = true;
      await scope.retryCleanup();
      expect(signalGroup.mock.calls.slice(cleanedPeerCount)).toEqual([
        [100, "SIGKILL"],
      ]);
      expect(processes).toEqual([]);
      expect(removeTemporaryRoot).toHaveBeenCalledExactlyOnceWith(
        "/fixture/root",
      );
      await scope.close();
      expect(signalGroup).toHaveBeenCalledTimes(cleanedPeerCount + 1);
      expect(removeTemporaryRoot).toHaveBeenCalledTimes(1);
    } finally {
      recovered = true;
      await scope.close();
    }
  },
);

it("bounds detached-group replanning without losing live token uncertainty", async () => {
  let processes = [launcher];
  let launcherReads = 0;
  const signalGroup = vi.fn();
  const result = await cleanupOwnedProcessGroup(
    { ...ownership, sweepTokenOwnedProcesses: true },
    {
      listProcesses: async () => processes,
      environment: async (pid) => {
        if (pid !== launcher.pid)
          return { REA_PROCESS_RUN_ID: ownership.runId };
        launcherReads++;
        processes = [
          ...processes,
          {
            ...launcher,
            pid: 200 + launcherReads,
            processGroupId: 200 + launcherReads,
          },
        ];
        return {};
      },
      signalGroup,
    },
  );
  if (result.cleaned) throw new Error("expected unresolved cleanup");
  expect(result.failures?.filter(({ pid }) => pid === launcher.pid)).toEqual([
    {
      pid: launcher.pid,
      reason: "environment-unreadable",
      diagnostic: "run_token_missing",
    },
  ]);
  expect(result.failures).toContainEqual(
    expect.objectContaining({
      reason: "process-discovery-incomplete",
      diagnostic:
        "process-group membership kept changing during bounded cleanup planning",
    }),
  );
  expect(launcherReads).toBeLessThan(40);
  expect(signalGroup).not.toHaveBeenCalled();
});

it("cleans verified peers while retaining a newly discovered missing-token candidate", async () => {
  const child = { ...launcher, pid: 200, parentPid: 100, processGroupId: 200 };
  const unknown = { ...launcher, pid: 300, processGroupId: 300 };
  let joined = false;
  const signalGroup = vi.fn((groupId: number) => {
    if (groupId === launcher.processGroupId) joined = true;
  });
  const result = await cleanupOwnedProcessGroup(
    { ...ownership, sweepTokenOwnedProcesses: true },
    {
      listProcesses: async () =>
        joined ? [launcher, child, unknown] : [launcher, child],
      environment: async (pid) =>
        pid === unknown.pid ? {} : { REA_PROCESS_RUN_ID: ownership.runId },
      signalGroup,
    },
  );
  expect(result).toMatchObject({
    cleaned: false,
    failures: [{ pid: unknown.pid, reason: "environment-unreadable" }],
  });
  expect(signalGroup.mock.calls).toEqual([
    [100, "SIGKILL"],
    [200, "SIGKILL"],
  ]);
});

describe("ownership validation refreshes complete group membership", () => {
  it.each([
    { phase: "planning", token: "owned" },
    { phase: "signaling", token: "owned" },
    { phase: "planning", token: "foreign" },
    { phase: "signaling", token: "foreign" },
    { phase: "planning", token: "missing" },
    { phase: "signaling", token: "missing" },
  ])(
    "classifies a new detached $token group during $phase without stale cleanup authority",
    async ({ phase, token }) => {
      const child = { ...launcher, pid: 200, processGroupId: 200 };
      let exited = false;
      let childExited = false;
      let launcherReads = 0;
      const environment = vi.fn(async (pid: number) => {
        if (pid === child.pid) {
          if (token === "missing") return {};
          if (token === "foreign") return { REA_PROCESS_RUN_ID: "other-run" };
        }
        if (pid === launcher.pid) {
          launcherReads++;
          if (launcherReads === (phase === "planning" ? 2 : 3)) {
            exited = true;
            return {};
          }
        }
        return { REA_PROCESS_RUN_ID: ownership.runId };
      });
      const signalGroup = vi.fn((groupId: number) => {
        if (groupId === child.processGroupId) childExited = true;
      });
      const adapter: ProcessOwnershipHost = {
        listProcesses: async () =>
          childExited ? [] : exited ? [child] : [launcher],
        environment,
        signalGroup,
      };
      const swept = { ...ownership, sweepTokenOwnedProcesses: true };
      const first = await cleanupOwnedProcessGroup(swept, adapter);
      expect(first).toMatchObject({ cleaned: token !== "missing" });
      expect(environment).toHaveBeenCalledWith(child.pid);
      if (token === "owned") {
        await expect(cleanupOwnedProcessGroup(swept, adapter)).resolves.toEqual(
          {
            cleaned: true,
            signaled: false,
          },
        );
        expect(signalGroup).toHaveBeenCalledExactlyOnceWith(200, "SIGKILL");
      } else if (token === "missing")
        expect(first).toMatchObject({
          failures: [{ pid: child.pid, reason: "environment-unreadable" }],
        });
      if (token !== "owned") expect(signalGroup).not.toHaveBeenCalled();
    },
  );
});

describe("ownership sweeps reconcile later group validation", () => {
  it.each(["owned", "exited", "foreign", "reused"])(
    "reconciles a missing-token sweep failure when later group validation is %s",
    async (state) => {
      const child = { ...launcher, pid: 101, parentPid: launcher.pid };
      let childReads = 0;
      const signalGroup = vi.fn();
      const result = await cleanupOwnedProcessGroup(
        { ...ownership, captureBaseline: [], sweepTokenOwnedProcesses: true },
        {
          listProcesses: async () =>
            state === "exited" && childReads >= 5
              ? [launcher]
              : [launcher, child],
          processIdentities: async (members) =>
            new Map(
              members.map(({ pid }) => [
                pid,
                {
                  state: "readable" as const,
                  identity:
                    pid === child.pid && state === "reused" && childReads >= 5
                      ? "replacement-start"
                      : `start-${String(pid)}`,
                },
              ]),
            ),
          environment: async (pid) => {
            if (pid === child.pid) {
              childReads++;
              if (childReads <= 4 || state === "exited") return {};
              if (state === "foreign")
                return { REA_PROCESS_RUN_ID: "other-run" };
            }
            return { REA_PROCESS_RUN_ID: ownership.runId };
          },
          signalGroup,
        },
      );
      if (state === "owned" || state === "exited") {
        expect(result).toEqual({ cleaned: true, signaled: true });
        expect(signalGroup).toHaveBeenCalledExactlyOnceWith(100, "SIGKILL");
      } else {
        expect(result).toMatchObject({
          cleaned: false,
          failures: [
            expect.objectContaining({
              pid: child.pid,
              reason:
                state === "foreign"
                  ? "run-token-mismatch"
                  : "process-identity-unavailable",
            }),
          ],
        });
        expect(signalGroup).not.toHaveBeenCalled();
      }
    },
  );
});

describe("ownership validation refreshes surviving members", () => {
  it.each(["planning", "signaling"])(
    "validates new owned and foreign members discovered during %s",
    async (phase) => {
      for (const token of [ownership.runId, "other-run"]) {
        const child = { ...launcher, pid: 101 };
        let exited = false;
        let launcherReads = 0;
        const environment = vi.fn(async (pid: number) => {
          if (pid === child.pid) return { REA_PROCESS_RUN_ID: token };
          launcherReads++;
          if (launcherReads === (phase === "planning" ? 1 : 2)) {
            exited = true;
            return {};
          }
          return { REA_PROCESS_RUN_ID: ownership.runId };
        });
        const signalGroup = vi.fn();
        const result = await cleanupOwnedProcessGroup(ownership, {
          listProcesses: async () => (exited ? [child] : [launcher]),
          environment,
          signalGroup,
        });
        expect(environment).toHaveBeenCalledWith(child.pid);
        if (token === ownership.runId) {
          expect(result).toEqual({ cleaned: true, signaled: true });
          expect(signalGroup).toHaveBeenCalledExactlyOnceWith(100, "SIGKILL");
        } else {
          expect(result).toMatchObject({
            cleaned: false,
            failures: [{ pid: child.pid, reason: "run-token-mismatch" }],
          });
          expect(signalGroup).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("retains uncertainty when new members keep joining during validation", async () => {
    let current = launcher;
    const signalGroup = vi.fn();
    const result = await cleanupOwnedProcessGroup(ownership, {
      listProcesses: async () => [current],
      environment: async () => {
        current = { ...current, pid: current.pid + 1 };
        return {};
      },
      signalGroup,
    });
    expect(result).toMatchObject({
      cleaned: false,
      failures: [{ pid: current.pid, reason: "process-discovery-incomplete" }],
    });
    expect(signalGroup).not.toHaveBeenCalled();
    expect(current.pid).toBeLessThan(110);
  });
});

describe("ownership sweeps preserve missing-token uncertainty", () => {
  const old = { ...launcher, pid: 50, processGroupId: 50 };
  const child = { ...launcher, pid: 200, processGroupId: 200 };
  const baseline = [{ pid: old.pid, identity: "old-start" }];

  it.each(["missing", "unreadable-then-missing", "foreign", "exited"])(
    "settles a post-baseline detached candidate whose token is %s",
    async (state) => {
      const makeHost = (): ProcessOwnershipHost => {
        let reads = 0;
        return {
          listProcesses: async () =>
            state === "exited" && reads > 0 ? [old] : [old, child],
          processIdentities: async (members) =>
            new Map(
              members.map(({ pid }) => [
                pid,
                {
                  state: "readable" as const,
                  identity: pid === old.pid ? "old-start" : "child-start",
                },
              ]),
            ),
          environment: async (pid) => {
            if (pid === old.pid)
              throw new Error(
                "Baseline identities must not be reread for tokens",
              );
            reads++;
            if (state === "unreadable-then-missing" && reads === 1)
              throw new Error("transient environment read failure");
            return state === "foreign"
              ? { REA_PROCESS_RUN_ID: "other-run" }
              : {};
          },
          signalGroup: vi.fn(),
        };
      };
      const cleanup = await cleanupOwnedProcessGroup(
        {
          ...ownership,
          captureBaseline: baseline,
          sweepTokenOwnedProcesses: true,
        },
        makeHost(),
      );
      const verification = await verifyNoTokenOwnedProcesses(
        ownership.runId,
        makeHost(),
        baseline,
      );
      for (const result of [cleanup, verification]) {
        if (state === "foreign" || state === "exited")
          expect(result).toEqual({ cleaned: true, signaled: false });
        else
          expect(result).toMatchObject({
            cleaned: false,
            failures: [
              {
                pid: child.pid,
                reason: "environment-unreadable",
                diagnostic: "run_token_missing",
              },
            ],
          });
      }
    },
  );
});
