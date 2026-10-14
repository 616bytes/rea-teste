import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

const sourceRead = (
  files: readonly (readonly [string, string])[],
): ReferenceSourceRead => ({
  root: "/selected/source",
  entries: files.map(([path, content]) => ({
    status: "read",
    kind: "file",
    path,
    bytes: Buffer.from(content),
    size: Buffer.byteLength(content),
  })),
  bytesRead: files.reduce(
    (sum, [, content]) => sum + Buffer.byteLength(content),
    0,
  ),
  limitations: [],
});

const parseSourceFiles = (
  files: readonly (readonly [string, string])[],
): ReturnType<typeof parseReferenceSourceEntries> =>
  parseReferenceSourceEntries(
    sourceRead(files),
    new Set(files.map(([path]) => path)),
  );

it("projects an unsupported non-regular entry as unknown kind instead of file", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "other",
        path: "src/pipe",
        code: "unsupported",
        message: "Entry is not a regular file",
        size: 0,
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/pipe",
    kind: "unknown",
    classifications: ["unknown"],
    limitations: [
      "Entry is not a regular file Exclude this entry or replace it with a regular file.",
    ],
  });
  expect(parsed.entries.some((entry) => entry.kind === "file")).toBe(false);
});

it("keeps a failed regular file as file kind", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "file",
        path: "src/broken.ts",
        code: "io",
        message: "Entry could not be read",
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/broken.ts",
    kind: "file",
    sha256: null,
    size: null,
    language: null,
    classifications: ["source"],
    content_state: "unreadable",
    limitations: [
      "Entry could not be read This file could not be read. Check its permissions, then try again.",
    ],
  });
});

it("prefers a sibling file over an extensionless directory index", () => {
  const parsed = parseSourceFiles([
    ["main.cjs", 'require("./dep");\n'],
    ["dep.js", 'module.exports = "sibling file";\n'],
    ["dep/index", 'module.exports = "extensionless index";\n'],
  ]);
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "dep.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
});

it("keeps a directory index ahead of a source-only sibling extension", () => {
  const parsed = parseSourceFiles([
    ["main.cjs", 'require("./dep");\n'],
    ["dep.cjs", 'module.exports = "source-only sibling";\n'],
    ["dep/index.js", 'module.exports = "directory index";\n'],
  ]);
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "dep/index.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
});

it("resolves a directory spelling to its JavaScript index", () => {
  const parsed = parseSourceFiles([
    ["main.cjs", 'require("./dep/");\n'],
    ["dep/index.js", 'module.exports = "directory index";\n'],
  ]);
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "dep/index.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
});

it("retains Kotlin source identity and language across the inventory projection", () => {
  const files = [
    [
      "MainActivity.kt",
      "import android.app.Activity\nclass MainActivity : Activity()\n",
      ["source"],
      "Kotlin",
    ],
    ["task.kts", 'println("hello")\n', ["source"], "Kotlin"],
    [
      "build.gradle.kts",
      'plugins { kotlin("jvm") version "2.3.0" }\n',
      ["manifest", "source"],
      "Kotlin",
    ],
    ["MainActivity.kt.backup", "backup\n", ["unknown"], null],
    ["Legacy.java", "class Legacy {}\n", ["source"], "Java"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );
  for (const [path, content, classifications, language] of files)
    expect(parsed.entries).toContainEqual({
      path,
      kind: "file",
      language,
      classifications,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      content_state: "hashed",
      limitations: [],
    });
  expect(historicalSourceLanguages(parsed.entries)).toEqual(["Java", "Kotlin"]);
  expect(parsed.parseFailures).toEqual([]);
  expect(parsed.relationships).toEqual([]);
});
