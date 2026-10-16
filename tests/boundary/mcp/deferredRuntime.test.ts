import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../fixtures/mcpToolCatalog.js";
import { PROMPT_CONTRACTS } from "../../../src/contracts/promptContracts.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

const connect = async (
  mode: "legacy" | "auto",
  environment: Record<string, string> = {},
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      REA_LOG_LEVEL: "silent",
      ...environment,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (value) => {
    stderr += value;
  });
  const client = new Client(
    { name: "deferred-runtime-boundary", version: "1" },
    { versionNegotiation: { mode } },
  );
  onTestFinished(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
};

it.each(["legacy", "auto"] as const)(
  "serves the compiled discovery and canonical handlers over %s negotiation",
  async (mode) => {
    const recorded = JSON.parse(
      await readFile("dist/mcp-catalog.json", "utf8"),
    );
    const { client, stderr } = await connect(mode);
    const before = await client.listTools();
    expect(before.tools).toEqual(recorded.tools);
    const contractProjection = (tool: {
      name: string;
      title?: string | undefined;
      description?: string | undefined;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
    }) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    });
    expect(
      new Map(
        before.tools.map((tool) => [tool.name, contractProjection(tool)]),
      ),
    ).toEqual(
      new Map(
        GENERATED_MCP_TOOL_CATALOG.map((tool) => [
          tool.name,
          contractProjection(tool),
        ]),
      ),
    );
    expect((await client.listPrompts()).prompts).toEqual(
      PROMPT_CONTRACTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: Object.entries(prompt.arguments).map(([name, argument]) => ({
          name,
          description: argument.description,
          required: argument.required,
        })),
      })),
    );

    expect((await client.listPrompts()).prompts).toEqual(
      recorded.prompts.map(
        ({ parameters: _parameters, ...prompt }: Record<string, unknown>) =>
          prompt,
      ),
    );
    const results = await Promise.all([
      client.callTool({ name: "list_unknowns", arguments: {} }),
      client.callTool({ name: "list_unknowns", arguments: { limit: 1 } }),
    ]);
    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(results[0]?.structuredContent).toEqual({
      result: { items: [], total: 0, offset: 0, next_offset: null },
    });
    expect(await client.listTools()).toEqual(before);
    const invalid = await client.callTool({
      name: "list_unknowns",
      arguments: { limit: 1.5 },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid._meta?.provenance).toEqual({
      untrusted_content: true,
      source: "analysis_target",
    });
    expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
    if (mode === "auto")
      expect(invalid._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual(
        recorded.info,
      );
    expect(stderr()).toBe("");
  },
);

it.each([
  { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
  { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" },
])("preserves the configured catalog profile %j", async (environment) => {
  const { client } = await connect("legacy", environment);
  const before = await client.listTools();
  const catalog = JSON.parse(await readFile("dist/mcp-catalog.json", "utf8"));
  expect(before.tools).toHaveLength(catalog.tools.length);
  if (environment.REA_MCP_OUTPUT_SCHEMA_PROFILE === "off")
    expect(before.tools.every((tool) => tool.outputSchema === undefined)).toBe(
      true,
    );
  const result = await client.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(result.isError).not.toBe(true);
});

it("runs the real static artifact workflow after deferred initialization", async () => {
  const { client } = await connect("legacy");
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: resolve("scripts/rea.mjs") },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: { detail: "summary" },
  });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const evidence = evidenceSchema.parse(inspected.structuredContent);
  expect(evidence.operation).toBe("inspect_analysis_view");
  const view = analysisViewResultSchema.parse(evidence.normalized_result);
  expect(view.parent_operation).toBe("inspect_artifact");
  const retained = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  const closed = await client.callTool({ name: "close_binary", arguments: {} });
  expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
});

it("rejects a corrupted build-owned catalog before starting the connection", async () => {
  const directory = await createTestTempDirectory("rea-corrupted-mcp-catalog-");
  await cp(resolve("dist"), join(directory, "dist"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await cp(resolve("scripts/rea.mjs"), join(directory, "scripts/rea.mjs"));
  await cp(resolve("package.json"), join(directory, "package.json"));
  await symlink(
    resolve("node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  await writeFile(join(directory, "dist/mcp-catalog.json"), "{}");
  const child = spawnSync(
    process.execPath,
    [join(directory, "scripts/rea.mjs"), "mcp"],
    { cwd: directory, input: "", encoding: "utf8", timeout: 10000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    "REA could not start. Run `rea doctor`, then restart REA from your MCP client.\n",
  );
});
