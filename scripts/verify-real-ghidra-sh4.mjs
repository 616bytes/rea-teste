import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-sh4.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "SH-4 raw-binary verification requires a Linux or macOS Ghidra host.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a bring-your-own Ghidra installation.",
  );

const exec = promisify(execFile);
const run = createVerifierRun();
const root = fileURLToPath(new URL("..", import.meta.url));
// Source-owned little-endian SH-4 image, loaded at 0x8c010000:
//   0x8c010000 e02a  mov #42,r0
//   0x8c010002 000b  rts
//   0x8c010004 0009  nop (delay slot)
const bytes = Buffer.from("2ae00b000900", "hex");
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(
  sha256,
  "430a7dbe1b059cddaf6e1530c64da4f2c5e490c8259ebf7491df7720141d7015",
);
await mkdir(join(root, "build"), { recursive: true });
const workspace = await mkdtemp(join(root, "build", "rea-sh4-proof-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const path = join(workspace, "image.bin");
await writeFile(path, bytes);
const entrypoint = join(root, "scripts", "rea.mjs");
const env = {
  ...process.env,
  TMPDIR: runtime,
  TMP: runtime,
  TEMP: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-sh4-proof", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
let report;
try {
  await client.connect(transport);
  const opened = await call("open_binary", {
    path,
    format: "raw-binary",
    architecture: "sh4",
    entry_point: "0x8c010000",
    provider_id: "ghidra",
  });
  assert.equal(opened.architecture, "sh4");
  assert.equal(opened.entry_point, "0x8c010000");
  const status = await call("binary_session");
  const image = evidence(await call("inspect_native_load_image"));
  assert.equal(
    image.normalized_result.status,
    "verified",
    JSON.stringify(image.normalized_result),
  );
  assert.equal(image.normalized_result.architecture, "sh4");
  assert.equal(image.normalized_result.base_address, "0x8c010000");
  assert.equal(image.normalized_result.language_id, "SuperH4:LE:32:default");
  assert.equal(image.normalized_result.compiler_spec_id, "default");
  assert.equal(image.normalized_result.file_bytes, bytes.length);
  assert.equal(image.analysis_profile.parameters.loader, "BinaryLoader");
  assert.equal(
    image.analysis_profile.parameters.language_id,
    "SuperH4:LE:32:default",
  );
  const memory = evidence(
    await call("read_bytes", {
      address: "0x8c010000",
      length: bytes.length,
    }),
  );
  assert.equal(memory.normalized_result.bytes_hex, bytes.toString("hex"));
  const instructions = evidence(
    await call("read_function_instructions", { procedure: "0x8c010000" }),
  );
  assert.deepEqual(instructions.normalized_result.instructions, [
    "0x8c010000: mov #0x2a, r0",
    "0x8c010002: rts",
    "0x8c010004: _nop",
  ]);
  const pseudo = evidence(
    await call("procedure_pseudo_code", { procedure: "0x8c010000" }),
  );
  assert.match(pseudo.normalized_result, /return\s+(?:42|0x2a)\s*;/iu);

  // Rejected selections must not replace the live session.
  for (const [entryPoint, reason] of [
    [
      "0x8c010001",
      /raw-binary sh4 entry_point 0x8c010001 must be 2-byte aligned/u,
    ],
    [
      "0xfffffffc",
      /raw-binary mapping from 0xfffffffc must fit in the sh4 address width/u,
    ],
  ]) {
    const rejected = await client.callTool({
      name: "open_binary",
      arguments: {
        path,
        format: "raw-binary",
        architecture: "sh4",
        entry_point: entryPoint,
      },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), reason);
    const preserved = await call("binary_session");
    assert.equal(preserved.analysis_run.run_id, status.analysis_run.run_id);
    assert.equal(preserved.entry_point, "0x8c010000");
  }
  await call("close_binary");
  await client.ping();

  const { stdout } = await exec(
    process.execPath,
    [
      entrypoint,
      "inspect-native-load-image",
      path,
      "--target-format",
      "raw-binary",
      "--architecture",
      "sh4",
      "--entry-point",
      "0x8c010000",
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  const cli = evidence(JSON.parse(stdout));
  assert.deepEqual(cli.normalized_result, image.normalized_result);
  assert.equal(cli.analysis_profile.digest, image.analysis_profile.digest);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(
    (await readdir(runtime)).filter((name) => name.startsWith("rea-ghidra-")),
    [],
    "Owned Ghidra runtime survived close",
  );
  report = {
    ok: true,
    mocked: false,
    lane: "ghidra-sh4",
    host: process.platform,
    provider: image.provider,
    target: {
      sha256,
      bytes: bytes.length,
      architecture: "sh4",
      entry: "0x8c010000",
    },
    cli_mcp_load_image_parity: true,
    instructions: true,
    decompilation: true,
    misaligned_entry_preserves_session: true,
    invalid_mapping_preserves_session: true,
    source_unchanged: true,
    runtime_cleanup: "complete",
  };
} catch (cause) {
  if (stderr) process.stderr.write(stderr);
  throw cause;
} finally {
  try {
    await client.close();
  } finally {
    await transport.close();
  }
}
assert.deepEqual(
  await readdir(runtime),
  [],
  `Runtime resources survived server shutdown; retained workspace: ${workspace}`,
);
const verifierRun = await completeVerifierRun(run);
assert.equal(verifierRun.process_lineage.status, "verified");
assert.deepEqual(verifierRun.process_lineage.descendants, []);
await rm(workspace, { recursive: true, force: true });
process.stdout.write(
  JSON.stringify({ verifier_run: verifierRun, ...report }) + "\n",
);

async function call(name, args = {}) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (["open_binary", "binary_session", "close_binary"].includes(name))
    return requireMcpOperationResult(result, name);
  return result.structuredContent;
}

function evidence(value) {
  const result = parseEvidence(value);
  assert.equal(result.subject.digest.sha256, sha256);
  assert.equal(result.subject.architecture, "sh4");
  assert.equal(result.subject.format, "raw-binary");
  return result;
}
