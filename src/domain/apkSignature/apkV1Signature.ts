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

export interface ApkV1Signature {
  /** At least one signature block has its matching `.SF` signature file. */
  readonly present: boolean;
  readonly hasManifest: boolean;
  /** `META-INF/**.SF` signature files. */
  readonly signatureFiles: readonly string[];
  /** `META-INF/**.(RSA|DSA|EC)` PKCS#7 signature blocks. */
  readonly blockFiles: readonly string[];
}

const NAME_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Walk every central-directory record within the declared extent and count,
 * returning only the `META-INF/` names that take part in v1 signing. A record that runs past the
 * declared extent is an error, not a silently shorter list: a partial walk
 * would turn "unknown" into "absent".
 */
export const centralDirectoryV1SignatureNames = (
  bytes: Uint8Array,
  centralDirectoryOffset: number,
  centralDirectorySize: number,
  totalEntries: number,
): Result<string[], ApkCentralDirectoryError> => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(
    bytes.length,
    centralDirectoryOffset + centralDirectorySize,
  );
  const names: string[] = [];
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
        if (names.length >= MAX_V1_SIGNATURE_ENTRIES)
          return err({
            kind: "budget-exceeded",
            resource: "v1-signature-entries",
            limit: MAX_V1_SIGNATURE_ENTRIES,
          });
        names.push(name);
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
  return ok(names);
};

/** Classify central-directory names into the v1 (JAR) signing facts. */
export const detectV1Signature = (names: readonly string[]): ApkV1Signature => {
  const selected = names.filter((name) => name.startsWith(META_INF));
  // Case-sensitive throughout, as apksig matches JAR signature entries.
  const signatureFiles = selected.filter(isSignatureFile);
  const blockFiles = selected.filter(isSignatureBlock);
  const sfNames = new Set(signatureFiles);
  return {
    present: blockFiles.some((block) => sfNames.has(signatureFileFor(block))),
    hasManifest: selected.includes(MANIFEST),
    signatureFiles,
    blockFiles,
  };
};
