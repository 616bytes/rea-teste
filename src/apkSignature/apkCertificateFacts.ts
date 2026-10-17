/**
 * The one owner of certificate facts for every APK signing scheme (v1, v2,
 * v3/v3.1, lineage nodes and source stamps): identity is SHA-256 over the raw
 * embedded DER, and the readable X.509 facts come from the platform parser.
 */
import { createHash, X509Certificate } from "node:crypto";

import type { ApkSignatureResult } from "../domain/apkSignature/apkSignatureReport.js";

export type Certificate =
  ApkSignatureResult["schemes"]["v2"]["signers"][number]["certificate"];

/** SHA-256 over the raw embedded DER — exactly what apksig/apksigner hash. */
const derFingerprint = (der: Uint8Array): string =>
  createHash("sha256").update(der).digest("hex");

/** Each fact is read independently so one unsupported field does not hide the rest. */
const attempt = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/** Identity is the raw-DER fingerprint; parsed X.509 facts are null when unreadable. */
export const certificateFacts = (der: Uint8Array): Certificate => {
  const cert = attempt(() => new X509Certificate(Buffer.from(der)));
  return {
    sha256_fingerprint: derFingerprint(der),
    subject: cert?.subject ?? null,
    issuer: cert?.issuer ?? null,
    serial_number: cert?.serialNumber ?? null,
    not_before: cert ? attempt(() => cert.validFromDate.toISOString()) : null,
    not_after: cert ? attempt(() => cert.validToDate.toISOString()) : null,
    public_key_algorithm: cert
      ? attempt(() => cert.publicKey.asymmetricKeyType ?? null)
      : null,
  };
};

/**
 * Estimated serialized size of one certificate's facts. RFC 2253-escaped DNs
 * can reach ~2.6x the DER once JSON-escaped, hence 3x; this is an admission
 * estimate — the provider's exact serialized re-check is authoritative.
 */
export const certificateBytes = (der: Uint8Array | undefined): number =>
  256 + 3 * (der?.length ?? 0);
