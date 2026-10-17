import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pluginRoot, "../..");

async function read(relativePath, root = pluginRoot) {
  return readFile(path.join(root, relativePath), "utf8");
}
async function exists(relativePath, root = pluginRoot) {
  await access(path.join(root, relativePath));
  return true;
}
async function json(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function runValidatorWithMutation(mutate) {
  const tempRoot = await mkdtemp(
    path.join(repoRoot, ".plugin-validation-regression-"),
  );
  const copiedRoot = path.join(tempRoot, "plugin");
  try {
    await cp(pluginRoot, copiedRoot, { recursive: true });
    await mutate(copiedRoot);
    try {
      return execFileSync(
        process.execPath,
        [path.join(copiedRoot, "scripts/validate-plugin.mjs")],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      return String(error.stdout ?? "") + "\n" + String(error.stderr ?? "");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("01: plugin README exists", async () => assert.equal(await exists("README.md"), true));
test("02: skills catalog exists", async () => assert.equal(await exists("SKILLS_CATALOG.md"), true));
test("03: agent guide exists", async () => assert.equal(await exists("AGENTS_AND_SUBAGENTS.md"), true));
test("04: MCP config exists", async () => assert.equal(await exists(".mcp.json"), true));
test("05: Claude plugin manifest exists", async () => assert.equal(await exists(".claude-plugin/plugin.json"), true));
test("06: Codex plugin manifest exists", async () => assert.equal(await exists(".codex-plugin/plugin.json"), true));
test("07: workflow guide exists", async () => assert.equal(await exists("AGENT_WORKFLOW.md"), true));
test("08: task template exists", async () => assert.equal(await exists("templates/agent-task.md"), true));
test("09: handoff template exists", async () => assert.equal(await exists("templates/agent-handoff.md"), true));

test("10: Claude manifest parses as JSON", async () => {
  const manifest = await json(".claude-plugin/plugin.json");
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.length > 0);
});
test("11: Claude manifest has a semantic version", async () => {
  const { version } = await json(".claude-plugin/plugin.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
test("12: Claude manifest has author attribution", async () => {
  const { author } = await json(".claude-plugin/plugin.json");
  assert.equal(author.name, "Lucas Belucci Bellini");
  assert.match(author.url, /^https:\/\/github\.com\//);
});
test("13: Claude manifest points to the expected repository", async () => {
  const manifest = await json(".claude-plugin/plugin.json");
  assert.equal(manifest.repository, "https://github.com/Lucas-Belucci-Bellini/rea");
});
test("14: Codex manifest parses as JSON", async () => {
  const manifest = await json(".codex-plugin/plugin.json");
  assert.equal(typeof manifest.name, "string");
});
test("15: Claude and Codex manifests use the same plugin name", async () => {
  const claude = await json(".claude-plugin/plugin.json");
  const codex = await json(".codex-plugin/plugin.json");
  assert.equal(claude.name, codex.name);
});
test("16: Codex manifest declares a skills directory", async () => {
  const manifest = await json(".codex-plugin/plugin.json");
  assert.equal(manifest.skills, "./skills/");
});
test("17: Codex manifest declares the MCP configuration", async () => {
  const manifest = await json(".codex-plugin/plugin.json");
  assert.equal(manifest.mcpServers, "./.mcp.json");
});
test("18: MCP configuration parses as JSON", async () => {
  const config = await json(".mcp.json");
  assert.ok(config.mcpServers);
});
test("19: MCP configuration registers the REA server", async () => {
  const config = await json(".mcp.json");
  assert.ok(config.mcpServers.rea);
});
test("20: MCP server launches through npx", async () => {
  const config = await json(".mcp.json");
  assert.equal(config.mcpServers.rea.command, "npx");
});
test("21: MCP server uses the published REA package", async () => {
  const config = await json(".mcp.json");
  assert.ok(config.mcpServers.rea.args.includes("rea-agents@latest"));
});
test("22: MCP server invokes the mcp command", async () => {
  const config = await json(".mcp.json");
  assert.ok(config.mcpServers.rea.args.includes("mcp"));
});
test("23: README documents both target clients", async () => {
  const content = await read("README.md");
  assert.match(content, /Claude Code/);
  assert.match(content, /Codex/);
});
test("24: README explains that the MCP package is published", async () => {
  const content = await read("README.md");
  assert.match(content, /rea-agents@latest/);
});
test("25: README explains the plugin authority boundaries", async () => {
  const content = await read("README.md");
  assert.match(content, /does not grant GitHub credentials/i);
});
test("26: README points to the skill catalog", async () => {
  const content = await read("README.md");
  assert.match(content, /SKILLS_CATALOG\.md/);
});
test("27: skills catalog declares its inventory", async () => {
  const content = await read("SKILLS_CATALOG.md");
  assert.match(content, /75 skills total/i);
});
test("28: skills catalog has skill links", async () => {
  const content = await read("SKILLS_CATALOG.md");
  assert.match(content, /\.\/skills\/[^)]+\/SKILL\.md/);
});
test("29: every catalog skill link resolves to a file", async () => {
  const content = await read("SKILLS_CATALOG.md");
  const links = [...content.matchAll(/\]\(\.\/skills\/([^/]+)\/SKILL\.md\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 30, `Expected at least 30 cataloged skills, found ${links.length}`);
  assert.equal(new Set(links).size, links.length, "Catalog contains duplicate skill links");
  for (const skill of links) await exists(`skills/${skill}/SKILL.md`);
});
test("30: agent guide documents the role definitions", async () => {
  const content = await read("AGENTS_AND_SUBAGENTS.md");
  assert.match(content, /11 specialist role definitions/);
});
test("31: agent guide distinguishes Codex role briefs from automatic subagents", async () => {
  const content = await read("AGENTS_AND_SUBAGENTS.md");
  assert.match(content, /role briefs/i);
  assert.match(content, /does not declare this directory as an automatically registered/i);
});
test("32: agent guide includes safety rules for parallel work", async () => {
  const content = await read("AGENTS_AND_SUBAGENTS.md");
  assert.match(content, /Do not allow parallel edits to the same file or branch/);
});
test("33: workflow guide exists and describes verification", async () => {
  const content = await read("AGENT_WORKFLOW.md");
  assert.match(content, /test|verif|check/i);
});
test("34: task template contains a task contract", async () => {
  const content = await read("templates/agent-task.md");
  assert.match(content, /acceptance|success|deliverable|scope/i);
});
test("35: handoff template captures evidence or test results", async () => {
  const content = await read("templates/agent-handoff.md");
  assert.match(content, /test|evidence|verification|result/i);
});

test("36: plugin validator rejects a JSON null root manifest", async () => {
  const output = await runValidatorWithMutation(async (root) => {
    await writeFile(path.join(root, "plugin.json"), "null\n");
  });
  assert.match(
    output,
    /plugin\.json: invalid or unreadable JSON \(expected a JSON object at the root\)/,
  );
});

test("37: plugin validator rejects malformed YAML frontmatter", async () => {
  const output = await runValidatorWithMutation(async (root) => {
    const skillPath = path.join(root, "skills", "acceptance-criteria", "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    const malformed = content.replace(
      /^description:.*$/m,
      "description: [unterminated",
    );
    assert.notEqual(
      malformed,
      content,
      "fixture must contain a description field",
    );
    await writeFile(skillPath, malformed);
  });
  assert.match(output, /skill acceptance-criteria: invalid YAML frontmatter/);
});
