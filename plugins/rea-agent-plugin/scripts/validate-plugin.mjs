#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const checks = [];

function check(condition, message) {
  if (condition) checks.push(message);
  else errors.push(message);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(resolve(pluginRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(\`${relativePath}: invalid or unreadable JSON (\${error.message})\`);
    return null;
  }
}

function exists(relativePath) {
  return existsSync(resolve(pluginRoot, relativePath));
}

const portable = readJson("plugin.json");
const claude = readJson(".claude-plugin/plugin.json");
const codex = readJson(".codex-plugin/plugin.json");
const mcp = readJson(".mcp.json");

for (const [label, manifest] of [
  ["portable", portable],
  ["Claude Code", claude],
  ["Codex", codex],
]) {
  if (!manifest) continue;
  check(manifest.name === "rea-reverse-engineering", \`\${label} manifest has the expected plugin name\`);
  check(typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version), \`\${label} manifest has a semantic version\`);
  check(typeof manifest.description === "string" && manifest.description.trim().length > 0, \`\${label} manifest has a description\`);
}

if (portable && codex) {
  check(portable.version === codex.version, "portable and Codex manifest versions match");
  check(portable.name === codex.name, "portable and Codex manifest names match");
}
if (portable && claude) {
  check(portable.version === claude.version, "portable and Claude Code manifest versions match");
  check(portable.name === claude.name, "portable and Claude Code manifest names match");
}

for (const relativePath of [
  "README.md",
  ".mcp.json",
  "skills/reverse-engineer-anything/SKILL.md",
]) {
  check(exists(relativePath), \`required file exists: \${relativePath}\`);
}

if (portable) {
  check(typeof portable.skills === "string" && exists(portable.skills.replace(/^\.\//, "")), "portable manifest points to an existing skills directory");
  check(typeof portable.mcpServers === "string" && exists(portable.mcpServers.replace(/^\.\//, "")), "portable manifest points to an existing MCP configuration");
}

if (mcp) {
  const server = mcp.mcpServers?.rea;
  check(Boolean(server), ".mcp.json declares the rea MCP server");
  if (server) {
    check(server.command === "npx", "REA MCP server uses npx");
    check(Array.isArray(server.args) && server.args.includes("rea-agents@latest") && server.args.includes("mcp"), "REA MCP command invokes the published rea-agents MCP entry point");
  }
}

const skillPath = resolve(pluginRoot, "skills/reverse-engineer-anything/SKILL.md");
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  check(Boolean(frontmatter), "skill has YAML frontmatter");
  if (frontmatter) {
    check(/^name:\s*reverse-engineer-anything\s*$/m.test(frontmatter[1]), "skill frontmatter name matches its directory");
    check(/^description:\s*.+$/m.test(frontmatter[1]), "skill frontmatter includes a description");
  }
  for (const requiredHeading of ["## Core rules", "## Investigation workflow", "## Target-specific guidance"]) {
    check(skill.includes(requiredHeading), \`skill includes section: \${requiredHeading}\`);
  }
}

console.log(\`REA plugin validation: \${checks.length} checks passed; \${errors.length} failed.\\n\`);
for (const item of checks) console.log(\`PASS  \${item}\`);
for (const item of errors) console.error(\`FAIL  \${item}\`);

if (errors.length > 0) process.exitCode = 1;
