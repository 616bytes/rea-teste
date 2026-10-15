#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const expectedChecks = [
  "bridge_source_bound",
  "relocation_protection_precedes_decompiler",
  "program_relocations_are_loader_relocations",
  "relocation_record_added",
  "reader_references_relocation",
  "destination_is_loaded_initialized",
  "destination_is_file_backed",
  "destination_is_non_writable",
  "destination_block_is_volatile",
  "destination_permissions_preserved",
  "target_filebytes_original_unchanged",
  "loader_bytes_differ_from_file_bytes",
  "evidence_limitation_represents_loader_uncertainty",
];

if (process.argv.length !== 2)
  throw new Error(
    "Usage: node scripts/verify-real-ghidra-loader-relocation.mjs",
  );
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "Loader-relocation verification requires a Linux or macOS Ghidra host.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a bring-your-own Ghidra installation.",
  );

const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
assert.ok(
  installation.analyzeHeadlessPath !== null &&
    (installation.status === "available" ||
      installation.rejection?.code === "executable_missing"),
  JSON.stringify(installation),
);

const run = createVerifierRun();
const workspace = await mkdtemp(
  join(tmpdir(), "rea-ghidra-loader-relocation-"),
);
const project = join(workspace, "project");
const target = join(
  workspace,
  process.platform === "darwin"
    ? "rea-loader-relocation.macho"
    : "rea-loader-relocation.elf",
);
const fixture = fileURLToPath(
  new URL("../tests/conformance/ghidra/loader-relocation.c", import.meta.url),
);
const bridgeDirectory = fileURLToPath(
  new URL("../bridge/ghidra", import.meta.url),
);
const fixtureDirectory = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const bridge = join(bridgeDirectory, "ReaGhidraBridge.java");
const compiler = process.env.REA_CC ?? "cc";
let supervisor;
let report;

try {
  await mkdir(project);
  await buildFixture(compiler, fixture, target);
  const targetDigest = digest(await readFile(target));
  const launch = await spawnOwnedProviderProcess({
    command: installation.analyzeHeadlessPath,
    arguments: [
      project,
      "LoaderRelocation",
      "-import",
      target,
      "-readOnly",
      "-deleteProject",
      "-scriptPath",
      `${bridgeDirectory};${fixtureDirectory}`,
      "-postScript",
      "ReaLoaderRelocationProbe.java",
      bridge,
    ],
    runId: run.run_id,
    expectedCommand: null,
  });
  supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  assert.ok(
    await supervisor.waitForExit(180_000),
    "Ghidra loader-relocation probe exceeded its 180-second deadline",
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  const matches = [
    ...output.matchAll(/REA_LOADER_RELOCATION_PROBE_JSON (\{[^\r\n]*\})/gu),
  ];
  assert.equal(matches.length, 1, output);
  report = JSON.parse(matches[0][1]);
  assert.equal(report.status, "passed");
  assert.equal(report.ghidra_version, installation.providerVersion);
  assert.deepEqual(
    expectedChecks.every((check) => report.checks.includes(check)),
    true,
  );
  assert.equal(report.source_bytes_unchanged, true);
  assert.equal(report.permissions, "read=true,write=false,execute=false");
  assert.ok(
    report.limitations.some(
      (value) =>
        value.includes("non-writable block REA_RELRO") &&
        value.includes("file-backed value may differ") &&
        value.includes("not authoritative"),
    ),
  );
  assert.equal(digest(await readFile(target)), targetDigest);
  report = {
    ...report,
    target_sha256: targetDigest,
    decompiler_scope: report.decompiler_verified
      ? "native Ghidra decompiler limitation check passed"
      : "native Ghidra decompiler unavailable; bridge limitation and volatile-block checks passed",
  };
} finally {
  if (supervisor !== undefined) {
    const stopped = await supervisor.stop();
    supervisor.dispose();
    assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
  }
  await rm(workspace, { recursive: true, force: true });
}

assert.ok(report);
console.log(
  JSON.stringify({
    ...report,
    cleanup: "complete",
    verifier_run: await completeVerifierRun(run),
  }),
);

async function buildFixture(compiler, source, output) {
  const arguments_ =
    process.platform === "darwin"
      ? [
          "-Wl,-e,_rea_loader_start",
          "-Wl,-undefined,dynamic_lookup",
          source,
          "-o",
          output,
        ]
      : [
          "-fPIE",
          "-pie",
          "-nostdlib",
          "-Wl,-e,rea_loader_start",
          source,
          "-o",
          output,
        ];
  await exec(compiler, arguments_, { timeout: 60_000 });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
