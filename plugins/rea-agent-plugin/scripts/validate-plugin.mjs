#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const checks = [];
function check(condition, message) { if (condition) checks.push(message); else errors.push(message); }
function readJson(relativePath) {
  try { return JSON.parse(readFileSync(resolve(pluginRoot, relativePath), "utf8")); }
  catch (error) { errors.push(relativePath + ": invalid or unreadable JSON (" + error.message + ")"); return null; }
}
function exists(relativePath) { return existsSync(resolve(pluginRoot, relativePath)); }

const portable = readJson("plugin.json");
const claude = readJson(".claude-plugin/plugin.json");
const codex = readJson(".codex-plugin/plugin.json");
const mcp = readJson(".mcp.json");
for (const [label, manifest] of [["portable",portable],["Claude Code",claude],["Codex",codex]]) {
  if (!manifest) continue;
  check(manifest.name === "rea-reverse-engineering", label + " manifest has expected plugin name");
  check(typeof manifest.version === "string" && /^\\d+\\.\\d+\\.\\d+$/.test(manifest.version), label + " manifest has semantic version");
  check(typeof manifest.description === "string" && manifest.description.trim().length > 0, label + " manifest has description");
}
if (portable && codex) {
  check(portable.version === codex.version, "portable and Codex versions match");
  check(portable.name === codex.name, "portable and Codex names match");
}
if (portable && claude) {
  check(portable.version === claude.version, "portable and Claude versions match");
  check(portable.name === claude.name, "portable and Claude names match");
}
for (const path of ["README.md","TESTING.md","AGENT_WORKFLOW.md","AGENTS_AND_SUBAGENTS.md","SKILLS_CATALOG.md",".mcp.json","templates/agent-task.md","templates/agent-handoff.md"]) {
  check(exists(path), "required file exists: " + path);
}
if (portable) {
  check(typeof portable.skills === "string" && exists(portable.skills.replace(/^\\.\\//, "")), "portable manifest points to existing skills directory");
  check(typeof portable.mcpServers === "string" && exists(portable.mcpServers.replace(/^\\.\\//, "")), "portable manifest points to existing MCP configuration");
}
if (mcp) {
  const server = mcp.mcpServers?.rea;
  check(Boolean(server), ".mcp.json declares the rea MCP server");
  if (server) {
    check(server.command === "npx", "REA MCP server uses npx");
    check(Array.isArray(server.args) && server.args.includes("rea-agents@latest") && server.args.includes("mcp"), "MCP invokes published rea-agents entry point");
  }
}

const skillsRoot = resolve(pluginRoot, "skills");
let skillDirectories = [];
try { skillDirectories = readdirSync(skillsRoot, {withFileTypes:true}).filter(e=>e.isDirectory()); }
catch (error) { errors.push("skills/: unable to read directory (" + error.message + ")"); }
check(skillDirectories.length >= 70, "plugin includes at least 70 skills (found " + skillDirectories.length + ")");
const catalog = exists("SKILLS_CATALOG.md") ? readFileSync(resolve(pluginRoot,"SKILLS_CATALOG.md"),"utf8") : "";
const catalogSlugs = new Set([...catalog.matchAll(/\\]\\(\\.\\/skills\\/([a-z0-9-]+)\\/SKILL\\.md\\)/g)].map(m=>m[1]));
check(Boolean(catalog), "skills catalog exists and is readable");
const allSlugs = new Set();
for (const entry of skillDirectories) {
  const name=entry.name, path=resolve(skillsRoot,name,"SKILL.md");
  check(existsSync(path), "skill "+name+" has SKILL.md");
  if(!existsSync(path)) continue;
  const content=readFileSync(path,"utf8"), fm=content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);
  check(Boolean(fm), "skill "+name+" has YAML frontmatter");
  if(fm) {
    check(fm[1].split(/\\r?\\n/).some(line=>line===("name: "+name)), "skill "+name+" frontmatter name matches directory");
    check(/^description:\\s*.+$/m.test(fm[1]), "skill "+name+" has a description");
    check(content.length>=700, "skill "+name+" contains substantive workflow guidance");
  }
  check(content.includes("## "), "skill "+name+" has documented sections");
  check(catalogSlugs.has(name), "skill "+name+" is linked from catalog");
  allSlugs.add(name);
}
for(const slug of catalogSlugs) check(allSlugs.has(slug), "catalog link resolves to skill "+slug);

const agentsRoot=resolve(pluginRoot,"agents");
let agentFiles=[];
try { agentFiles=readdirSync(agentsRoot,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith(".md")); }
catch(error) { errors.push("agents/: unable to read agent directory ("+error.message+")"); }
check(agentFiles.length>=8, "plugin includes at least eight specialist agent definitions");
for(const entry of agentFiles) {
  const name=entry.name.replace(/\\.md$/,""), content=readFileSync(resolve(agentsRoot,entry.name),"utf8");
  const fm=content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);
  check(Boolean(fm), "agent "+name+" has YAML frontmatter");
  if(fm) {
    check(fm[1].split(/\\r?\\n/).some(line=>line===("name: "+name)), "agent "+name+" name matches filename");
    check(/^description:\\s*.+$/m.test(fm[1]), "agent "+name+" has a description");
    check(/^tools:\\s*.+$/m.test(fm[1]), "agent "+name+" declares tools");
  }
  check(content.length>=700, "agent "+name+" contains substantive role guidance");
  check(content.includes("## "), "agent "+name+" has documented sections");
}
console.log("REA plugin validation: "+checks.length+" checks passed; "+errors.length+" failed.\\n");
for(const item of checks) console.log("PASS  "+item);
for(const item of errors) console.error("FAIL  "+item);
console.log("Inventory: "+skillDirectories.length+" skills, "+agentFiles.length+" specialist agent definitions.");
if(errors.length>0) process.exitCode=1;
