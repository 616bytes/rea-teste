import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clientSkillDirectories,
  supportedClients,
} from "./SupportedClients.js";
import {
  clientRegistrationEntry,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
} from "./ClientConfigurationDocument.js";
import { PRODUCT_IDENTITY } from "../identity.js";

const configSuffix = join(".workbuddy", "mcp.json");
const markerSuffix = join(".workbuddy");
const skillSuffix = join(".workbuddy", "skills");

describe("WorkBuddy client", () => {
  for (const platform of ["linux", "win32", "darwin"] as const) {
    it(`resolves the WorkBuddy config and marker paths on ${platform}`, () => {
      const home = "/home/user";
      const clients = supportedClients(home, platform);
      const workbuddy = clients.find((client) => client.name === "workbuddy");
      expect(workbuddy).toBeDefined();
      expect(workbuddy?.displayName).toBe("WorkBuddy");
      expect(workbuddy?.format).toBe("json");
      expect(workbuddy?.configPath?.endsWith(configSuffix)).toBe(true);
      expect(workbuddy?.markerPath?.endsWith(markerSuffix)).toBe(true);
    });
  }

  it("installs the skill under the WorkBuddy user-level skills directory", () => {
    const home = "/home/user";
    const destinations = clientSkillDirectories(home, ["workbuddy"]);
    expect(destinations).toEqual([
      { client: "workbuddy", directory: join(home, skillSuffix) },
    ]);
  });

  it("builds a stdio entry carried by command, args and env", () => {
    const entry = clientRegistrationEntry("json", ["/opt/rea/bin/rea", "mcp"], {
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    });
    expect(entry).toEqual({
      command: "/opt/rea/bin/rea",
      args: ["mcp"],
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    });
  });

  it("round-trips the rea registration through ~/.workbuddy/mcp.json", () => {
    const original = '{\n  "mcpServers": {}\n}\n';
    const parsed = parseClientConfiguration(original, "json");
    const updated = withClientServers(parsed, {
      [PRODUCT_IDENTITY.mcpServerKey]: {
        command: "/opt/rea/bin/rea",
        args: ["mcp"],
      },
    });
    const serialized = serializeClientConfiguration(updated, "json", original);
    const reparsed = parseClientConfiguration(serialized, "json");
    expect(
      effectiveClientServer(reparsed, PRODUCT_IDENTITY.mcpServerKey),
    ).toEqual({
      command: "/opt/rea/bin/rea",
      args: ["mcp"],
    });
  });
});
