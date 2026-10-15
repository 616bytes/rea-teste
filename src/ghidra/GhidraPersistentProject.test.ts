import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ghidraPersistentProjectLocation } from "../config/ghidraPersistentProject.js";
import { parseConfig } from "../config/parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import {
  GHIDRA_PERSISTENT_IMPORT_MODE,
  type GhidraPersistentProjectReport,
} from "./GhidraPersistentProject.js";
import { GhidraProvider } from "./GhidraProvider.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import {
  GHIDRA_MUTATING_OPERATIONS,
  GHIDRA_SESSION_CAPABILITIES,
} from "./GhidraSessionValues.js";

const INSTALL = "/opt/ghidra_12.1.4_PUBLIC";
const SHA = "a".repeat(64);

const target: BinaryTarget = {
  path: "/tmp/fixture.exe",
  sha256: SHA,
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
};

const settings = (
  environment: Record<string, string>,
): ReturnType<typeof parseConfig> =>
  parseConfig({ GHIDRA_INSTALL_DIR: INSTALL, ...environment });

const settingError = (environment: Record<string, string>) => {
  const parsed = settings(environment);
  if (parsed.ok) throw new Error("Expected a configuration error");
  return parsed.error.settings;
};

describe("REA_GHIDRA_PROJECT and REA_GHIDRA_PROGRAM", () => {
  it("selects one Program of an existing project", () => {
    const parsed = settings({
      REA_GHIDRA_PROJECT: "/work/projects/Game.gpr",
      REA_GHIDRA_PROGRAM: "/bin/Game.exe",
    });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.ghidraPersistentProject).toEqual({
      projectFile: "/work/projects/Game.gpr",
      program: "/bin/Game.exe",
    });
  });

  it("leaves the ephemeral import unchanged when unset", () => {
    const parsed = settings({});
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.ghidraPersistentProject).toBeUndefined();
  });

  it.each([
    [
      { REA_GHIDRA_PROJECT: "/p/Game.gpr" },
      "REA_GHIDRA_PROJECT",
      "requires REA_GHIDRA_PROGRAM",
    ],
    [
      { REA_GHIDRA_PROGRAM: "/Game.exe" },
      "REA_GHIDRA_PROGRAM",
      "requires REA_GHIDRA_PROJECT",
    ],
  ])("requires both settings: %j", (environment, setting, constraint) => {
    expect(settingError(environment)).toEqual([{ setting, constraint }]);
  });

  it.each(["relative/Game.gpr", "/p/Game.rep", "/p/.gpr", "/p/Ga*me.gpr"])(
    "rejects project file %j",
    (projectFile) => {
      expect(
        settingError({
          REA_GHIDRA_PROJECT: projectFile,
          REA_GHIDRA_PROGRAM: "/Game.exe",
        }).map(({ setting }) => setting),
      ).toContain("REA_GHIDRA_PROJECT");
    },
  );

  it.each([
    "Game.exe",
    "/",
    "/bin//Game.exe",
    "/bin/../Game.exe",
    "/Game*.exe",
    "/Game?.exe",
    "/bin\\Game.exe",
    "/ Game.exe",
  ])("rejects program path %j", (program) => {
    expect(
      settingError({
        REA_GHIDRA_PROJECT: "/p/Game.gpr",
        REA_GHIDRA_PROGRAM: program,
      }).map(({ setting }) => setting),
    ).toContain("REA_GHIDRA_PROGRAM");
  });

  it.each([
    ["REA_GHIDRA_SEED_FILE", "/seeds.tsv"],
    ["REA_GHIDRA_DISABLED_ANALYZERS", "Stack"],
    ["REA_GHIDRA_LANGUAGE_ID", "x86:LE:64:default"],
    ["REA_GHIDRA_NATIVEAOT_JAR", "/nativeaot.jar"],
  ])(
    "refuses import-time setting %s instead of ignoring it",
    (setting, value) => {
      expect(
        settingError({
          REA_GHIDRA_PROJECT: "/p/Game.gpr",
          REA_GHIDRA_PROGRAM: "/Game.exe",
          [setting]: value,
        }),
      ).toEqual([
        {
          setting,
          constraint:
            "cannot be combined with REA_GHIDRA_PROJECT; a persistent project is opened without import or analysis",
        },
      ]);
    },
  );

  it.each([
    [
      "linux",
      "/work/Game.gpr",
      "/Game.exe",
      {
        projectLocation: "/work",
        projectName: "Game",
        folderPath: "/",
        programName: "Game.exe",
      },
    ],
    [
      "linux",
      "/work/Game.gpr",
      "/bin/x64/Game.exe",
      {
        projectLocation: "/work",
        projectName: "Game",
        folderPath: "/bin/x64",
        programName: "Game.exe",
      },
    ],
    [
      "win32",
      "D:\\Bench\\Game.gpr",
      "/Game.exe",
      {
        projectLocation: "D:\\Bench",
        projectName: "Game",
        folderPath: "/",
        programName: "Game.exe",
      },
    ],
  ] as const)(
    "splits %s project %s and Program %s into headless coordinates",
    (platform, projectFile, program, expected) => {
      expect(
        ghidraPersistentProjectLocation({ projectFile, program }, platform),
      ).toEqual(expected);
    },
  );
});

/** A project directory shaped like Ghidra's: `<name>.gpr` beside `<name>.rep/`. */
const projectFixture = async (): Promise<string> => {
  const directory = await createTestTempDirectory("rea-ghidra-project-");
  await writeFile(join(directory, "Game.gpr"), "");
  await mkdir(join(directory, "Game.rep"));
  return join(directory, "Game.gpr");
};

const report = (
  executable_sha256: string | null,
  program = "/Game.exe",
): GhidraPersistentProjectReport => ({
  mode: GHIDRA_PERSISTENT_IMPORT_MODE,
  program,
  executable_sha256,
});

const persistentSession = async (
  project: GhidraPersistentProjectReport | undefined,
) => {
  const projectFile = await projectFixture();
  const config = settings({
    REA_GHIDRA_PROJECT: projectFile,
    REA_GHIDRA_PROGRAM: "/Game.exe",
  });
  if (!config.ok) throw config.error;
  const counts = { starts: 0, calls: 0, closes: 0 };
  let options: GhidraClientOptions | undefined;
  const ghidra = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    host,
    (created) => {
      options = created;
      return {
        start: () => {
          counts.starts++;
          return Promise.resolve(
            ok({
              name: "REA Ghidra bridge" as const,
              run_id: "11111111-1111-4111-8111-111111111111",
              profile_digest: SHA,
              provider: { id: "ghidra" as const, version: "12.1.4" },
              read_only: true,
              analysis_complete: true,
              analysis_timed_out: false,
              capabilities: GHIDRA_SESSION_CAPABILITIES.filter(
                (capability) => !GHIDRA_MUTATING_OPERATIONS.has(capability),
              ),
              target: {
                name: "Game.exe",
                language_id: "x86:LE:64:default",
                compiler_spec_id: "windows",
                image_base: "0x140000000",
                default_address_space: "ram",
                sha256: SHA,
              },
              ...(project === undefined ? {} : { project }),
            }),
          );
        },
        callTool: () => {
          counts.calls++;
          return Promise.resolve(ok([]));
        },
        close: () => {
          counts.closes++;
          return Promise.resolve(ok(null));
        },
      };
    },
  );
  const resolved = await ghidra.resolveAnalysisProfile(target);
  if (!resolved.ok || resolved.value.profile === null)
    throw new Error("expected profile");
  const client = ghidra.createClient(target, resolved.value.profile);
  return {
    ghidra,
    counts,
    client,
    profile: resolved.value.profile,
    projectFile,
    options: () => options,
  };
};

describe("Ghidra persistent project mode", () => {
  it("commits the read-only import mode and the project into the analysis profile", async () => {
    const { profile, projectFile } = await persistentSession(report(SHA));
    expect(profile.parameters).toMatchObject({
      import_mode: "persistent-project-read-only",
      persistent_project: {
        format: "rea-ghidra-persistent-project-v1",
        configured_project_file: projectFile,
        program: "/Game.exe",
        identity: "program-executable-sha256-v1",
      },
      annotation_policy: "unsupported-read-only-project-v1",
      analyzer_preset: "caller-project-recorded",
      no_return_repair: "not-applied-persistent-project",
    });
    expect(profile.parameters).not.toHaveProperty("analysis_options");
  });

  it("keeps the ephemeral import mode without the settings", async () => {
    const config = settings({});
    if (!config.ok) throw config.error;
    const resolved = await new GhidraProvider(
      config.value,
      silentLogger,
      {},
      host,
    ).resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected profile");
    expect(resolved.value.profile.parameters.import_mode).toBe(
      "ephemeral-source-immutable",
    );
    expect(resolved.value.profile.parameters).not.toHaveProperty(
      "persistent_project",
    );
  });

  it("opens the committed project through the launcher and expects a read-only bridge", async () => {
    const { client, options, profile } = await persistentSession(report(SHA));
    const health = await client.execute("health", {});
    if (!health.ok) throw health.error;
    const created = options();
    expect(created?.persistentProject).toBe(true);
    const launcher = created?.launcher;
    expect(launcher).toBeInstanceOf(GhidraHeadlessLauncher);
    if (!(launcher instanceof GhidraHeadlessLauncher)) return;
    const committed = profile.parameters.persistent_project as {
      readonly project_file: string;
    };
    expect(launcher.options.persistentProject).toEqual({
      projectFile: committed.project_file,
      program: "/Game.exe",
    });
    expect(health.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("caller assertions, not Ghidra discoveries"),
        expect.stringContaining("never saved"),
      ]),
    );
    expect(health.value.limitations).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("temporary project are ephemeral"),
      ]),
    );
  });

  it("serves analysis with persistent-project limitations once the Program digest matches", async () => {
    const { client, counts } = await persistentSession(report(SHA));
    const listed = await client.execute("list_procedures", {});
    if (!listed.ok) throw listed.error;
    expect(counts).toMatchObject({ starts: 1, calls: 1, closes: 0 });
    expect(listed.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("REA did not import or analyze the target"),
      ]),
    );
  });

  it.each([
    [
      "another artifact's digest",
      report("b".repeat(64)),
      "records executable SHA-256 " + "b".repeat(64),
    ],
    ["no recorded digest", report(null), "records no executable SHA-256"],
  ])(
    "refuses a Program with %s before any analysis call",
    async (_label, project, recorded) => {
      const { client, counts } = await persistentSession(project);
      const failed = await client.execute("list_procedures", {});
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      const projected = projectAnalysisError(failed.error);
      expect(projected).toMatchObject({
        code: "unsupported_target",
        details: { path: target.path },
      });
      expect(JSON.stringify(projected)).toContain(recorded);
      expect(JSON.stringify(projected)).toContain(
        `selected target has SHA-256 ${SHA}`,
      );
      expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
      const again = await client.execute("list_procedures", {});
      expect(again.ok).toBe(false);
      expect(counts.calls).toBe(0);
    },
  );

  it.each([
    ["no project report", undefined],
    ["another Program", report(SHA, "/Other.exe")],
  ])("fails closed on %s", async (_label, project) => {
    const { client, counts } = await persistentSession(project);
    const failed = await client.execute("list_procedures", {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    expect(counts.calls).toBe(0);
  });
});

describe("Ghidra persistent project admission", () => {
  it("marks annotations unavailable and every read live", async () => {
    const { ghidra } = await persistentSession(report(SHA));
    const capabilities = ghidra.capabilities();
    for (const capability of capabilities) {
      expect(capability.cachePolicy).toBe("live");
      if (GHIDRA_MUTATING_OPERATIONS.has(capability.operation)) {
        expect(capability.available).toBe(false);
        expect(capability.reason).toContain("read-only");
      } else expect(capability.available).toBe(true);
    }
  });

  it("refuses a profile resolved for another import mode", async () => {
    const { profile } = await persistentSession(report(SHA));
    const plain = settings({});
    if (!plain.ok) throw plain.error;
    let starts = 0;
    const client = new GhidraProvider(
      plain.value,
      silentLogger,
      {},
      host,
      () => ({
        start: () => {
          starts++;
          return Promise.resolve(ok(null as never));
        },
        callTool: () => Promise.resolve(ok(null)),
        close: () => Promise.resolve(ok(null)),
      }),
    ).createClient(target, profile);
    const failed = await client.execute("health", {});
    expect(failed.ok).toBe(false);
    expect(starts).toBe(0);
  });

  it("reports a missing project before launching Ghidra", async () => {
    const config = settings({
      REA_GHIDRA_PROJECT: "/rea-missing/Game.gpr",
      REA_GHIDRA_PROGRAM: "/Game.exe",
    });
    if (!config.ok) throw config.error;
    const resolved = await new GhidraProvider(
      config.value,
      silentLogger,
      {},
      host,
    ).resolveAnalysisProfile(target);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        details: { diagnostics: { setting: "REA_GHIDRA_PROJECT" } },
      });
  });

  it("refuses targets whose profile depends on REA's own import preparation", async () => {
    const projectFile = await projectFixture();
    const config = settings({
      REA_GHIDRA_PROJECT: projectFile,
      REA_GHIDRA_PROGRAM: "/fixture.bin",
    });
    if (!config.ok) throw config.error;
    const resolved = await new GhidraProvider(
      config.value,
      silentLogger,
      {},
      host,
    ).resolveAnalysisProfile({
      path: "/tmp/fixture.bin",
      sha256: SHA,
      kind: "executable",
      format: "raw-binary",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
      entryPoint: "0x1000",
      entryPointSource: "caller-supplied",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(projectAnalysisError(resolved.error).code).toBe(
        "unsupported_target",
      );
  });
});
