import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const claudeDesktopClient = async () => {
  const home = await createTestTempDirectory("rea-claude-desktop-profile-");
  const directory = join(home, ".config");
  const client = supportedClients(home, "linux", {
    XDG_CONFIG_HOME: directory,
  }).find(({ name }) => name === "claude_desktop");
  if (client?.markerPath === undefined)
    throw new Error("missing Claude Desktop client");
  expect(client.configPath).toBe(
    join(directory, "Claude", "claude_desktop_config.json"),
  );
  await mkdir(client.markerPath, { recursive: true });
  return { home, client };
};

const storedRegistration = async (configPath: string) =>
  JSON.parse(await readFile(configPath, "utf8")).mcpServers.rea;

const expectedRegistration = (profile?: string) => ({
  command: command[0],
  args: command.slice(1),
  ...(profile === undefined
    ? {}
    : { env: { REA_MCP_INPUT_SCHEMA_PROFILE: profile } }),
});

const statusOf = async (home: string) =>
  (
    await readClientRegistrationStatuses(home, undefined, {
      platform: "linux",
      environment: { XDG_CONFIG_HOME: join(home, ".config") },
    })
  ).find(({ client: name }) => name === "claude_desktop");

describe("Claude Desktop input-schema profile selection", () => {
  it("selects the bounded advertisement for a new registration", async () => {
    const { home, client } = await claudeDesktopClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await storedRegistration(client.configPath)).toEqual(
      expectedRegistration("compact"),
    );
    expect(await statusOf(home)).toMatchObject({ state: "aligned", command });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
  });

  it("preserves an explicitly stored full profile", async () => {
    const { home, client } = await claudeDesktopClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "old-rea",
            args: ["mcp"],
            env: { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
          },
        },
      }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await storedRegistration(client.configPath)).toEqual(
      expectedRegistration("full"),
    );
    expect(await statusOf(home)).toMatchObject({ state: "aligned", command });
  });

  it.each(["full", "compact"] as const)(
    "uses the caller's explicit %s profile",
    async (profile) => {
      const { client } = await claudeDesktopClient();
      expect(
        (
          await configureClientConfiguration(
            client,
            { REA_MCP_INPUT_SCHEMA_PROFILE: profile },
            command,
          )
        ).status,
      ).toBe("configured");
      expect(await storedRegistration(client.configPath)).toEqual(
        expectedRegistration(profile),
      );
    },
  );

  it("reports an omitted-profile registration stale until setup adds compact", async () => {
    const { home, client } = await claudeDesktopClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { command: command[0], args: command.slice(1) } },
      }),
    );
    expect(await statusOf(home)).toMatchObject({ state: "stale", command });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(await storedRegistration(client.configPath)).toEqual(
      expectedRegistration("compact"),
    );
  });

  it("leaves a client without a schema-constrained connector unbounded", async () => {
    const home = await createTestTempDirectory("rea-cursor-unbounded-");
    const directory = join(home, ".config");
    const client = supportedClients(home, "linux", {
      XDG_CONFIG_HOME: directory,
    }).find(({ name }) => name === "cursor");
    if (client?.markerPath === undefined)
      throw new Error("missing Cursor client");
    await mkdir(client.markerPath, { recursive: true });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea.env,
    ).toBeUndefined();
  });
});
