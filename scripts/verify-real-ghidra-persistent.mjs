#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { requireMcpToolError } from "./lib/mcp-verifier-results.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";

// Builds a saved Ghidra project from the source-owned PE fixture, names its
// entry in the project, then opens it through REA with REA_GHIDRA_PROJECT.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-persistent.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "verify:ghidra:persistent supports Linux/macOS hosts; the Windows P0 run is a separate follow-up.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "verify:ghidra:persistent prerequisite missing: GHIDRA_INSTALL_DIR (bring your own Ghidra).",
  );
const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `verify:ghidra:persistent prerequisite unavailable: ${JSON.stringify(installation)}`,
  );

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "0x140001000";
const PROJECT_NAME = "rea_project_entry";
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-persistent-"));
const runtime = join(workspace, "runtime");
const projects = join(workspace, "projects");
await mkdir(runtime);
await mkdir(projects);
let report;
let client;
try {
  await promisify(execFile)(process.execPath, [
    join(root, "scripts", "create-ghidra-windows-fixture.mjs"),
  ]);
  const targetPath = join(workspace, "Fixture.exe");
  const otherPath = join(workspace, "Other.exe");
  await copyFile(
    join(root, "build", "fixtures", "rea-ghidra-windows.exe"),
    targetPath,
  );
  await copyFile(
    join(root, "build", "fixtures", "rea-ghidra-windows-x86.exe"),
    otherPath,
  );
  const sha256 = digest(await readFile(targetPath));
  const otherSha256 = digest(await readFile(otherPath));
  assert.notEqual(sha256, otherSha256);

  // 1. Analyze once into a saved project, the way an analyst would.
  const analyzeStarted = performance.now();
  const prepared = await runHeadless([
    projects,
    "Fixture",
    "-import",
    targetPath,
    "-scriptPath",
    join(root, "tests", "conformance", "ghidra"),
    "-postScript",
    "ReaPersistentProjectFixture.java",
    ENTRY,
    PROJECT_NAME,
  ]);
  const analyzeMs = Math.round(performance.now() - analyzeStarted);
  assert.ok(
    prepared.includes(
      `REA_PERSISTENT_PROJECT_FIXTURE_OK 140001000 ${PROJECT_NAME} ${sha256}`,
    ),
    prepared,
  );
  const projectFile = join(projects, "Fixture.gpr");
  const before = await projectDigests(projects);

  // 2. Open the saved project through REA: no import, no analysis.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: runtime,
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "ghidra",
    REA_PROCESS_RUN_ID: run.run_id,
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
    GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
    REA_GHIDRA_PROJECT: projectFile,
    REA_GHIDRA_PROGRAM: "/Fixture.exe",
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { JAVA_HOME: process.env.JAVA_HOME }),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "rea.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  client = new Client({ name: "rea-real-persistent", version: "1" });
  let stderr = "";
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    const openStarted = performance.now();
    const opened = await tool("open_binary", {
      path: targetPath,
      provider_id: "ghidra",
    });
    assert.notEqual(opened.isError, true, JSON.stringify(opened));
    const pseudo = await tool("procedure_pseudo_code", {
      procedure: PROJECT_NAME,
    });
    const firstQueryMs = Math.round(performance.now() - openStarted);
    assert.notEqual(pseudo.isError, true, JSON.stringify(pseudo));
    const evidence = parseEvidence(pseudo.structuredContent);
    assert.equal(evidence.subject.digest.sha256, sha256);
    assert.equal(evidence.provider.id, "ghidra");
    const parameters = evidence.analysis_profile.parameters;
    assert.equal(parameters.import_mode, "persistent-project-read-only");
    assert.equal(parameters.persistent_project.program, "/Fixture.exe");
    assert.equal(
      parameters.persistent_project.configured_project_file,
      projectFile,
    );
    assert.equal(parameters.analyzer_preset, "caller-project-recorded");
    assert.equal(typeof evidence.normalized_result, "string");
    // The name exists only in the saved project, never in the PE bytes.
    assert.match(evidence.normalized_result, new RegExp(PROJECT_NAME, "u"));
    assert.match(evidence.normalized_result, /return 0/u);
    assert.ok(
      evidence.limitations.some((text) =>
        text.includes("caller assertions, not Ghidra discoveries"),
      ),
      JSON.stringify(evidence.limitations),
    );
    const annotation = await tool("annotate_native_function", {
      procedure: ENTRY,
      name: "rea_must_not_apply",
    });
    assert.equal(annotation.isError, true, JSON.stringify(annotation));
    const refusedAnnotation = requireMcpToolError(annotation);
    await tool("close_binary");

    // 3. The same project refuses another artifact and names both digests.
    const mismatch = await tool("open_binary", {
      path: otherPath,
      provider_id: "ghidra",
    });
    const refused =
      mismatch.isError === true
        ? mismatch
        : await tool("procedure_pseudo_code", { procedure: "0x401000" });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    const mismatchError = requireMcpToolError(refused);
    assert.equal(
      mismatchError.code,
      "unsupported_target",
      JSON.stringify(mismatchError),
    );
    const mismatchText = JSON.stringify(mismatchError);
    assert.ok(mismatchText.includes(sha256), mismatchText);
    assert.ok(mismatchText.includes(otherSha256), mismatchText);
    await tool("close_binary");
    report = {
      ghidra_version: installation.providerVersion,
      target_sha256: sha256,
      project_analysis_ms: analyzeMs,
      rea_open_and_first_decompile_ms: firstQueryMs,
      import_mode: parameters.import_mode,
      pseudocode: evidence.normalized_result,
      annotation_refusal: refusedAnnotation.code,
      mismatch_refusal: mismatchError.code,
      mismatch_message: mismatchError.message,
    };
  } catch (error) {
    if (stderr.length > 0) console.error(stderr);
    throw error;
  } finally {
    await client.close();
  }

  // 4. Opening the project read-only left every saved database file unchanged.
  const after = await projectDigests(projects);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );
  assert.deepEqual(
    changed.filter((path) => path.includes(".gbf") || path.endsWith(".gpr")),
    [],
    `Project database files changed: ${changed.join(", ")}`,
  );
  report.project_files_changed_by_open = changed;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
assert.ok(report, "No persistent-project report was produced");
const verifierRun = await completeVerifierRun(run);
assertVerifierCleanupComplete(verifierRun.process_lineage);
process.stdout.write(
  `${JSON.stringify({ verifier_run: verifierRun, ...report, cleanup: "complete" }, null, 2)}\n`,
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function projectDigests(directory) {
  const digests = new Map();
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    // Ghidra creates lock files only while a project is open.
    if (entry.name.includes(".lock")) continue;
    digests.set(relative(directory, path), digest(await readFile(path)));
  }
  return digests;
}

async function tool(name, arguments_ = {}) {
  return client.callTool({ name, arguments: arguments_ }, { timeout: 600000 });
}

async function runHeadless(arguments_) {
  const launch = await spawnOwnedProviderProcess({
    command: join(process.env.GHIDRA_INSTALL_DIR, "support", "analyzeHeadless"),
    arguments: arguments_,
    runId: run.run_id,
    expectedCommand: null,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  try {
    assert.ok(
      await supervisor.waitForExit(600_000),
      "Ghidra project preparation exceeded its deadline",
    );
    const snapshot = supervisor.snapshot();
    const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
    assert.equal(snapshot.exitCode, 0, output);
    return output;
  } finally {
    const stopped = await supervisor.stop();
    assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
    supervisor.dispose();
  }
}
