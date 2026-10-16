import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("resolves dynamic source imports while retaining computed targets as unknown", async () => {
  const root = await createTestTempDirectory("rea-reference-dynamic-import-");
  await Promise.all([
    writeFile(
      join(root, "main.ts"),
      [
        'import "./static";',
        'require("./common");',
        'const lazy = import("./lazy");',
        'async function load() { return await import("./data.json", { with: { type: "json" } }); }',
        'const name = "./not-guessed.js"; import(name);',
        "import(`./${name}.js`);",
        'import("node:fs");',
      ].join("\n"),
    ),
    ...["static.ts", "common.js", "lazy.ts"].map((path) =>
      writeFile(join(root, path), "export {};\n"),
    ),
    writeFile(join(root, "data.json"), '{"value":1}\n'),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-dynamic-import-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(6);
  for (const [to, kind] of [
    ["static.ts", "imports"],
    ["common.js", "requires"],
    ["lazy.ts", "imports"],
    ["data.json", "imports"],
  ])
    expect(result.value.relationships).toContainEqual({
      from_path: "main.ts",
      to,
      kind,
      resolution: "internal",
      parse_state: "parsed",
    });
  expect(result.value.relationships).toContainEqual({
    from_path: "main.ts",
    to: "<dynamic-import>",
    kind: "imports",
    resolution: "unknown",
    parse_state: "partial",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "main.ts",
    to: "node:fs",
    kind: "imports",
    resolution: "external",
    parse_state: "parsed",
  });
});

it("loads an extensionless JSON target only through CommonJS require", async () => {
  const root = await createTestTempDirectory("rea-reference-json-require-");
  await Promise.all([
    writeFile(join(root, "main.cjs"), 'require("./data");\n'),
    writeFile(join(root, "main.mjs"), 'import "./data";\n'),
    writeFile(join(root, "data.json"), '{"value":1}\n'),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-json-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  // ESM, unlike the CommonJS loader, requires the explicit `.json` extension.
  expect(result.value.relationships).toEqual([
    {
      from_path: "main.cjs",
      to: "data.json",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "main.mjs",
      to: "data",
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    },
  ]);
  expect(
    result.value.entries.map((entry) => [
      entry.path,
      "content_state" in entry ? entry.content_state : null,
    ]),
  ).toEqual([
    ["data.json", "hashed"],
    ["main.cjs", "hashed"],
    ["main.mjs", "hashed"],
  ]);
});

it("resolves percent-escaped ESM filenames once without changing CommonJS paths", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-escaped-");
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      [
        'import "./dep%20name.mjs";',
        'import "./dep%2520name.mjs";',
        'import "./caf%C3%A9.mjs";',
        'import "./missing%20name.mjs";',
      ].join("\n"),
    ),
    writeFile(join(root, "main.cjs"), 'require("./dep%20name.mjs");\n'),
    ...[
      "dep name.mjs",
      "dep%20name.mjs",
      "dep%2520name.mjs",
      "café.mjs",
      "missing%20name.mjs",
    ].map((path) => writeFile(join(root, path), "export {};\n")),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-escaped-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(5);
  for (const relationship of [
    {
      from_path: "main.cjs",
      to: "dep%20name.mjs",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    ...[
      ["dep name.mjs", "internal"],
      ["dep%20name.mjs", "internal"],
      ["café.mjs", "internal"],
      ["missing name.mjs", "unresolved"],
    ].map(([to, resolution]) => ({
      from_path: "main.mjs",
      to,
      kind: "imports",
      resolution,
      parse_state: "parsed",
    })),
  ])
    expect(result.value.relationships).toContainEqual(relationship);
  const entryPaths = result.value.entries.map(({ path }) => path);
  expect(entryPaths).toHaveLength(7);
  for (const path of [
    "café.mjs",
    "dep name.mjs",
    "dep%20name.mjs",
    "dep%2520name.mjs",
    "main.cjs",
    "main.mjs",
    "missing%20name.mjs",
  ])
    expect(entryPaths).toContain(path);
});

it("does not map invalid ESM URL pathnames to literal percent filenames", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-invalid-");
  const filenames = ["bad%zz.mjs", "slash%2fname.mjs", "nul%00name.mjs"];
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      filenames.map((name) => `import "./${name}";`).join("\n"),
    ),
    ...filenames.map((name) => writeFile(join(root, name), "export {};\n")),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-invalid-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(filenames.length);
  for (const name of filenames)
    expect(result.value.relationships).toContainEqual({
      from_path: "main.mjs",
      to: `./${name}`,
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    });
});

it.skipIf(process.platform === "win32")(
  "decodes an escaped backslash as a POSIX filename byte",
  async () => {
    const root = await createTestTempDirectory("rea-reference-esm-backslash-");
    await Promise.all([
      writeFile(join(root, "main.mjs"), 'import "./backslash%5cname.mjs";\n'),
      writeFile(join(root, "backslash\\name.mjs"), "export {};\n"),
      writeFile(join(root, "backslash%5cname.mjs"), "export {};\n"),
    ]);

    const result = await importReferenceSource({
      root,
      caller: "reference-esm-backslash-test",
      policy: { secretPatterns: [] },
    });
    if (!result.ok) throw result.error;
    expect(result.value.parse_failures).toEqual([]);
    expect(result.value.relationships).toContainEqual({
      from_path: "main.mjs",
      to: "backslash\\name.mjs",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    });
  },
);

it("keeps TypeScript source imports as literal percent filenames", async () => {
  const root = await createTestTempDirectory("rea-reference-ts-percent-");
  await Promise.all([
    writeFile(join(root, "main.ts"), 'import "./dep%20name.js";\n'),
    writeFile(join(root, "main.mts"), 'import "./dep%20name.mjs";\n'),
    ...["ts", "mts"].flatMap((extension) =>
      ["dep name", "dep%20name"].map((name) =>
        writeFile(join(root, `${name}.${extension}`), "export {};\n"),
      ),
    ),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-ts-percent-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(2);
  for (const [from_path, to] of [
    ["main.ts", "dep%20name.ts"],
    ["main.mts", "dep%20name.mts"],
  ])
    expect(result.value.relationships).toContainEqual({
      from_path,
      to,
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    });
});
