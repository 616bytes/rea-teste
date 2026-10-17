/**
 * Read each v1 (JAR) signer's PKCS#7 block from the archive and materialise
 * its declared facts. The domain owns the ZIP and DER structure; this adapter
 * owns inflation (bounded by the inflater itself, not the declared size) and
 * hands every certificate to the shared certificate owner.
 */
import { inflateRawSync } from "node:zlib";

import type { ApkSignatureResult } from "../domain/apkSignature/apkSignatureReport.js";
import {
  localEntryData,
  type ApkV1SignerEntry,
} from "../domain/apkSignature/apkV1Signature.js";
import {
  decodeV1SignatureBlock,
  type ApkV1SignedData,
} from "../domain/apkSignature/apkV1SignatureBlock.js";
import {
  certificateBytes,
  certificateFacts,
  type Certificate,
} from "./apkCertificateFacts.js";
import { APK_SIGNATURE_LIMITS } from "./ApkSignatureRelease.js";

type V1Signer = ApkSignatureResult["schemes"]["v1"]["signers"][number];

/** One v1 signer: its decoded SignedData, or why it could not be read. */
export interface DecodedV1Signer {
  readonly entry: ApkV1SignerEntry;
  readonly decoded:
    | { readonly ok: true; readonly value: ApkV1SignedData }
    | { readonly ok: false; readonly error: string };
}

/** Estimated serialized size of one v1 signer, before it is materialised. */
export const projectedV1SignerBytes = ({
  entry,
  decoded,
}: DecodedV1Signer): number => {
  let total = 512 + 3 * (entry.signatureFile.length + entry.block.name.length);
  if (!decoded.ok) return total;
  // The named certificate appears in full and again in `certificates`.
  for (const der of decoded.value.certificates)
    total += 2 * certificateBytes(der);
  return total + 256 * decoded.value.signerInfos.length;
};

/**
 * Read one signature block's bytes (stored or deflated) within the per-block
 * bound and decode its SignedData. Every failure is the signer's own
 * `decode_error`, so one damaged block neither hides the others nor reads as
 * absent.
 */
export const decodeV1Signer = (
  bytes: Uint8Array,
  entry: ApkV1SignerEntry,
  entriesEnd: number,
): DecodedV1Signer => {
  const fail = (error: string): DecodedV1Signer => ({
    entry,
    decoded: { ok: false, error },
  });
  const { block } = entry;
  const limit = APK_SIGNATURE_LIMITS.v1BlockBytes;
  // Locating reads no data, and names a Zip64 sentinel size as such rather
  // than as a size over the bound.
  const stored = localEntryData(bytes, block, entriesEnd);
  if (!stored.ok) return fail(stored.error.detail);
  if (block.uncompressedSize > limit)
    return fail(
      `signature block declares ${String(block.uncompressedSize)} bytes, over the ${String(limit)}-byte bound`,
    );
  let data: Uint8Array;
  if (block.method === 0) data = stored.value;
  else if (block.method === 8) {
    try {
      data = inflateRawSync(stored.value, { maxOutputLength: limit });
    } catch (cause: unknown) {
      return fail(
        cause instanceof RangeError
          ? `signature block inflates past the ${String(limit)}-byte bound`
          : "signature block deflate stream is damaged",
      );
    }
  } else
    return fail(`compression method ${String(block.method)} is not supported`);
  if (data.length !== block.uncompressedSize)
    return fail(
      `signature block holds ${String(data.length)} bytes, the central directory declares ${String(block.uncompressedSize)}`,
    );
  const signedData = decodeV1SignatureBlock(data);
  if (signedData.ok) return { entry, decoded: signedData };
  return fail(
    signedData.error.kind === "malformed-pkcs7"
      ? `malformed PKCS#7: ${signedData.error.detail}`
      : `more ${signedData.error.resource} than ${String(signedData.error.limit)}`,
  );
};

/** Facts about decoded v1 blocks that the report has no field for. */
export const v1SignerNotes = (signers: readonly DecodedV1Signer[]): string[] =>
  signers.flatMap(({ entry, decoded }) =>
    decoded.ok && decoded.value.trailingBytes > 0
      ? [
          `${entry.block.name}: ${String(decoded.value.trailingBytes)} bytes follow the PKCS#7 ContentInfo and were ignored, as apksig ignores them.`,
        ]
      : [],
  );

/** Materialise one v1 signer's declared facts through the shared certificate owner. */
export const v1SignerFacts = ({
  entry,
  decoded,
}: DecodedV1Signer): V1Signer => {
  const base = {
    signature_file: entry.signatureFile,
    block_file: entry.block.name,
  };
  if (!decoded.ok)
    return {
      ...base,
      certificate: null,
      certificates: [],
      signer_infos: [],
      decode_error: decoded.error,
    };
  const facts = decoded.value.certificates.map(certificateFacts);
  const infos = decoded.value.signerInfos;
  const named = (index: number | null): Certificate =>
    index === null ? null : (facts[index] ?? null);
  return {
    ...base,
    // Without verification, a block with several SignerInfos has no one signer.
    certificate:
      infos.length === 1 ? named(infos[0]?.certificateIndex ?? null) : null,
    certificates: facts.flatMap((fact) =>
      fact === null
        ? []
        : [
            {
              sha256_fingerprint: fact.sha256_fingerprint,
              subject: fact.subject,
            },
          ],
    ),
    signer_infos: infos.map((info) => ({
      identified_by: info.identifiedBy,
      certificate_sha256:
        named(info.certificateIndex)?.sha256_fingerprint ?? null,
      digest_algorithm_oid: info.digestAlgorithmOid,
      signature_algorithm_oid: info.signatureAlgorithmOid,
    })),
    decode_error: null,
  };
};
