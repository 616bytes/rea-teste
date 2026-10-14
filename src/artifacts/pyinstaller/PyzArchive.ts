import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { hashReadable } from "../ArtifactHash.js";
import { inflate as inflateCallback } from "node:zlib";
import { promisify } from "node:util";

import { err, ok, type Result } from "../../domain/result.js";
import { readMarshalSubset, type MarshalValue } from "./MarshalSubset.js";
import {
  pyInstallerFailure,
  type PyInstallerFailure,
} from "./PyInstallerFailure.js";
import { pythonVersionForMagic } from "./PythonBytecode.js";

const inflate = promisify(inflateCallback);
const PYZ_MAGIC = Buffer.from("PYZ\0");
const PYZ_HEADER_BYTES = 12;

/** One PYZ table entry. Type codes follow the archive's module, package, data, and namespace values. */
export interface PyzEntry {
  readonly name: string;
  readonly typeCode: number;
  readonly offset: number;
  readonly length: number;
  readonly package: boolean;
  readonly namespace: boolean;
}

export type PyzArchive =
  | {
      readonly kind: "entries";
      readonly pythonMagic: Buffer;
      readonly pythonVersion: string;
      readonly sha256: string;
      readonly entries: readonly PyzEntry[];
    }
  | {
      readonly kind: "opaque";
      readonly pythonMagic: Buffer | undefined;
      readonly sha256: string;
      readonly limitation: string;
    };

/** Parse a PYZ image. Unexpected marshal values become an opaque member. */
export const parsePyzArchive = (
  bytes: Buffer,
): Result<PyzArchive, PyInstallerFailure> => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const header = bytes.subarray(0, PYZ_HEADER_BYTES);
  const offset =
    bytes.length >= PYZ_HEADER_BYTES ? bytes.readUInt32BE(8) : bytes.length;
  return parsePyzParts(header, bytes.subarray(offset), bytes.length, sha256);
};

/** Bound the transient marshal table allocation independently of image expansion. */
export const MAX_PYZ_TABLE_BYTES = 16 * 1024 * 1024;

/** Parse only the header and table in memory; hash the complete file range in chunks. */
export const readPyzArchive = async (
  handle: FileHandle,
  start: number,
  size: number,
  signal?: AbortSignal,
): Promise<Result<PyzArchive, PyInstallerFailure>> => {
  if (size < PYZ_HEADER_BYTES)
    return err(
      pyInstallerFailure("format", "PYZ archive magic does not match"),
    );
  const header = Buffer.alloc(Math.min(size, PYZ_HEADER_BYTES));
  const headerRead = await handle.read(header, 0, header.length, start);
  if (headerRead.bytesRead !== header.length)
    return err(
      pyInstallerFailure("format", "PYZ header extends outside the file"),
    );
  const tocOffset =
    header.length === PYZ_HEADER_BYTES ? header.readUInt32BE(8) : size;
  const validOffset = tocOffset >= PYZ_HEADER_BYTES && tocOffset <= size;
  const knownMagic = pythonVersionForMagic(header.subarray(4, 8)) !== undefined;
  const tableSize = validOffset && knownMagic ? size - tocOffset : 0;
  if (tableSize > MAX_PYZ_TABLE_BYTES)
    return err(
      pyInstallerFailure(
        "limit",
        "PYZ table exceeds the 16 MiB in-memory table budget",
      ),
    );
  const table = Buffer.alloc(tableSize);
  const read = await handle.read(table, 0, tableSize, start + tocOffset);
  if (read.bytesRead !== tableSize)
    return err(
      pyInstallerFailure("format", "PYZ table extends outside the file"),
    );
  const digest = await hashReadable(
    handle.createReadStream({
      start,
      end: start + size - 1,
      autoClose: false,
      ...(signal === undefined ? {} : { signal }),
    }),
    signal,
  );
  if (digest.bytes !== size)
    return err(
      pyInstallerFailure("format", "PYZ image extends outside the file"),
    );
  return parsePyzParts(header, table, size, digest.sha256);
};

const parsePyzParts = (
  header: Buffer,
  table: Buffer,
  size: number,
  sha256: string,
): Result<PyzArchive, PyInstallerFailure> => {
  if (
    header.length < PYZ_HEADER_BYTES ||
    !header.subarray(0, 4).equals(PYZ_MAGIC)
  )
    return err(
      pyInstallerFailure("format", "PYZ archive magic does not match"),
    );
  const pythonMagic = Buffer.from(header.subarray(4, 8));
  const pythonVersion = pythonVersionForMagic(pythonMagic);
  if (pythonVersion === undefined)
    return ok({
      kind: "opaque",
      pythonMagic: undefined,
      sha256,
      limitation: `PYZ Python magic ${pythonMagic.toString("hex")} is not in the supported set; the member was left opaque.`,
    });
  const tocOffset = header.readUInt32BE(8);
  if (tocOffset < PYZ_HEADER_BYTES || tocOffset > size)
    return err(
      pyInstallerFailure(
        "format",
        "PYZ table of contents is outside the archive",
      ),
    );
  const marshalled = readMarshalSubset(table);
  if (!marshalled.ok)
    return ok({
      kind: "opaque",
      pythonMagic,
      sha256,
      limitation: `PYZ table of contents could not be parsed (${marshalled.error.message}); the member was left opaque.`,
    });
  const entries = pyzEntries(marshalled.value, size);
  if (!entries.ok)
    return entries.error.reason === "format"
      ? ok({
          kind: "opaque",
          pythonMagic,
          sha256,
          limitation: `${entries.error.message}; the member was left opaque.`,
        })
      : entries;
  return ok({
    kind: "entries",
    pythonMagic,
    pythonVersion,
    sha256,
    entries: entries.value,
  });
};

/** Inflate one zlib member. Output is capped by the caller-supplied budget. */
export const inflateBounded = async (
  bytes: Buffer,
  maxOutputBytes: number,
): Promise<Result<Buffer, PyInstallerFailure>> => {
  if (maxOutputBytes < 0)
    return err(
      pyInstallerFailure(
        "limit",
        "Compressed member exceeds the decompression budget",
      ),
    );
  try {
    // Node requires a positive cap. One byte still validates an empty stream
    // and rejects any produced output when the declared size is zero.
    const output = await inflate(bytes, {
      maxOutputLength: maxOutputBytes === 0 ? 1 : maxOutputBytes,
    });
    if (output.length > maxOutputBytes)
      return err(
        pyInstallerFailure(
          "limit",
          "Compressed member exceeds the decompression budget",
        ),
      );
    return ok(output);
  } catch (cause: unknown) {
    if (isOutputLimit(cause))
      return err(
        pyInstallerFailure(
          "limit",
          "Compressed member exceeds the decompression budget",
        ),
      );
    return err(
      pyInstallerFailure("format", "Compressed member is not a zlib stream"),
    );
  }
};

const pyzEntries = (
  value: MarshalValue,
  archiveBytes: number,
): Result<readonly PyzEntry[], PyInstallerFailure> => {
  if (!Array.isArray(value))
    return err(
      pyInstallerFailure("format", "PYZ table of contents is not a list"),
    );
  const entries: PyzEntry[] = [];
  for (const item of value) {
    const entry = onePyzEntry(item, archiveBytes);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }
  return ok(entries);
};

const onePyzEntry = (
  item: MarshalValue,
  archiveBytes: number,
): Result<PyzEntry, PyInstallerFailure> => {
  if (!Array.isArray(item) || item.length !== 2)
    return err(
      pyInstallerFailure(
        "format",
        "PYZ table entry is not a name and position pair",
      ),
    );
  const [name, position] = item;
  if (
    typeof name !== "string" ||
    !Array.isArray(position) ||
    position.length !== 3
  )
    return err(
      pyInstallerFailure(
        "format",
        "PYZ table entry is not a name, type, offset, and length",
      ),
    );
  const [typeCode, offset, length] = position;
  if (
    !Number.isSafeInteger(typeCode) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length)
  )
    return err(
      pyInstallerFailure(
        "format",
        "PYZ table entry positions are not integers",
      ),
    );
  if (typeCode < 0 || typeCode > 3)
    return err(
      pyInstallerFailure(
        "format",
        `PYZ table entry type ${String(typeCode)} is not a known module, package, data, or namespace code`,
      ),
    );
  if (typeCode !== 3 && length === 0)
    return err(
      pyInstallerFailure("format", `PYZ entry ${name} has no compressed bytes`),
    );
  if (
    length < 0 ||
    offset < 0 ||
    (length > 0 &&
      (offset < PYZ_HEADER_BYTES || offset + length > archiveBytes))
  )
    return err(
      pyInstallerFailure(
        "integrity",
        `PYZ entry ${name} extends outside the archive`,
      ),
    );
  return ok({
    name,
    typeCode,
    offset,
    length,
    package: typeCode === 1 || typeCode === 3,
    namespace: typeCode === 3,
  });
};

const isOutputLimit = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ERR_BUFFER_ERROR" || cause.code === "ERR_BUFFER_TOO_LARGE");
