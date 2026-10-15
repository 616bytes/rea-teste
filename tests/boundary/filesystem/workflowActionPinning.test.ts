import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const github = new URL("../../../.github/", import.meta.url);

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u;

/** Every `uses` value anywhere in a parsed workflow or composite action. */
const usesReferences = (node: unknown): readonly string[] => {
  if (Array.isArray(node)) return node.flatMap(usesReferences);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "uses" && typeof value === "string"
      ? [value]
      : usesReferences(value),
  );
};

/** External references that do not name a full commit SHA. */
const unpinnedReferences = (yamlText: string): readonly string[] =>
  usesReferences(parse(yamlText)).filter(
    (reference) =>
      !reference.startsWith("./") &&
      !reference.startsWith("docker://") &&
      !PINNED.test(reference),
  );

describe("unpinnedReferences", () => {
  const sha = "11d5960a326750d5838078e36cf38b85af677262";

  it("finds tag references in block, flow-style, and composite steps", () => {
    expect(
      unpinnedReferences(`
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - { uses: actions/setup-node@v4 }
runs:
  using: composite
  steps:
    - uses: "actions/cache@v4"
`),
    ).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/cache@v4",
    ]);
  });

  it("accepts quoted SHAs, local actions, reusable workflows, and docker images", () => {
    expect(
      unpinnedReferences(`
jobs:
  call:
    uses: ./.github/workflows/website-check.yml
  build:
    steps:
      - uses: "actions/checkout@${sha}" # v4.4.0
      - uses: './.github/actions/npm-cache'
      - uses: docker://alpine:3.20
`),
    ).toEqual([]);
  });
});

// A moved tag would change the code that runs with release-please, npm
// publish, and Cloudflare credentials, so external actions name a commit.
it("pins every external workflow action to a full commit SHA", async () => {
  const entries = await readdir(github, { recursive: true });
  const unpinned: string[] = [];
  for (const entry of entries.filter((name) => /\.ya?ml$/u.test(name))) {
    const file = new URL(entry.replaceAll("\\", "/"), github);
    for (const reference of unpinnedReferences(await readFile(file, "utf8")))
      unpinned.push(`${entry}: ${reference}`);
  }
  expect(unpinned).toEqual([]);
});
