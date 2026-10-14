import { deflateSync } from "node:zlib";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  inflateBounded,
  parsePyzArchive,
  readPyzArchive,
  MAX_PYZ_TABLE_BYTES,
} from "./PyzArchive.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PYTHON_39_MAGIC, pyzArchive } from "./CArchive.fixture.js";

it("lists modules from a supported PYZ and leaves an unknown magic opaque", () => {
  const body = Buffer.from("module");
  const parsed = parsePyzArchive(
    pyzArchive({
      magic: PYTHON_39_MAGIC,
      modules: [{ name: "json.decoder", typeCode: 0, body }],
    }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "entries") return;
  expect(parsed.value.pythonVersion).toBe("3.9");
  expect(parsed.value.entries).toMatchObject([
    { name: "json.decoder", typeCode: 0, package: false },
  ]);

  const opaque = parsePyzArchive(
    pyzArchive({
      magic: Buffer.alloc(4),
      modules: [{ name: "json.decoder", typeCode: 0, body }],
    }),
  );
  expect(opaque.ok).toBe(true);
  if (!opaque.ok || opaque.value.kind !== "opaque") return;
  expect(opaque.value.limitation).toContain("left opaque");
});

it("leaves a PYZ opaque when the table uses an unsupported marshal type", () => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [],
    toc: Buffer.from([0x4e]),
  });
  const parsed = parsePyzArchive(image);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "opaque") return;
  expect(parsed.value.limitation).toContain("left opaque");
  expect(parsed.value.pythonMagic).toEqual(PYTHON_39_MAGIC);
});

it("reports an entry that extends outside the PYZ as an integrity error", () => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [{ name: "missing", typeCode: 0, body: Buffer.from("x") }],
  });
  image.writeInt32LE(100_000, image.length - 4);
  const parsed = parsePyzArchive(image);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.reason).toBe("integrity");
});

it("stops a zlib stream that expands past the supplied output bound", async () => {
  const inflated = await inflateBounded(
    deflateSync(Buffer.from("hello world hello world")),
    4,
  );
  expect(inflated.ok).toBe(false);
  if (inflated.ok) return;
  expect(inflated.error.reason).toBe("limit");
});

it("classifies a truncated zlib stream as malformed rather than over budget", async () => {
  const compressed = deflateSync(Buffer.from("complete module"));
  const result = await inflateBounded(compressed.subarray(0, -2), 1024);
  expect(result).toMatchObject({ ok: false, error: { reason: "format" } });
});

it("rejects an oversized sparse PYZ table before allocating its bytes", async () => {
  const root = await createTestTempDirectory("rea-pyz-table-budget-");
  const path = join(root, "image.pyz");
  const header = Buffer.alloc(12);
  header.write("PYZ\0");
  PYTHON_39_MAGIC.copy(header, 4);
  header.writeUInt32BE(12, 8);
  await writeFile(path, header);
  const handle = await open(path, "r+");
  try {
    const size = 12 + MAX_PYZ_TABLE_BYTES + 1;
    await handle.truncate(size);
    expect(await readPyzArchive(handle, 0, size)).toMatchObject({
      ok: false,
      error: { reason: "limit" },
    });
  } finally {
    await handle.close();
  }
});
