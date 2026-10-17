import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseGhidraLanguageDefinitions,
  readGhidraLanguageCatalog,
} from "./GhidraLanguageCatalog.js";

describe("parseGhidraLanguageDefinitions", () => {
  it("parses valid language definitions with their compiler specifications", () => {
    const xml = `
      <language_definitions>
        <language id="toy:LE:32:default">
          <description>Toy 32-bit LE</description>
          <compiler id="default" name="Default"/>
          <compiler id="gcc" name="GCC"/>
        </language>
      </language_definitions>
    `;
    expect(parseGhidraLanguageDefinitions(xml)).toEqual([
      { id: "toy:LE:32:default", compilerSpecIds: ["default", "gcc"] },
    ]);
  });

  it("preserves language definitions when description contains literal U+FFFD", () => {
    const xml = `
      <language_definitions>
        <language id="toy:LE:32:default" description="\uFFFD">
          <compiler id="default"/>
        </language>
      </language_definitions>
    `;
    expect(parseGhidraLanguageDefinitions(xml)).toEqual([
      { id: "toy:LE:32:default", compilerSpecIds: ["default"] },
    ]);
  });

  it("still rejects malformed XML even when U+FFFD is present", () => {
    const malformed = `
      <language_definitions>
        <language id="toy:LE:32:default" description="\uFFFD"
    `;
    expect(() => parseGhidraLanguageDefinitions(malformed)).toThrow();
  });

  it("rejects an unexpected root element", () => {
    expect(() =>
      parseGhidraLanguageDefinitions("<unexpected_root/>"),
    ).toThrowError(
      new SyntaxError("Expected Ghidra language_definitions XML root"),
    );
  });
});

describe("readGhidraLanguageCatalog", () => {
  it("reads language definitions containing literal U+FFFD", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rea-ghidra-catalog-test-"));
    try {
      const languages = join(tempDir, "Ghidra/Processors/toy/data/languages");
      await mkdir(languages, { recursive: true });
      await writeFile(
        join(languages, "toy.ldefs"),
        '<language_definitions><language id="toy:LE:32:default" description="\uFFFD"><compiler id="default"/></language></language_definitions>',
      );

      const definitions = await readGhidraLanguageCatalog(tempDir);
      expect(definitions).toEqual([
        { id: "toy:LE:32:default", compilerSpecIds: ["default"] },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("strips UTF-8 BOM before parsing definitions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rea-ghidra-catalog-bom-"));
    try {
      const languages = join(tempDir, "Ghidra/Processors/toy/data/languages");
      await mkdir(languages, { recursive: true });
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const content = Buffer.from(
        '<language_definitions><language id="toy:LE:32:default"><compiler id="default"/></language></language_definitions>',
      );
      await writeFile(
        join(languages, "toy.ldefs"),
        Buffer.concat([bom, content]),
      );

      const definitions = await readGhidraLanguageCatalog(tempDir);
      expect(definitions).toEqual([
        { id: "toy:LE:32:default", compilerSpecIds: ["default"] },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses malformed UTF-8 bytes in language definition files", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "rea-ghidra-catalog-invalid-utf8-"),
    );
    try {
      const languages = join(tempDir, "Ghidra/Processors/toy/data/languages");
      await mkdir(languages, { recursive: true });
      await writeFile(
        join(languages, "toy.ldefs"),
        Buffer.concat([
          Buffer.from(
            '<language_definitions><language id="toy:LE:32:default" description="',
          ),
          Buffer.from([0xff]),
          Buffer.from('"/></language_definitions>'),
        ]),
      );

      await expect(readGhidraLanguageCatalog(tempDir)).rejects.toThrow(
        TypeError,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
