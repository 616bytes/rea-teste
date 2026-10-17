import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { neExecutableSchema } from "../../../src/domain/native/neExecutable.js";
import { neFixture } from "../../../src/native/ne/NeExecutable.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const contract = toolContract("inspect_ne_executable");

cliTest(
  "inspects an NE image through compiled CLI and real stdio MCP without an active target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ne-acceptance-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "ne-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const inventory = await client.listTools();
      expect(inventory.tools).toContainEqual(
        expect.objectContaining({ name: contract.name }),
      );

      const fixture = neFixture();
      const path = join(root, "sample.dll");
      await writeFile(path, fixture.bytes);
      const result = await cli.run({
        arguments: ["inspect-ne-executable", path, "--json"],
      });
      expect(result.exitCode).toBe(0);
      const evidence = contract.outputSchema.parse(result.json);
      expect(evidence.subject).toMatchObject({
        format: "ne",
        digest: {
          sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
        },
      });
      const report = neExecutableSchema.parse(evidence.normalized_result);
      expect(report).toMatchObject({
        module_name: { name: "SAMPLE" },
        module_references: [{ name: "KERNEL" }, { name: "USER" }],
        coverage: { status: "complete", examined_rows: 13 },
      });

      const response = await client.callTool({
        name: contract.name,
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const mcp = contract.outputSchema.parse(response.structuredContent);
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
      expect(await readFile(path)).toEqual(fixture.bytes);

      const malformed = join(root, "malformed.dll");
      await writeFile(malformed, Buffer.from("not an NE image"));
      for (const [candidate, reason] of [
        [join(root, "missing.dll"), "invalid_value"],
        [malformed, "invalid_format"],
      ] as const) {
        const failed = await cli.run({
          arguments: ["inspect-ne-executable", candidate, "--json"],
        });
        expect(failed.exitCode).toBe(1);
        expect(failed.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation: "inspect_ne_executable",
            issues: [{ path: ["path"], reason }],
          },
        });
        const rejected = await client.callTool({
          name: contract.name,
          arguments: { path: candidate },
        });
        expect(rejected.isError).toBe(true);
        expect(parseMcpToolError(rejected)).toEqual({ error: failed.json });
      }

      for (const arguments_ of [
        { path, max_rows: 1 },
        { path: "relative.dll" },
        { path, extra: true },
      ]) {
        const rejected = await client.callTool({
          name: contract.name,
          arguments: arguments_,
        });
        expect(rejected.isError).toBe(true);
        expect(
          contract.outputSchema.safeParse(rejected.structuredContent).success,
        ).toBe(false);
      }
      await client.ping();
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
  30_000,
);
