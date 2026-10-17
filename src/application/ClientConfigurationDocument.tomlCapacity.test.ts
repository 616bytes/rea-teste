import { describe, expect, it } from "vitest";

import {
  parseClientConfiguration,
  serializeClientConfiguration,
} from "./ClientConfigurationDocument.js";

describe("serializeClientConfiguration TOML large document capacity", () => {
  it("preserves a TOML document with 70,000 blank lines without call stack overflow", () => {
    const emptyLines = "\n".repeat(70_000);
    const original = `model = "placeholder-local-control"${emptyLines}[mcp_servers.other]\ncommand = "other-local-control"\n`;

    const parsed = parseClientConfiguration(original, "toml");
    const updated = {
      ...parsed.document,
      mcp_servers: {
        ...parsed.servers,
        rea: { command: "rea", args: ["mcp"] },
      },
    };

    const serialized = serializeClientConfiguration(updated, "toml", original);
    expect(serialized).toContain('model = "placeholder-local-control"');
    expect(serialized).toContain("[mcp_servers.other]");
    expect(serialized).toContain("[mcp_servers.rea]");
    const reparsed = parseClientConfiguration(serialized, "toml");
    expect(reparsed.servers).toMatchObject({
      other: { command: "other-local-control" },
      rea: { command: "rea", args: ["mcp"] },
    });
  });

  it("preserves a Grok document with 70,000 comments without call stack overflow", () => {
    const comments = "# comment\n".repeat(70_000);
    const original = `model = "placeholder-local-control"\n${comments}[mcp_servers.other]\ncommand = "other-local-control"\n`;

    const parsed = parseClientConfiguration(original, "grok");
    const updated = {
      ...parsed.document,
      mcp_servers: {
        ...parsed.servers,
        rea: { command: "rea", args: ["mcp"] },
      },
    };

    const serialized = serializeClientConfiguration(updated, "grok", original);
    expect(serialized).toContain('model = "placeholder-local-control"');
    expect(serialized).toContain("[mcp_servers.other]");
    expect(serialized).toContain("[mcp_servers.rea]");
    const reparsed = parseClientConfiguration(serialized, "grok");
    expect(reparsed.servers).toMatchObject({
      other: { command: "other-local-control" },
      rea: { command: "rea", args: ["mcp"] },
    });
  });
});
