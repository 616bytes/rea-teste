import { describe, expect, it } from "vitest";

import {
  parseClientConfiguration,
  serializeClientConfiguration,
} from "./ClientConfigurationDocument.js";

describe("Claude Code configuration admission and serialization", () => {
  it("rejects single-line comments in .claude.json with SyntaxError", () => {
    const fixture = `{
  // preserve this unrelated setting
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}`;
    expect(() => parseClientConfiguration(fixture, "claude_code")).toThrow(
      SyntaxError,
    );
  });

  it("rejects block comments in .claude.json with SyntaxError", () => {
    const fixture = `{
  /* preserve this unrelated setting */
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}`;
    expect(() => parseClientConfiguration(fixture, "claude_code")).toThrow(
      SyntaxError,
    );
  });

  it("rejects trailing commas in .claude.json with SyntaxError", () => {
    const fixture = `{
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] },
  }
}`;
    expect(() => parseClientConfiguration(fixture, "claude_code")).toThrow(
      SyntaxError,
    );
  });

  it("rejects BOM-prefixed comments in .claude.json with SyntaxError", () => {
    const fixture = `\uFEFF{
  // comment
  "mcpServers": {}
}`;
    expect(() => parseClientConfiguration(fixture, "claude_code")).toThrow(
      SyntaxError,
    );
  });

  it("rejects BOM-prefixed trailing commas in .claude.json with SyntaxError", () => {
    const fixture = `\uFEFF{
  "mcpServers": {},
}`;
    expect(() => parseClientConfiguration(fixture, "claude_code")).toThrow(
      SyntaxError,
    );
  });

  it("accepts valid plain JSON in .claude.json", () => {
    const fixture = `{
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}`;
    const parsed = parseClientConfiguration(fixture, "claude_code");
    expect(parsed.servers).toEqual({
      peer: { command: "/usr/bin/true", args: [] },
    });
  });

  it("accepts valid BOM-prefixed plain JSON in .claude.json", () => {
    const fixture = `\uFEFF{
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] }
  }
}`;
    const parsed = parseClientConfiguration(fixture, "claude_code");
    expect(parsed.servers).toEqual({
      peer: { command: "/usr/bin/true", args: [] },
    });
  });

  it("accepts an empty .claude.json file as an empty configuration", () => {
    expect(parseClientConfiguration("", "claude_code").document).toEqual({});
    expect(parseClientConfiguration("   ", "claude_code").document).toEqual({});
    expect(parseClientConfiguration("\uFEFF", "claude_code").document).toEqual(
      {},
    );
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"not-an-object"'],
  ])("rejects non-object root for claude_code (%s)", (_label, value) => {
    expect(() => parseClientConfiguration(value, "claude_code")).toThrow(
      TypeError,
    );
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"not-an-object"'],
  ])("rejects non-object mcpServers for claude_code (%s)", (_label, value) => {
    expect(() =>
      parseClientConfiguration(`{"mcpServers": ${value}}`, "claude_code"),
    ).toThrow(TypeError);
  });

  it("preserves JSONC comment and trailing comma admission for generic JSON clients (such as Cursor)", () => {
    const fixture = `{
  // preserve comment in jsonc
  "mcpServers": {
    "peer": { "command": "/usr/bin/true", "args": [] },
  },
}`;
    const parsed = parseClientConfiguration(fixture, "json");
    expect(parsed.servers).toEqual({
      peer: { command: "/usr/bin/true", args: [] },
    });
  });

  it("serializes updated Claude Code configuration preserving valid JSON settings", () => {
    const original = `{\n  "unrelated": "setting",\n  "mcpServers": {\n    "other": {\n      "command": "other"\n    }\n  }\n}\n`;
    const parsed = parseClientConfiguration(original, "claude_code");
    const updated = {
      ...parsed.document,
      mcpServers: {
        ...parsed.servers,
        rea: { command: "rea", args: ["mcp"] },
      },
    };
    const serialized = serializeClientConfiguration(
      updated,
      "claude_code",
      original,
      [["mcpServers", "rea"]],
    );
    expect(JSON.parse(serialized)).toEqual({
      unrelated: "setting",
      mcpServers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"] },
      },
    });
  });
});
