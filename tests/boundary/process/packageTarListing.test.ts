import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);
const packerUrl = pathToFileURL(
  resolve("scripts/verify-package-pack.mjs"),
).href;
const catalogUrl = pathToFileURL(resolve("dist/catalogIdentity.js")).href;
const bridge = "package/bridge/hopper_bridge.py";
const members = [
  bridge,
  "package/bridge/cutter/rea_bridge.py",
  "package/bridge/ghidra/ReaGhidraBridge.java",
  "package/bridge/ghidra/ReaGhidraBundleActivator.java",
];

async function verifyListing(listing: string) {
  const workspace = await createTestTempDirectory("rea-tar-listing-");
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { CATALOG_IDENTITY } from ${JSON.stringify(catalogUrl)};
let bridgeParsed = false;
childProcess.execFile = () => { throw new Error("Expected promisified execution"); };
childProcess.execFile[promisify.custom] = async (command, args) => {
  let stdout;
  if ((command === "npm" && args[0] === "pack") || (command === process.execPath && args[1] === "pack")) stdout = "fixture.tgz\\n";
  else if (command === "tar" && args[0] === "-tf") stdout = ${JSON.stringify(listing)};
  else if (command === "tar" && args[0] === "-xOf" && args[2] === "package/package.json")
    stdout = JSON.stringify({ bin: { rea: "scripts/rea.mjs", "rea-agents": "scripts/rea.mjs" }, mcpName: "io.github.morluto/rea", dependencies: { "@lydell/node-pty": "1.1.0" } });
  else if (command === "tar" && args[0] === "-xOf" && args[2] === "package/skills/reverse-engineer-anything/SKILL.md")
    stdout = "  tool_count: " + CATALOG_IDENTITY.counts.mcp_tools + "\\n";
  else if (command === "tar" && args[0] === "-xf") stdout = "";
  else if (command === "python3") { bridgeParsed = true; stdout = ""; }
  else throw new Error("Unexpected command: " + command + " " + JSON.stringify(args));
  return { stdout, stderr: "" };
};
syncBuiltinESMExports();
const { verifyPackagePack } = await import(${JSON.stringify(packerUrl)});
try {
  const result = await verifyPackagePack({ root: process.cwd(), workspace: ${JSON.stringify(workspace)} });
  process.stdout.write(JSON.stringify({ ...result, bridgeParsed }));
} catch (cause) {
  process.stdout.write(JSON.stringify({ error: cause.message, bridgeParsed }));
}`,
  ]);
  return { result: JSON.parse(stdout), workspace };
}

for (const ending of ["\n", "\r\n"]) {
  const label = ending === "\n" ? "LF" : "CRLF";
  it(`accepts exact bridge members in ${label} tar output`, async () => {
    const { result, workspace } = await verifyListing(
      members.join(ending) + ending,
    );
    expect(result).toEqual({
      tarball: join(workspace, "pack/fixture.tgz"),
      bridgeParsed: true,
    });
  });

  it.each([
    ["package/bridge/stale.pyc", "package contained generated Python bytecode"],
    [
      "package/bridge/__pycache__/stale",
      "package contained generated Python bytecode",
    ],
    [
      "package/.cache/catalog.json",
      "package included development cache or test metadata",
    ],
    [
      "package/.agents/skill.md",
      "package included authored skill sources instead of only the generated bundle",
    ],
  ])(
    `rejects forbidden member %s in ${label} tar output`,
    async (member, error) => {
      const { result } = await verifyListing(
        [...members, member].join(ending) + ending,
      );
      expect(result).toEqual({ error, bridgeParsed: false });
    },
  );

  it.each([
    `${bridge} `,
    ` ${bridge}`,
    ...(ending === "\r\n" ? [`${bridge}\r`] : []),
  ])(
    `does not normalize member identity %j in ${label} tar output`,
    async (member) => {
      const { result } = await verifyListing(
        [member, ...members.slice(1)].join(ending) + ending,
      );
      expect(result).toEqual({
        error: `package omitted ${bridge}`,
        bridgeParsed: false,
      });
    },
  );
}
