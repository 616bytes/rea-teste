import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32").for([
  ["rea", "rea-agents"],
  ["rea-agents", "rea"],
] as const)(
  "recognizes setup through %s when doctor and uninstall use %s",
  async ([registered, alternate], { processes }) => {
    const root = await createTestTempDirectory("rea-launcher-registration-");
    const home = join(root, "home");
    const config = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const unrelated = { command: "other-server", args: [] };
    await writeFile(config, JSON.stringify({ mcpServers: { unrelated } }));
    for (const name of [registered, alternate])
      await symlink(resolve("scripts/rea.mjs"), join(root, name));
    const run = (alias: string, arguments_: readonly string[]) =>
      processes.run(process.execPath, [join(root, alias), ...arguments_], {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: process.env.PATH ?? "",
        },
        timeoutMs: 30_000,
      });

    const setup = await run(registered, [
      "setup",
      "--client",
      "cursor",
      "--skill=false",
      "--yes",
      "--json",
    ]);
    expect(setup.exitCode, setup.stderr).toBe(0);
    for (const alias of [registered, alternate]) {
      const doctor = await run(alias, [
        "doctor",
        "--client",
        "cursor",
        "--skill=false",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stdout).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        scope_checks: expect.arrayContaining([
          expect.objectContaining({ name: "registration:cursor", ok: true }),
        ]),
      });
    }
    const uninstall = await run(alternate, ["uninstall", "--json"]);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: { unrelated },
    });
  },
);

cliTest.skipIf(process.platform === "win32").for(["direct", "node"] as const)(
  "doctor keeps a broken %s launcher unknown and uninstall retains its registration",
  async (form, { cli }) => {
    const home = await createTestTempDirectory("rea-unresolved-launcher-");
    const launcher = join(home, "broken");
    await symlink(join(home, "removed.mjs"), launcher);
    const command =
      form === "direct"
        ? [launcher, "mcp"]
        : [process.execPath, launcher, "mcp"];
    const config = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
        unrelated: { command: "other-server", args: [] },
      },
    });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    };

    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cursor", "--skill=false", "--json"],
      environment,
    });
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "cursor",
            command,
            state: "unknown",
            remediation: expect.stringContaining(
              "executable identity cannot be verified",
            ),
          }),
        ]),
      },
    });
    const uninstall = await cli.run({
      arguments: ["uninstall", "--json"],
      environment,
    });
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(original);
  },
);
