import { expect, onTestFinished } from "vitest";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { workspaceCliTest as cliTest } from "../../support/cli/workspaceCliFixture.js";

cliTest(
  "reports declared WebMCP fields rather than schema keywords",
  async ({ cli, workspace }) => {
    const scriptSource = `
    document.modelContext.registerTool({
      name: "empty", inputSchema: { type: "object" }
    });
    document.modelContext.registerTool({
      name: "dynamic", inputSchema: { type: "object", properties: fields }
    });
    document.modelContext.registerTool({
      name: "literal", inputSchema: {
        type: "object", properties: { actual: { type: "string" } }
      }
    });
  `;
    const browser = await startFakeCdpBrowser({
      commandResult: (command) =>
        command.method === "Debugger.getScriptSource"
          ? { scriptSource }
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await cli.run({
      arguments: [
        "analyze-web-bundle",
        browser.endpoint,
        "allowed-page",
        "--allowed-origins",
        browser.allowedOrigin,
        "--observation-ms",
        "0",
        "--json",
      ],
      cwd: workspace.root,
      environment: workspace.environment,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      operation: "analyze_web_bundle",
      normalized_result: {
        observations: {
          webmcp_declarations: [
            {
              name: "empty",
              schema_property_names: [],
              trust: "page-declared-untrusted",
            },
            {
              name: "dynamic",
              schema_property_names: [],
              trust: "page-declared-untrusted",
            },
            {
              name: "literal",
              schema_property_names: ["actual"],
              trust: "page-declared-untrusted",
            },
          ],
        },
      },
    });
  },
);
