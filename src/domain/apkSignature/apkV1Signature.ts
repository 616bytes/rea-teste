/**
 * Detect v1 (JAR) signing from the ZIP central directory as apksig's
 * V1SchemeVerifier selects it: among entries whose name starts with
 * `META-INF/` (at any depth), `META-INF/MANIFEST.MF` is the manifest, names
 * ending in `.SF` are signature files and names ending in `.RSA`/`.DSA`/`.EC`
 * are signature blocks (all case-sensitive). A signer exists only where a
 * block's `.SF` partner (`name.substring(0, lastIndexOf('.')) + ".SF"`) is
 * present. The PKCS#7 blocks are not parsed, so no v1 signature is verified.
 *
 * Dependency-free and bounded: central-directory records are walked within the
 * declared directory extent and entry count; a record running past it is a
 * tagged error rather than a silently shorter list. Only the signing-relevant
 * `META-INF/` names are decoded and retained, capped at a format-justified
 * count, so memory does not grow with the archive's total entry count (up to
 * ~11M records in a 512 MiB Zip64 file).
 */
import { type Result, err, ok } from "../result.js";

const CD_SIGNATURE = 0x02014b50;
const CD_FIXED_SIZE = 46;

export type ApkCentralDirectoryError =
  | {
      readonly kind: "malformed-central-directory";
      readonly offset: number;
      readonly detail: string;
    }
  | {
      readonly kind: "budget-exceeded";
      readonly resource: "v1-signature-entries";
      readonly limit: number;
    };

/**
 * Signing-relevant `META-INF/` entries retained. A signed APK holds a manifest
 * plus one `.SF` and one block per v1 signer; thousands is already pathological.
 */
export const MAX_V1_SIGNATURE_ENTRIES = 4096;

/**
 * v1 signers (signature block + `.SF` pairs) decoded. apksig accepts at most
 * 10; more only multiplies work and output, so the report is refused.
 */
export const MAX_V1_SIGNERS = 32;

const META_INF = "META-INF/";
const MANIFEST = "META-INF/MANIFEST.MF";
const META_INF_BYTES = Uint8Array.from(
  [...META_INF].map((c) => c.charCodeAt(0)),
);

/** True when the raw name starts with `META-INF/` (apksig's selection). */
const startsWithMetaInf = (
  bytes: Uint8Array,
  start: number,
  length: number,
): boolean => {
  if (length < META_INF_BYTES.length) return false;
  for (let i = 0; i < META_INF_BYTES.length; i += 1)
    if (bytes[start + i] !== META_INF_BYTES[i]) return false;
  return true;
};

const BLOCK_SUFFIXES = [".RSA", ".DSA", ".EC"] as const;
const isSignatureFile = (name: string): boolean => name.endsWith(".SF");
const isSignatureBlock = (name: string): boolean =>
  BLOCK_SUFFIXES.some((suffix) => name.endsWith(suffix));

/** The `.SF` file apksig pairs with a signature block. */
const signatureFileFor = (block: string): string =>
  `${block.slice(0, block.lastIndexOf("."))}.SF`;

/** The one owner of which `META-INF/` names take part in v1 signing. */
const isV1SignatureName = (name: string): boolean =>
  name === MANIFEST || isSignatureFile(name) || isSignatureBlock(name);

/** A signing-relevant central-directory entry and where its data is stored. */
export interface ApkV1Entry {
  readonly name: string;
  /** ZIP compression method (0 stored, 8 deflate). */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** A v1 signer as apksig pairs it: one signature block and its `.SF` partner. */
export interface ApkV1SignerEntry {
  readonly signatureFile: string;
  readonly block: ApkV1Entry;
}

export interface ApkV1Signature {
  /** At least one signature block has its matching `.SF` signature file. */
  readonly present: boolean;
  readonly hasManifest: boolean;
  /** `META-INF/**.SF` signature files. */
  readonly signatureFiles: readonly string[];
  /** `META-INF/**.(RSA|DSA|EC)` PKCS#7 signature blocks. */
  readonly blockFiles: readonly string[];
  /** Blocks paired with their `.SF` file, in central-directory order. */
  readonly signers: readonly ApkV1SignerEntry[];
}

const NAME_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Walk every central-directory record within the declared extent and count,
 * returning only the `META-INF/` names that take part in v1 signing. A record that runs past the
 * declared extent is an error, not a silently shorter list: a partial walk
 * would turn "unknown" into "absent".
 */
export const centralDirectoryV1SignatureEntries = (
  bytes: Uint8Array,
  centralDirectoryOffset: number,
  centralDirectorySize: number,
  totalEntries: number,
): Result<ApkV1Entry[], ApkCentralDirectoryError> => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(
    bytes.length,
    centralDirectoryOffset + centralDirectorySize,
  );
  const entries: ApkV1Entry[] = [];
  let at = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (at + CD_FIXED_SIZE > end)
      return err({
        kind: "malformed-central-directory",
        offset: at,
        detail: `central directory ends after ${String(i)} of ${String(totalEntries)} records`,
      });
    if (dv.getUint32(at, true) !== CD_SIGNATURE)
      return err({
        kind: "malformed-central-directory",
        offset: at,
        detail: "central-directory record signature mismatch",
      });
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const nameStart = at + CD_FIXED_SIZE;
    if (nameStart + nameLength > end)
      return err({
        kind: "malformed-central-directory",
        offset: nameStart,
        detail: "central-directory file name runs past the directory",
      });
    if (startsWithMetaInf(bytes, nameStart, nameLength)) {
      const name = NAME_DECODER.decode(
        bytes.subarray(nameStart, nameStart + nameLength),
      );
      if (isV1SignatureName(name)) {
        if (entries.length >= MAX_V1_SIGNATURE_ENTRIES)
          return err({
            kind: "budget-exceeded",
            resource: "v1-signature-entries",
            limit: MAX_V1_SIGNATURE_ENTRIES,
          });
        entries.push({
          name,
          method: dv.getUint16(at + 10, true),
          compressedSize: dv.getUint32(at + 20, true),
          uncompressedSize: dv.getUint32(at + 24, true),
          localHeaderOffset: dv.getUint32(at + 42, true),
        });
      }
    }
    at = nameStart + nameLength + extraLength + commentLength;
  }
  // An under-declared record count would silently hide entries (and so v1
  // signing): the walk must consume exactly the declared directory.
  if (at !== end)
    return err({
      kind: "malformed-central-directory",
      offset: at,
      detail: `${String(end - at)} bytes of the declared central directory remain after ${String(totalEntries)} records`,
    });
  return ok(entries);
};

/** Classify central-directory entries into the v1 (JAR) signing facts. */
export const detectV1Signature = (
  entries: readonly ApkV1Entry[],
): ApkV1Signature => {
  const selected = entries.filter((entry) => entry.name.startsWith(META_INF));
  // Case-sensitive throughout, as apksig matches JAR signature entries.
  const signatureFiles = selected
    .map((entry) => entry.name)
    .filter(isSignatureFile);
  const blocks = selected.filter((entry) => isSignatureBlock(entry.name));
  const sfNames = new Set(signatureFiles);
  const signers = blocks.flatMap((block) => {
    const signatureFile = signatureFileFor(block.name);
    return sfNames.has(signatureFile) ? [{ signatureFile, block }] : [];
  });
  return {
    present: signers.length > 0,
    hasManifest: selected.some((entry) => entry.name === MANIFEST),
    signatureFiles,
    blockFiles: blocks.map((block) => block.name),
    signers,
  };
};

const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_FIXED_SIZE = 30;
const ZIP64_SENTINEL = 0xffffffff;

/** Why an entry's stored bytes could not be located. */
export type ApkLocalEntryError = { readonly detail: string };

/**
 * Locate an entry's stored (possibly compressed) bytes through its local file
 * header. The data must lie within the archive's entry region (before the
 * signing block or central directory) and its declared sizes must be read
 * directly, so Zip64-sized entries are reported, not guessed.
 */
export const localEntryData = (
  bytes: Uint8Array,
  entry: ApkV1Entry,
  entriesEnd: number,
): Result<Uint8Array, ApkLocalEntryError> => {
  if (
    entry.compressedSize === ZIP64_SENTINEL ||
    entry.uncompressedSize === ZIP64_SENTINEL ||
    entry.localHeaderOffset === ZIP64_SENTINEL
  )
    return err({ detail: "Zip64 entry sizes are not read" });
  const at = entry.localHeaderOffset;
  const limit = Math.min(entriesEnd, bytes.length);
  if (at + LOCAL_FIXED_SIZE > limit)
    return err({
      detail: `local header at byte ${String(at)} is out of range`,
    });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(at, true) !== LOCAL_SIGNATURE)
    return err({
      detail: `local header signature mismatch at byte ${String(at)}`,
    });
  const start =
    at +
    LOCAL_FIXED_SIZE +
    dv.getUint16(at + 26, true) +
    dv.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > limit)
    return err({
      detail: `entry data at byte ${String(start)} runs past the entries`,
    });
  return ok(bytes.subarray(start, end));
};
