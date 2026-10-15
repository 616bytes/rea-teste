import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { text } from "node:stream/consumers";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { withArtifactClient } from "../../support/artifactClientScope.js";

it.each(["", "./", "././"])(
  "inventories and extracts ZIP members with leading directory prefix %j",
  async (prefix) => {
    const root = await createTestTempDirectory("rea-zip-relative-root-");
    const path = join(root, "sample.zip");
    await writeOrderedZip(path, [
      ...(prefix === "" ? [] : [prefix]),
      `${prefix}sub/`,
      `${prefix}sub/data.txt`,
    ]);
    const inventory = await inventoryArtifact(path);
    expect(inventory.occurrences.map((entry) => entry.logical_path)).toEqual([
      ".",
      "sub",
      "sub/data.txt",
    ]);
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "sub/data.txt",
        hash_status: "verified",
      }),
    );
    if (prefix !== "")
      expect(
        inventory.occurrences.find(
          (entry) => entry.logical_path === "sub/data.txt",
        )?.limitations,
      ).toContain(
        `ZIP member name ${JSON.stringify(`${prefix}sub/data.txt`)} has a leading current-directory prefix omitted from its logical path.`,
      );
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    const output = join(root, "output");
    const result = await withArtifactClient(target.value, (client) =>
      client.execute("extract_artifact", { output_root: output }),
    );
    if (!result.ok) throw result.error;
    const extracted = artifactExtractionResultSchema.parse(result.value.result);
    expect(extracted.artifacts.map((entry) => entry.relative_path)).toEqual([
      "sub/data.txt",
    ]);
    expect(await readFile(join(output, "sub", "data.txt"), "utf8")).toBe(
      "evidence\n",
    );
  },
);

it("treats a ZIP containing only its root directory as an empty artifact", async () => {
  const root = await createTestTempDirectory("rea-zip-root-only-");
  const path = join(root, "empty.zip");
  await writeOrderedZip(path, ["./"]);
  const inventory = await inventoryArtifact(path);
  expect(inventory.occurrences.map((entry) => entry.logical_path)).toEqual([
    ".",
  ]);
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const result = await withArtifactClient(target.value, (client) =>
    client.execute("extract_artifact", { output_root: join(root, "output") }),
  );
  if (!result.ok) throw result.error;
  expect(
    artifactExtractionResultSchema.parse(result.value.result).artifacts,
  ).toEqual([]);
});

it("keeps distinct ZIP members after their leading prefixes are interpreted", async () => {
  const root = await createTestTempDirectory("rea-zip-relative-identity-");
  const path = join(root, "duplicates.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("./", undefined, { directory: true });
  await writer.add("./data.txt", new TextReader("first"));
  await writer.add("data.txt", new TextReader("second"));
  await writeFile(path, await writer.close());
  const reader = new ZipArtifactReader(path, "zip");
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const observed = [];
      for await (const entry of reader.entries())
        observed.push({
          path: entry.path,
          key: entry.adapterKey,
          body: await text(await reader.open(entry)),
        });
      expect(observed).toEqual([
        { path: "data.txt", key: "zip-entry:1", body: "first" },
        { path: "data.txt", key: "zip-entry:2", body: "second" },
      ]);
    }
  } finally {
    await reader.close();
  }
  const inventory = await inventoryArtifact(path);
  const files = inventory.occurrences.filter(
    (entry) => entry.logical_path === "data.txt",
  );
  expect(files).toHaveLength(2);
  expect(new Set(files.map((entry) => entry.occurrence_id)).size).toBe(2);
  expect(new Set(files.map((entry) => entry.artifact_id)).size).toBe(2);
});
