import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

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

it("uses exact or unambiguous manifest identities when a package has no index", () => {
  // These canonically equivalent names cannot coexist on every filesystem.
  const files = new Map([
    [
      "main.cjs",
      'require("./café"); require("./résumé"); require("./réservé");',
    ],
    ["cafe\u0301/package.json", '{"main":"entry.js"}'],
    ["cafe\u0301/entry.js", "module.exports = 1;"],
    ["résumé/package.json", '{"main":"exact.js"}'],
    ["résumé/exact.js", "module.exports = 2;"],
    ["re\u0301sume\u0301/package.json", '{"main":"equivalent.js"}'],
    ["re\u0301sume\u0301/equivalent.js", "module.exports = 3;"],
    ["re\u0301servé/package.json", '{"main":"entry.js"}'],
    ["réserve\u0301/package.json", '{"main":"other.js"}'],
    ["réserve\u0301/other.js", "module.exports = 5;"],
    ["re\u0301servé/entry.js", "module.exports = 4;"],
  ]);
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [...files].map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: [...files.values()].reduce(
      (sum, content) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set(files.keys()));
  expect(
    parsed.relationships.map(({ to, resolution }) => ({ to, resolution })),
  ).toEqual([
    { to: "cafe\u0301/entry.js", resolution: "internal" },
    { to: "résumé/exact.js", resolution: "internal" },
    { to: "réservé", resolution: "unresolved" },
  ]);
  expect(parsed.parseFailures).toEqual([]);
});

it.each([
  ["exact unreadable", "résumé", "re\u0301sume\u0301"],
  ["ambiguous observed", "re\u0301sumé", "résume\u0301"],
] as const)(
  "keeps an %s manifest identity unknown",
  (_name, unreadable, readable) => {
    const files = new Map([
      ["main.cjs", 'require("./résumé");'],
      [`${readable}/package.json`, '{"main":"entry.js"}'],
      [`${readable}/entry.js`, "module.exports = 1;"],
    ]);
    const read: ReferenceSourceRead = {
      root: "/selected/source",
      entries: [
        ...[...files].map(([path, content]) => ({
          status: "read" as const,
          kind: "file" as const,
          path,
          bytes: Buffer.from(content),
          size: Buffer.byteLength(content),
        })),
        {
          status: "failed",
          kind: "file",
          path: `${unreadable}/package.json`,
          code: "io",
          message: "Manifest could not be read",
        },
      ],
      bytesRead: [...files.values()].reduce(
        (sum, content) => sum + Buffer.byteLength(content),
        0,
      ),
      limitations: [],
    };
    const parsed = parseReferenceSourceEntries(read, new Set(files.keys()));
    expect(parsed.relationships).toEqual([
      {
        from_path: "main.cjs",
        to: "résumé",
        kind: "requires",
        resolution: "unresolved",
        parse_state: "parsed",
      },
    ]);
    expect(parsed.entries).toContainEqual(
      expect.objectContaining({
        path: `${unreadable}/package.json`,
        content_state: "unreadable",
        sha256: null,
      }),
    );
  },
);
