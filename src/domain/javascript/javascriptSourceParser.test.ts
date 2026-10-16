import { expect, it } from "vitest";
import * as t from "@babel/types";

import {
  parseJavaScriptSource,
  parseRecoveredJavaScript,
  parserPluginsForPath,
  hasProvenJavaScriptModuleContext,
} from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  ['import type {T} from "example";', "fixture.cts", false],
  ['import type {T} from "example";', "fixture.mts", true],
  ['import type {T} from "example";', "fixture.ts", false],
  ['export type {T} from "example";', "fixture.ts", false],
  ['import {type T} from "example";', "fixture.ts", false],
  ['export {type T} from "example";', "fixture.ts", false],
  ["export declare const value: unknown;", "fixture.ts", false],
  ['import {} from "example";', "fixture.js", true],
  ['import {} from "example";', "fixture.cjs", false],
  ["export {};", "fixture.ts", true],
  ["const value = 1;", "fixture.mjs", true],
  ["const value = 1;", "fixture.js", false],
] as const)(
  "keeps runtime module proof consistent across parser entries: %s (%s)",
  (source, path, module) => {
    const parsed = parseJavaScriptSource(source, path);
    if (parsed === null) throw new Error("Expected parsed source");
    const recovered = parseRecoveredJavaScript(source, path, {
      plugins: parserPluginsForPath(path),
    }).file;
    expect(hasProvenJavaScriptModuleContext(parsed.program)).toBe(module);
    expect(hasProvenJavaScriptModuleContext(recovered.program)).toBe(module);
    expect(
      hasProvenJavaScriptModuleContext(t.cloneNode(parsed.program, true)),
    ).toBe(false);
  },
);

const analyze = (source: string, path: string) => {
  const parsed = parseJavaScriptSource(source, path);
  return parsed === null
    ? null
    : {
        errors: parsed.errors.length,
        facts: analyzeParsedJavaScriptStaticSource(source, parsed),
      };
};

it("parses conditional arrow bodies in JavaScript sources with JavaScript grammar", () => {
  // Bundlers emit this shape; TypeScript reads `):H=>` as a return type.
  const source = `const {ipcMain}=require("electron");
const pick=n===0?H=>({start:H.startY}):H=>({start:H.startX});
ipcMain.handle("layout:ready",()=>pick);`;
  for (const path of ["main.js", "main.cjs", "main.mjs", "main.jsx"]) {
    const result = analyze(source, path);
    expect(result?.errors).toBe(0);
    expect(result?.facts.electron.ipc).toContainEqual(
      expect.objectContaining({ channel: "layout:ready", operation: "handle" }),
    );
  }
});

it("keeps JavaScript comparison meaning for angle brackets in JavaScript sources", () => {
  const source = `const a=fetch<limit>("/api/compare");`;
  expect(analyze(source, "main.js")?.facts.endpoints).toEqual([]);
  expect(analyze(source, "main.ts")?.facts.endpoints).toContainEqual(
    expect.objectContaining({ value: "/api/compare" }),
  );
});

it("keeps TypeScript syntax available for TypeScript and unnamed sources", () => {
  const source = "let count: number = 1; export type Id = string;";
  expect(parseJavaScriptSource(source, "value.ts")?.errors).toEqual([]);
  expect(parseJavaScriptSource(source)?.errors).toEqual([]);
});
