import { expect } from "vitest";

import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "static WebMCP declarations require an exact receiver segment",
  async ({ cli }) => {
    const source = `
    document.modelContext.registerTool({ name: "document" });
    navigator.modelContext.registerTool({ name: "navigator" });
    modelContext.registerTool({ name: "bare" });
    local.modelContext.registerTool({ name: "nested" });
    foobar_modelContext.registerTool({ name: "suffix" });
    local.foobar_modelContext.registerTool({ name: "nested suffix" });
    renamed.registerTool({ name: "renamed" });
    document.modelContext[method]({ name: "dynamic" });
  `;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? { scriptSource: source }
          : undefined,
    });
    try {
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
      });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.json).toMatchObject({
        normalized_result: {
          observations: {
            webmcp_declarations: [
              "document",
              "navigator",
              "bare",
              "nested",
            ].map((name) => ({ name, trust: "page-declared-untrusted" })),
          },
        },
      });
      const inspected = await cli.run({
        arguments: [
          "inspect-web-page",
          browser.endpoint,
          "allowed-page",
          "--allowed-origins",
          browser.allowedOrigin,
          "--observation-ms",
          "0",
          "--include-script-sources",
          "--json",
        ],
      });
      expect(inspected.exitCode, inspected.stdout).toBe(0);
      expect(inspected.json).toMatchObject({
        normalized_result: {
          scripts: {
            items: expect.arrayContaining([
              expect.objectContaining({
                source: expect.objectContaining({
                  artifact: expect.objectContaining({ text: source }),
                }),
              }),
            ]),
          },
        },
      });
      expect(browser.activeConnectionCount()).toBe(0);
    } finally {
      await browser.close();
    }
  },
);
