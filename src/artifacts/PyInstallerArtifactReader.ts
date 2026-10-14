import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { createInflate } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";

import { artifactDecompressionBudgetBytes } from "../domain/artifactDecompressionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import {
  findPyInstallerCookie,
  readCArchiveToc,
  type CArchiveEntry,
  type PyInstallerCookie,
} from "./pyinstaller/CArchiveLayout.js";
import {
  archiveUsesEncryption,
  cookieFacts,
  projectPyzContainer,
  projectPyzMember,
  projectStoredMember,
  sealMember,
  type PyInstallerMember,
} from "./pyinstaller/CArchiveMembers.js";
import {
  inflateBounded,
  readPyzArchive,
  type PyzArchive,
} from "./pyinstaller/PyzArchive.js";
import type { PyInstallerFailure } from "./pyinstaller/PyInstallerFailure.js";

interface PyzImage {
  readonly archive: PyzArchive;
  readonly handle: FileHandle;
  readonly start: number;
}

interface LoadedArchive {
  readonly members: readonly PyInstallerMember[];
}

/**
 * Read-only inventory of a PyInstaller CArchive appended to a native executable.
 * Encrypted PYZ entries are reported and not decoded. Code members are not decompiled.
 */
export class PyInstallerArtifactReader implements ArtifactReader {
  readonly format = "pyinstaller" as const;
  #owner: OwnedFileHandle | undefined;
  #source: StableRegularFileDescriptor | undefined;
  #closed = false;
  #loaded: Promise<LoadedArchive> | undefined;
  #budget = 0;
  #charged = 0;
  #facts: readonly string[] = [];
  #temporaryRoot: string | undefined;
  #temporarySerial = 0;
  readonly #temporaryHandles = new Set<OwnedFileHandle>();
  readonly #spooledPyz = new Map<FileHandle, string>();
  readonly #members = new Map<string, PyInstallerMember>();
  readonly #openedPyzSizes = new Map<string, number>();

  constructor(
    private readonly path: string,
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
  }

  /** Cookie facts. Empty until entries() has parsed the archive. */
  observedFacts(): readonly string[] {
    return this.#facts;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const loaded = await this.#load(signal);
    await this.#verifySource();
    this.#members.clear();
    for (const member of loaded.members) {
      abortIfNeeded(signal);
      const sealed = sealMember(member);
      this.#members.set(sealed.entry.adapterKey, sealed);
      yield sealed.entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const stored = this.#members.get(entry.adapterKey);
    if (stored === undefined || !sameArtifactEntry(entry, stored.entry))
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller entry was not produced by this reader: ${entry.path}`,
      );
    if (entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        `PyInstaller entry is not a regular file: ${entry.path}`,
      );
    if (entry.encrypted)
      throw new ArtifactReaderFailure(
        "unavailable",
        `PYZ entry is encrypted and was not decoded: ${entry.path}`,
      );
    const read = stored.read;
    if (read === undefined)
      throw new ArtifactReaderFailure(
        "format",
        `PyInstaller entry has no readable bytes: ${entry.path}`,
      );
    await this.#verifySource();
    const bytes = await this.#inflateMember(
      read,
      stored.entry.adapterKey,
      signal,
    );
    await this.#verifySource();
    return Readable.from(bytes);
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    for (const owner of this.#temporaryHandles) {
      await owner.close();
      this.#temporaryHandles.delete(owner);
    }
    if (this.#temporaryRoot !== undefined) {
      await rm(this.#temporaryRoot, { recursive: true, force: true });
      this.#temporaryRoot = undefined;
    }
    await this.#owner?.close();
    this.#owner = undefined;
    this.#source = undefined;
    this.#closed = true;
    this.#loaded = undefined;
    this.#members.clear();
    this.#openedPyzSizes.clear();
    this.#spooledPyz.clear();
  }

  async #load(signal?: AbortSignal): Promise<LoadedArchive> {
    this.#loaded ??= this.#parse(signal);
    return this.#loaded;
  }

  async #parse(signal?: AbortSignal): Promise<LoadedArchive> {
    const handle = await this.#openHandle(signal);
    await this.#verifySource();
    const size = (await handle.stat()).size;
    this.#budget = artifactDecompressionBudgetBytes(size);
    const cookie = await this.#cookie(handle, size);
    const toc = await this.#toc(handle, cookie);
    for (const entry of toc) this.#charge(entry.uncompressedSize);
    assertMemberRanges(toc, cookie.tocOffset);
    assertUniqueMemberNames(toc);
    const images = await this.#pyzImages(handle, cookie, toc, signal);
    const magic = firstPythonMagic(images);
    const encrypted = archiveUsesEncryption(toc);
    const members = this.#project(
      toc,
      cookie,
      images,
      magic,
      encrypted,
      signal,
    );
    for (const member of members)
      if (member.read?.kind === "carchive")
        this.#charge(member.read.header?.length ?? 0);
    await this.#verifySource();
    this.#facts = cookieFacts(cookie);
    return { members };
  }

  async #openHandle(signal?: AbortSignal): Promise<FileHandle> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    if (this.#source !== undefined) return this.#source.handle;
    try {
      const handle = await openRegularFile(this.path, {
        symlinks: "reject",
        signal,
      });
      this.#owner = new OwnedFileHandle(handle);
      this.#source = { handle, initial: await handle.stat() };
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#owner = cause.owner;
      throw openFailure(this.path, cause);
    }
  }

  async #cookie(handle: FileHandle, size: number): Promise<PyInstallerCookie> {
    const found = await findPyInstallerCookie(handle, size);
    if (found === undefined)
      throw new ArtifactReaderFailure(
        "format",
        "PyInstaller CArchive cookie was not found",
      );
    if (!found.ok) throw failure(found.error);
    return found.value;
  }

  async #toc(
    handle: FileHandle,
    cookie: PyInstallerCookie,
  ): Promise<readonly CArchiveEntry[]> {
    const toc = await readCArchiveToc(handle, cookie);
    if (!toc.ok) throw failure(toc.error);
    return toc.value;
  }

  async #pyzImages(
    handle: FileHandle,
    cookie: PyInstallerCookie,
    toc: readonly CArchiveEntry[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<CArchiveEntry, PyzImage>> {
    const images = new Map<CArchiveEntry, PyzImage>();
    for (const entry of toc) {
      if (entry.typeCode !== "z") continue;
      abortIfNeeded(signal);
      const spooled =
        entry.compressionFlag === 0
          ? undefined
          : await this.#spoolPyz(handle, cookie.archiveStart, entry, signal);
      const source = spooled ?? {
        handle,
        start: cookie.archiveStart + entry.offset,
      };
      const parsed = await readPyzArchive(
        source.handle,
        source.start,
        entry.uncompressedSize,
        signal,
      );
      if (!parsed.ok) throw failure(parsed.error);
      if (spooled !== undefined) {
        await spooled.owner.close();
        this.#temporaryHandles.delete(spooled.owner);
        this.#spooledPyz.set(spooled.handle, spooled.path);
      }
      images.set(entry, {
        archive: parsed.value,
        handle: source.handle,
        start: source.start,
      });
    }
    return images;
  }

  async #spoolPyz(
    handle: FileHandle,
    archiveStart: number,
    entry: CArchiveEntry,
    signal?: AbortSignal,
  ): Promise<{
    readonly handle: FileHandle;
    readonly start: number;
    readonly path: string;
    readonly owner: OwnedFileHandle;
  }> {
    if (entry.compressedSize === 0)
      throw new ArtifactReaderFailure(
        "format",
        "Compressed PYZ image has no zlib bytes",
      );
    this.#temporaryRoot ??= await mkdtemp(join(tmpdir(), "rea-pyz-"));
    const path = join(this.#temporaryRoot, String(this.#temporarySerial));
    this.#temporarySerial += 1;
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > entry.uncompressedSize
            ? new ArtifactReaderFailure(
                "limit",
                "PYZ image exceeds its declared decompression budget",
              )
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        handle.createReadStream({
          start: archiveStart + entry.offset,
          end: archiveStart + entry.offset + entry.compressedSize - 1,
          autoClose: false,
        }),
        createInflate(),
        bounded,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        signal === undefined ? {} : { signal },
      );
    } catch (cause: unknown) {
      abortIfNeeded(signal);
      if (cause instanceof ArtifactReaderFailure) throw cause;
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "Z_BUF_ERROR" || cause.code === "Z_DATA_ERROR")
      )
        throw new ArtifactReaderFailure(
          "format",
          "Compressed PYZ image is not a complete zlib stream",
          { cause },
        );
      throw new ArtifactReaderFailure(
        "io",
        "Could not spool compressed PYZ image",
        { cause },
      );
    }
    if (bytes !== entry.uncompressedSize)
      throw new ArtifactReaderFailure(
        "integrity",
        "Decompressed PYZ image size disagrees with its table entry",
      );
    const opened = await open(path, "r");
    const owner = new OwnedFileHandle(opened);
    this.#temporaryHandles.add(owner);
    return { handle: opened, start: 0, path, owner };
  }

  #project(
    toc: readonly CArchiveEntry[],
    cookie: PyInstallerCookie,
    images: ReadonlyMap<CArchiveEntry, PyzImage>,
    magic: Buffer | undefined,
    encrypted: boolean,
    signal: AbortSignal | undefined,
  ): PyInstallerMember[] {
    const members: PyInstallerMember[] = [];
    for (const entry of toc) {
      abortIfNeeded(signal);
      const image = entry.typeCode === "z" ? images.get(entry) : undefined;
      if (image === undefined) {
        members.push(projectStoredMember(entry, cookie.archiveStart, magic));
        continue;
      }
      members.push(
        projectPyzContainer(
          entry,
          cookie.archiveStart,
          image.archive,
          encrypted,
        ),
      );
      if (image.archive.kind !== "entries") continue;
      for (const item of image.archive.entries)
        members.push(
          projectPyzMember(
            entry,
            item,
            encrypted,
            image.archive.pythonMagic,
            item.namespace || encrypted
              ? undefined
              : {
                  handle: image.handle,
                  offset: image.start + item.offset,
                  length: item.length,
                },
          ),
        );
    }
    return members;
  }

  async #readDeclared(
    handle: FileHandle,
    archiveStart: number,
    entry: CArchiveEntry,
  ): Promise<Buffer> {
    const compressed = await readExact(
      handle,
      archiveStart + entry.offset,
      entry.compressedSize,
    );
    if (entry.compressionFlag === 0) {
      if (compressed.length !== entry.uncompressedSize)
        throw new ArtifactReaderFailure(
          "integrity",
          `Stored CArchive member size disagrees with its table entry: ${entry.name}`,
        );
      return compressed;
    }
    const inflated = await inflateBounded(compressed, entry.uncompressedSize);
    if (!inflated.ok) throw failure(inflated.error);
    if (inflated.value.length !== entry.uncompressedSize)
      throw new ArtifactReaderFailure(
        "integrity",
        `Decompressed CArchive member size disagrees with its table entry: ${entry.name}`,
      );
    return inflated.value;
  }

  async #inflateMember(
    read: NonNullable<PyInstallerMember["read"]>,
    adapterKey: string,
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    abortIfNeeded(signal);
    if (read.kind === "pyz") {
      const previousSize = this.#openedPyzSizes.get(adapterKey);
      const remaining =
        previousSize ??
        this.#budget - this.#charged - (read.header?.length ?? 0);
      const compressed = await this.#readPyzRange(
        read.handle,
        read.offset,
        read.length,
      );
      const inflated = await inflateBounded(compressed, remaining);
      if (!inflated.ok) throw failure(inflated.error);
      if (previousSize === undefined) {
        this.#charge(inflated.value.length + (read.header?.length ?? 0));
        this.#openedPyzSizes.set(adapterKey, inflated.value.length);
      }
      abortIfNeeded(signal);
      return read.header === undefined
        ? inflated.value
        : Buffer.concat([read.header, inflated.value]);
    }
    const handle = this.#source?.handle;
    if (handle === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const bytes = await this.#readDeclared(
      handle,
      read.archiveStart,
      read.source,
    );
    abortIfNeeded(signal);
    return read.header === undefined
      ? bytes
      : Buffer.concat([read.header, bytes]);
  }

  async #readPyzRange(
    handle: FileHandle,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const path = this.#spooledPyz.get(handle);
    if (path === undefined) return readExact(handle, offset, length);
    const opened = await open(path, "r");
    const owner = new OwnedFileHandle(opened);
    this.#temporaryHandles.add(owner);
    try {
      return await readExact(opened, offset, length);
    } finally {
      await owner.close();
      this.#temporaryHandles.delete(owner);
    }
  }

  async #verifySource(): Promise<void> {
    const source = this.#source;
    if (source === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller source changed during reading: ${this.path}`,
      );
  }

  #charge(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#charged + bytes > this.#budget
    )
      throw new ArtifactReaderFailure(
        "limit",
        `PyInstaller members declare ${String(this.#charged + Math.max(0, bytes))} uncompressed bytes, exceeding the decompression budget`,
      );
    this.#charged += bytes;
  }
}

const firstPythonMagic = (
  images: ReadonlyMap<CArchiveEntry, PyzImage>,
): Buffer | undefined => {
  for (const image of images.values())
    if (image.archive.pythonMagic !== undefined)
      return image.archive.pythonMagic;
  return undefined;
};

const assertUniqueMemberNames = (entries: readonly CArchiveEntry[]): void => {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name))
      throw new ArtifactReaderFailure(
        "integrity",
        `Duplicate CArchive member name: ${entry.name}`,
      );
    names.add(entry.name);
  }
};

const assertMemberRanges = (
  entries: readonly CArchiveEntry[],
  tocOffset: number,
): void => {
  for (const entry of entries)
    if (
      entry.compressionFlag === 0 &&
      entry.compressedSize !== entry.uncompressedSize
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Stored CArchive member size disagrees with its table entry: ${entry.name}`,
      );
  const ranges = entries
    .filter((entry) => entry.compressedSize > 0)
    .map((entry) => ({
      name: entry.name,
      start: entry.offset,
      end: entry.offset + entry.compressedSize,
    }))
    .sort((left, right) => left.start - right.start);
  let occupied = 0;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.end) ||
      range.end > tocOffset ||
      range.start < occupied
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `CArchive member extends outside the archive or overlaps another member: ${range.name}`,
      );
    occupied = range.end;
  }
  for (const entry of entries)
    if (entry.offset > tocOffset)
      throw new ArtifactReaderFailure(
        "format",
        `CArchive member offset is outside the archive: ${entry.name}`,
      );
};

const readExact = async (
  handle: FileHandle,
  position: number,
  size: number,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new ArtifactReaderFailure(
      "format",
      "CArchive member range is invalid",
    );
  const bytes = Buffer.alloc(size);
  const read = await handle.read(bytes, 0, size, position);
  if (read.bytesRead !== size)
    throw new ArtifactReaderFailure(
      "format",
      "CArchive member extends outside the file",
    );
  return bytes;
};

const failure = (error: PyInstallerFailure): ArtifactReaderFailure =>
  new ArtifactReaderFailure(error.reason, error.message);

const openFailure = (path: string, cause: unknown): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof RegularFileAdmissionFailure)
    return ArtifactReaderFailure.withCleanup(
      cause.cause instanceof NonRegularFileReadError
        ? new ArtifactReaderFailure(
            "format",
            `PyInstaller source is not a regular file: ${path}`,
            { cause: cause.cause },
          )
        : cause.cause,
      ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, path),
    );
  if (cause instanceof NonRegularFileReadError)
    return new ArtifactReaderFailure(
      "format",
      `PyInstaller source is not a regular file: ${path}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "io",
    "PyInstaller archive could not be opened",
    {
      cause,
    },
  );
};
