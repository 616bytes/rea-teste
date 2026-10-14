import { createHash } from "node:crypto";
import { access, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { expect, it } from "vitest";

import { DotnetBundleArtifactReader } from "../../../src/artifacts/DotnetBundleArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { dotnetBundleFixture } from "../../../src/artifacts/dotnet/DotnetBundle.fixture.js";
import {
  findDotnetBundleHeader,
  readDotnetBundle,
  DOTNET_BUNDLE_SIGNATURE,
} from "../../../src/artifacts/dotnet/DotnetBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([1, 2, 6])(
  "inventories and extracts version %s with source and member identity",
  async (version) => {
    const root = await createTestTempDirectory("rea-dotnet-bundle-");
    const path = join(root, "renamed.bin");
    const plain = Buffer.from("assembly sample");
    const compressed = Buffer.from("resource content ".repeat(1000));
    const fixture = dotnetBundleFixture(
      [
        { path: "App.dll", bytes: plain, fileType: 1 },
        {
          path: "内容/data.txt",
          bytes: compressed,
          compressed: version === 6,
          fileType: 0,
        },
        { path: "empty.txt", bytes: Buffer.alloc(0), fileType: 255 },
      ],
      version,
    );
    await writeFile(path, fixture.bytes);
    const inventory = await inventoryArtifact(path, {
      resourceScope: new ArtifactResourceScope(),
    });
    expect(inventory.manifest.root_format).toBe("dotnet-bundle");
    expect(inventory.manifest.root_sha256).toBe(sha(fixture.bytes));
    const member = inventory.occurrences.find(
      (item) => item.logical_path === "内容/data.txt",
    );
    expect(member?.dotnet_bundle).toEqual({
      major_version: version,
      minor_version: 0,
      file_type: 0,
    });
    expect(member?.source_location?.length).toBe(
      version === 6 ? member?.compressed_size : compressed.length,
    );
    expect(
      inventory.nodes.find((node) => node.sha256 === sha(compressed))?.size,
    ).toBe(compressed.length);
    expect(
      inventory.occurrences
        .find((item) => item.logical_path === "empty.txt")
        ?.limitations.join(" "),
    ).toContain("Unknown .NET bundle file type 255");
    const outputRoot = join(root, "output");
    const result = await extractArtifact({
      inputPath: path,
      inputFormat: "pe",
      outputRoot,
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope: new ArtifactResourceScope(),
    });
    expect(result.containment_verified).toBe(true);
    expect(await readFile(join(outputRoot, "App.dll"))).toEqual(plain);
    expect(await readFile(join(outputRoot, "内容/data.txt"))).toEqual(
      compressed,
    );
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
);

it.each([
  [
    "traversal",
    () =>
      dotnetBundleFixture([{ path: "../escape", bytes: Buffer.from("x") }])
        .bytes,
    "path",
  ],
  [
    "overlap",
    () =>
      dotnetBundleFixture([
        { path: "one", bytes: Buffer.from("first") },
        { path: "two", bytes: Buffer.from("second"), declaredOffset: 1025 },
      ]).bytes,
    "format",
  ],
  ["truncated", () => dotnetBundleFixture().bytes.subarray(0, -2), "format"],
  [
    "unknown version",
    () => dotnetBundleFixture(undefined, 7).bytes,
    "unavailable",
  ],
  [
    "expanded budget",
    () =>
      dotnetBundleFixture([
        {
          path: "large",
          bytes: Buffer.from("x"),
          declaredSize: 600 * 1024 * 1024,
        },
      ]).bytes,
    "limit",
  ],
  [
    "false expanded size",
    () =>
      dotnetBundleFixture([
        {
          path: "compressed",
          bytes: Buffer.from("hello ".repeat(1000)),
          compressed: true,
          declaredSize: 3,
        },
      ]).bytes,
    "limit",
  ],
  [
    "short expanded size",
    () =>
      dotnetBundleFixture([
        {
          path: "compressed",
          bytes: Buffer.from("hello"),
          compressed: true,
          declaredSize: 6,
        },
      ]).bytes,
    "format",
  ],
  [
    "corrupt deflate",
    () =>
      dotnetBundleFixture([
        {
          path: "compressed",
          bytes: Buffer.from("hello"),
          compressed: true,
          storedBytes: Buffer.from([255, 255, 255]),
        },
      ]).bytes,
    "format",
  ],
  [
    "trailing deflate bytes",
    () =>
      dotnetBundleFixture([
        {
          path: "compressed",
          bytes: Buffer.from("hello"),
          compressed: true,
          storedBytes: Buffer.concat([
            deflateRawSync(Buffer.from("hello")),
            Buffer.from("junk"),
          ]),
        },
      ]).bytes,
    "format",
  ],
  [
    "prefix collision",
    () =>
      dotnetBundleFixture([
        { path: "one", bytes: Buffer.from("x") },
        { path: "one/two", bytes: Buffer.from("y") },
      ]).bytes,
    "path",
  ],
  [
    "invalid UTF-8",
    () => {
      const bytes = dotnetBundleFixture().bytes;
      bytes[bytes.length - 1] = 255;
      return bytes;
    },
    "format",
  ],
] as const)(
  "rejects %s without publishing output",
  async (_name, make, reason) => {
    const root = await createTestTempDirectory("rea-dotnet-invalid-");
    const path = join(root, "host.exe");
    await writeFile(path, make());
    const outputRoot = join(root, "output");
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "pe",
        outputRoot,
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope: new ArtifactResourceScope(),
      }),
    ).rejects.toMatchObject({ reason });
    await expect(access(outputRoot)).rejects.toThrow();
  },
);

it("rejects replacement, forged entry metadata and cancellation without losing cleanup", async () => {
  const root = await createTestTempDirectory("rea-dotnet-stable-");
  const path = join(root, "host.exe");
  await writeFile(path, dotnetBundleFixture().bytes);
  const reader = new DotnetBundleArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0]!;
    await expect(
      reader.open({ ...entry, declaredSize: 1 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.open(entry, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    await writeFile(
      path,
      dotnetBundleFixture([{ path: "changed", bytes: Buffer.from("other") }])
        .bytes,
    );
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
  await reader.close();
});

it("detects a renamed host, cancels an active compressed stream, and closes its descriptor", async () => {
  const root = await createTestTempDirectory("rea-dotnet-stream-");
  const path = join(root, "host.exe");
  await writeFile(
    path,
    dotnetBundleFixture([
      { path: "large", bytes: Buffer.alloc(1024 * 1024, 65), compressed: true },
    ]).bytes,
  );
  const reader = new DotnetBundleArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0]!;
    const controller = new AbortController();
    const stream = await reader.open(entry, controller.signal);
    let received = 0;
    await expect(
      (async () => {
        for await (const chunk of stream) {
          received += chunk.length;
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(entry.declaredSize!);
    expect(stream.destroyed).toBe(true);
    await rename(path, join(root, "moved.exe"));
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
  await expect(
    (async () => {
      for await (const _entry of reader.entries()) {
        /* Exhaust the public iterator. */
      }
    })(),
  ).rejects.toMatchObject({ reason: "unavailable" });
});

it("finds a split marker and uses the first apphost marker, including offset zero", async () => {
  const root = await createTestTempDirectory("rea-dotnet-marker-");
  const path = join(root, "host");
  const fixture = dotnetBundleFixture();
  const padded = Buffer.alloc(65536 + fixture.bytes.length);
  fixture.bytes.copy(padded, 65536);
  const header = 65536 + fixture.headerOffset;
  padded.writeBigUInt64LE(BigInt(header), 65536 - 10);
  DOTNET_BUNDLE_SIGNATURE.copy(padded, 65536 - 2);
  await writeFile(path, padded);
  const handle = await open(path, "r");
  try {
    expect(await findDotnetBundleHeader(handle, padded.length)).toBe(header);
    // Manifest reads may be shorter than requested on a regular file descriptor.
    const original = handle.read.bind(handle);
    handle.read = ((
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) =>
      original(
        buffer,
        offset,
        Math.min(length, 7),
        position,
      )) as typeof handle.read;
    expect(
      (await readDotnetBundle(handle, padded.length, header)).files,
    ).toMatchObject([{ path: "App.dll", size: 20 }]);
    const controller = new AbortController();
    handle.read = (async () => {
      controller.abort();
      throw new Error("injected read failure during cancellation");
    }) as typeof handle.read;
    await expect(
      findDotnetBundleHeader(handle, padded.length, controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    const metadataController = new AbortController();
    handle.read = (async () => {
      metadataController.abort();
      throw new Error("injected manifest read failure during cancellation");
    }) as typeof handle.read;
    await expect(
      readDotnetBundle(
        handle,
        padded.length,
        header,
        metadataController.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    await handle.close();
  }
  // A template's zero pointer wins even if a later embedded host has a marker.
  padded.writeBigUInt64LE(0n, 65536 - 10);
  await writeFile(path, padded);
  const template = await open(path, "r");
  try {
    expect(
      await findDotnetBundleHeader(template, padded.length),
    ).toBeUndefined();
  } finally {
    await template.close();
  }
});

const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

it.each(["elf", "mach-o"] as const)(
  "routes %s bundle bytes without a filename hint",
  async (format) => {
    const root = await createTestTempDirectory("rea-dotnet-native-");
    const path = join(root, "renamed.data");
    const fixture = dotnetBundleFixture();
    Buffer.from(format === "elf" ? "7f454c46" : "cffaedfe", "hex").copy(
      fixture.bytes,
    );
    await writeFile(path, fixture.bytes);
    const inventory = await inventoryArtifact(path, {
      resourceScope: new ArtifactResourceScope(),
    });
    expect(inventory.manifest.root_format).toBe("dotnet-bundle");
    expect(
      inventory.nodes.find((node) => node.sha256 === sha(fixture.bytes))
        ?.format,
    ).toBe(format);
    const outputRoot = join(root, "output");
    await extractArtifact({
      inputPath: path,
      inputFormat: format,
      outputRoot,
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope: new ArtifactResourceScope(),
    });
    expect(await readFile(join(outputRoot, "App.dll"))).toEqual(
      Buffer.from("owned assembly bytes"),
    );
  },
);
