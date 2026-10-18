import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const setupArguments = [
  "setup",
  "--client",
  "claude_code",
  "--skill=false",
  "--json",
] as const;

cliTest(
  "Claude Code setup and doctor reject JSONC comments before mutating or backing up",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-code-comments-cli-");
    const marker = join(home, ".claude");
    const config = join(home, ".claude.json");
    const original = `{
  // preserve this unrelated setting
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}
`;
    await mkdir(marker, { recursive: true });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      TMPDIR: home,
    };
    const run = (arguments_: readonly string[]) =>
      cli.run({ arguments: arguments_, cwd: home, environment });

    const preview = await run([...setupArguments, "--dry-run"]);
    expect(preview.exitCode).toBe(1);
    expect(preview.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("malformed"),
    });
    expect(await readFile(config, "utf8")).toBe(original);

    const applied = await run([...setupArguments, "--yes"]);
    expect(applied.exitCode).toBe(1);
    expect(applied.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const doctor = await run(["doctor", "--client", "claude_code", "--json"]);
    expect(doctor.exitCode).toBe(1);
    expect(doctor.json).toMatchObject({
      healthy: false,
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "claude_code",
            state: "invalid",
            remediation: expect.stringContaining("malformed"),
          }),
        ]),
      },
    });
  },
);

cliTest(
  "Claude Code setup rejects trailing commas before mutating",
  async ({ cli }) => {
    const home = await createTestTempDirectory(
      "rea-claude-code-trailing-comma-cli-",
    );
    const marker = join(home, ".claude");
    const config = join(home, ".claude.json");
    const original = `{
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] },
  }
}
`;
    await mkdir(marker, { recursive: true });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      TMPDIR: home,
    };
    const applied = await cli.run({
      arguments: [...setupArguments, "--yes"],
      cwd: home,
      environment,
    });
    expect(applied.exitCode).toBe(1);
    expect(applied.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "Claude Code setup and doctor configure valid plain JSON and preserve BOM",
  async ({ cli }) => {
    const home = await createTestTempDirectory(
      "rea-claude-code-valid-bom-cli-",
    );
    const marker = join(home, ".claude");
    const config = join(home, ".claude.json");
    const original = `\uFEFF{
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}
`;
    await mkdir(marker, { recursive: true });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      TMPDIR: home,
    };
    const run = (arguments_: readonly string[]) =>
      cli.run({ arguments: arguments_, cwd: home, environment });

    const applied = await run([...setupArguments, "--yes"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      clients: { claude_code: { status: "configured" } },
    });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    const configured = await readFile(config, "utf8");
    expect(configured.startsWith("\uFEFF")).toBe(true);
    expect(JSON.parse(configured.slice(1))).toMatchObject({
      mcpServers: {
        peer: { command: "/usr/bin/true", args: [] },
        rea: {},
      },
    });

    const doctor = await run(["doctor", "--client", "claude_code", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "claude_code",
            state: "aligned",
          }),
        ]),
      },
    });
  },
);
