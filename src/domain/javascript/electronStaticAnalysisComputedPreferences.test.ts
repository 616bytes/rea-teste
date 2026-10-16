import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("computed Electron web preference keys", () => {
  it("retains exact string, numeric, and empty literal keys", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      new BrowserWindow({ webPreferences: {
        ["sandbox"]: true,
        ["preload"]: "./preload.js",
        [1]: "numeric",
        [""]: false
      } });
    `);

    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.browser_windows[0]).toMatchObject({
      preload_path: "./preload.js",
      web_preferences: [
        { name: "", value: { status: "literal", value: false } },
        { name: "1", value: { status: "literal", value: "numeric" } },
        {
          name: "preload",
          value: { status: "literal", value: "./preload.js" },
        },
        { name: "sandbox", value: { status: "literal", value: true } },
      ],
    });
  });

  it("keeps genuinely dynamic computed keys unknown", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      new BrowserWindow({ webPreferences: {
        [getKey()]: true,
        ["sandbox"]: true
      } });
    `);

    expect(analysis.parse_status).toBe("partial");
    expect(analysis.electron.browser_windows[0]?.web_preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringMatching(/^\[dynamic@/u),
          value: expect.objectContaining({ status: "dynamic" }),
        }),
        {
          name: "sandbox",
          value: { status: "literal", value: true, expression: null },
        },
      ]),
    );
  });

  it("keeps preload and service identity after unrelated empty template keys", () => {
    const analysis = analyzeJavaScriptStaticSource(
      [
        'const { BrowserWindow, utilityProcess } = require("electron");',
        'new BrowserWindow({ webPreferences: { preload: "./kept.js", [``]: true }, [``]: null });',
        'utilityProcess.fork("./worker.js", [], { serviceName: "kept", [``]: null });',
      ].join("\n"),
    );

    expect(analysis.electron.browser_windows[0]).toMatchObject({
      preload_path: "./kept.js",
      web_preferences_status: "object-literal",
    });
    expect(analysis.electron.utility_processes[0]?.service_name).toBe("kept");
  });
});
