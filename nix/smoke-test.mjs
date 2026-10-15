import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2];
assert.ok(out, "Expected the installed Nix output path");
const root = join(out, "lib/rea-agents");
const dispatcher = join(root, "scripts/rea.mjs");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const home = await mkdtemp(join(tmpdir(), "rea-nix-check-"));
const environment = {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"),
  PATH: "/no-ambient-tools",
  TMPDIR: tmpdir(),
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: home,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
};

try {
  for (const command of [
    join(out, "bin/rea"),
    join(out, "bin/rea-agents"),
    dispatcher,
  ]) {
    assert.equal(run(command, ["--version"]).trim(), manifest.version);
  }

  const runtimePath = JSON.parse(
    run(join(out, "libexec/rea-node"), [
      "-e",
      'console.log(JSON.stringify(require("node:child_process").spawnSync("ps", ["-p", String(process.pid), "-o", "pid="], { encoding: "utf8" })))',
    ]),
  );
  assert.equal(
    runtimePath.status,
    0,
    "The registered launcher's PATH must include procps",
  );

  const doctor = JSON.parse(run(dispatcher, ["mcp", "doctor", "--json"]));
  assert.equal(doctor.healthy, true, JSON.stringify(doctor));
  assert.ok(
    doctor.inventory.tools.observed > 0,
    "MCP tools/list must not be empty",
  );

  const plan = JSON.parse(
    run(dispatcher, [
      "setup",
      "--client",
      "claude_code",
      "--dry-run",
      "--json",
    ]),
  );
  assert.equal(plan.status, "planned", JSON.stringify(plan));
  assert.equal(plan.appliedActions.length, 0);
  assert.ok(
    plan.plannedActions.some(({ kind }) => kind === "configure_client"),
  );
  assert.ok(plan.plannedActions.some(({ kind }) => kind === "install_skill"));
  assert.deepEqual(
    await readdir(home),
    [],
    "Setup dry-run must not write to HOME",
  );

  run(dispatcher, ["setup", "--client", "claude_code", "--yes", "--json"]);
  const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.equal(config.mcpServers.rea.command, dispatcher);
  assert.deepEqual(config.mcpServers.rea.args, ["mcp"]);
  assert.equal(
    run(config.mcpServers.rea.command, ["--version"]).trim(),
    manifest.version,
  );
  await access(join(home, ".claude/skills/reverse-engineer-anything/SKILL.md"));

  const require = createRequire(join(root, "package.json"));
  assert.throws(() => require.resolve("frida"), { code: "MODULE_NOT_FOUND" });
  const { spawn } = require("@lydell/node-pty");
  const terminal = spawn(process.execPath, ["--version"], {
    cwd: home,
    env: environment,
    name: "xterm",
    cols: 80,
    rows: 24,
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error("Native PTY smoke test timed out"));
    }, 10_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        assert.equal(exitCode, 0);
        assert.equal(output.trim(), process.version);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  console.log(
    `REA ${manifest.version}: CLI, MCP, setup registration/skill, and native PTY checks passed`,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}
