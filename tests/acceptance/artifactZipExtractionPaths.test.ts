import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "refuses NFC-colliding ZIP members without an integrity retry",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-zip-collision-");
    const archive = join(root, "collision.zip");
    const temporary = join(root, "temporary");
    await mkdir(temporary);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("café.txt", new TextReader("first bytes"));
    await writer.add("cafe\u0301.txt", new TextReader("later bytes"));
    await writeFile(archive, await writer.close());

    for (const options of [[], ["--integrity-policy", "record-and-continue"]]) {
      const result = await cli.run({
        arguments: ["extract-artifact", archive, "--json", ...options],
        environment: { TMPDIR: temporary, TEMP: temporary, TMP: temporary },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "artifact_operation_failed",
        message: expect.stringContaining(
          'Artifact extraction path collision: "café.txt"',
        ),
        details: { operation: "extract_artifact", reason: "path" },
      });
      expect(result.stdout).not.toContain(
        "integrity_policy=record-and-continue",
      );
      expect(await readdir(temporary)).toEqual([]);
    }
  },
);

cliTest(
  "extracts distinct ZIP names and normalizes a single decomposed name",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-zip-distinct-");
    const archive = join(root, "distinct.zip");
    const temporary = join(root, "temporary");
    await mkdir(temporary);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("cafe\u0301.txt", new TextReader("decomposed bytes"));
    await writer.add("other.txt", new TextReader("distinct bytes"));
    await writeFile(archive, await writer.close());

    const result = await cli.run({
      arguments: ["extract-artifact", archive, "--json"],
      environment: { TMPDIR: temporary, TEMP: temporary, TMP: temporary },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const extraction = artifactExtractionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(
      extraction.artifacts.map(({ relative_path }) => relative_path),
    ).toEqual(["café.txt", "other.txt"]);
    expect(
      await readFile(join(extraction.output_root, "café.txt"), "utf8"),
    ).toBe("decomposed bytes");
    expect(
      await readFile(join(extraction.output_root, "other.txt"), "utf8"),
    ).toBe("distinct bytes");
  },
);
