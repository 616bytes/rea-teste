/**
 * Decode the signer structures inside an APK Signature Scheme v2/v3/v3.1 block
 * value (APK Signature Scheme v2+). Each scheme value is a little-endian,
 * uint32-length-prefixed sequence of signers; a signer carries length-prefixed
 * signed-data (digests, X.509 certificate DER, and — for v3 — min/max SDK and
 * additional attributes including the proof-of-rotation lineage).
 *
 * This frames the structure and exposes digests (by signature-algorithm id),
 * certificate DER extents, SDK bounds, and additional attributes. Certificate
 * fact extraction and digest recomputation are layered on top. Dependency-free,
 * bounded, Result-based: a short or inconsistent length yields a tagged error,
 * never a throw.
 */
import { type Result, err, ok } from "../result.js";

export type ApkSchemeVersion = "v2" | "v3" | "v3.1";

export type ApkSchemeError =
  | {
      readonly kind: "malformed-signer";
      readonly offset: number;
      readonly detail: string;
    }
  | {
      readonly kind: "budget-exceeded";
      readonly resource: string;
      readonly declared: number;
    };

export interface ApkSignerDigest {
  /** APK signature-algorithm id (e.g. 0x0103 = RSA-PKCS1 SHA-256). */
  readonly algorithmId: number;
  readonly digest: Uint8Array;
}

export interface ApkSignerAttribute {
  readonly id: number;
  readonly value: Uint8Array;
}

export interface ApkSigner {
  /** X.509 certificate DER blobs; the first is the signing certificate. */
  readonly certificates: readonly Uint8Array[];
  readonly digests: readonly ApkSignerDigest[];
  readonly minSdk: number | null;
  readonly maxSdk: number | null;
  readonly attributes: readonly ApkSignerAttribute[];
}

/** Additional-attribute id carrying the v3 proof-of-rotation lineage. */
export const PROOF_OF_ROTATION_ATTR_ID = 0x3ba06f8c;
/** Additional-attribute id asserting v1/v2 stripping protection. */
export const STRIPPING_PROTECTION_ATTR_ID = 0xbeeff00d;

const MAX_ELEMENTS = 4096;

/** Sequential little-endian reader over a byte range; every read is bounds-checked. */
class LeReader {
  offset: number;
  private readonly dv: DataView;
  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
    private readonly end = bytes.length,
  ) {
    this.offset = start;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number {
    return this.end - this.offset;
  }
  u32(): number | null {
    if (this.remaining < 4) return null;
    const v = this.dv.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  /** A uint32-length-prefixed chunk; returns a view over its bytes, or null if oob. */
  lenChunk(): Uint8Array | null {
    const length = this.u32();
    if (length === null || length > this.remaining) return null;
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, start + length);
  }
}

/** Split a length-prefixed sequence into its length-prefixed elements. */
const elements = (seq: Uint8Array | null): Uint8Array[] | null => {
  if (seq === null) return null;
  const reader = new LeReader(seq);
  const out: Uint8Array[] = [];
  while (reader.remaining > 0) {
    if (out.length >= MAX_ELEMENTS) return null;
    const el = reader.lenChunk();
    if (el === null) return null;
    out.push(el);
  }
  return out;
};

const decodeDigests = (seq: Uint8Array | null): ApkSignerDigest[] | null => {
  const items = elements(seq);
  if (items === null) return null;
  const digests: ApkSignerDigest[] = [];
  for (const item of items) {
    const reader = new LeReader(item);
    const algorithmId = reader.u32();
    const digest = reader.lenChunk();
    if (algorithmId === null || digest === null) return null;
    digests.push({ algorithmId, digest });
  }
  return digests;
};

const decodeAttributes = (
  seq: Uint8Array | null,
): ApkSignerAttribute[] | null => {
  const items = elements(seq);
  if (items === null) return null;
  const attributes: ApkSignerAttribute[] = [];
  for (const item of items) {
    const reader = new LeReader(item);
    const id = reader.u32();
    if (id === null) return null;
    attributes.push({ id, value: item.subarray(4) });
  }
  return attributes;
};

/** Decode one signer's signed-data chunk (v3 carries min/max SDK before attributes). */
const decodeSignedData = (
  signedData: Uint8Array,
  version: ApkSchemeVersion,
): ApkSigner | null => {
  const reader = new LeReader(signedData);
  const digests = decodeDigests(reader.lenChunk());
  const certificates = elements(reader.lenChunk());
  if (digests === null || certificates === null) return null;
  let minSdk: number | null = null;
  let maxSdk: number | null = null;
  if (version !== "v2") {
    minSdk = reader.u32();
    maxSdk = reader.u32();
    if (minSdk === null || maxSdk === null) return null;
  }
  const attributes = decodeAttributes(reader.lenChunk());
  if (attributes === null) return null;
  return { certificates, digests, minSdk, maxSdk, attributes };
};

/** Decode every signer in a v2/v3/v3.1 scheme block value. */
export const decodeSigners = (
  value: Uint8Array,
  version: ApkSchemeVersion,
): Result<ApkSigner[], ApkSchemeError> => {
  const signerChunks = elements(new LeReader(value).lenChunk());
  if (signerChunks === null)
    return err({
      kind: "malformed-signer",
      offset: 0,
      detail: "bad signer sequence",
    });
  const signers: ApkSigner[] = [];
  for (const chunk of signerChunks) {
    const signedData = new LeReader(chunk).lenChunk();
    if (signedData === null)
      return err({
        kind: "malformed-signer",
        offset: 0,
        detail: "missing signed data",
      });
    const signer = decodeSignedData(signedData, version);
    if (signer === null)
      return err({
        kind: "malformed-signer",
        offset: 0,
        detail: "malformed signed data",
      });
    signers.push(signer);
  }
  return ok(signers);
};

/** One node of a v3 proof-of-rotation lineage (oldest first). */
export interface ApkLineageNode {
  /** X.509 certificate DER of the signer at this level. */
  readonly certificate: Uint8Array;
  /** Capability flags granted by this signer to the next (installed data, shared UID, …). */
  readonly flags: number;
}

/**
 * Decode the v3 proof-of-rotation attribute value (apksig
 * V3SigningCertificateLineage): `u32 version` then length-prefixed nodes, each
 * `lp(signedData{ lp(certificate), u32 sigAlgorithm }) | u32 flags |
 * u32 sigAlgorithm | lp(signature)`. Node signatures are not verified here.
 */
export const decodeRotationLineage = (
  value: Uint8Array,
): Result<ApkLineageNode[], ApkSchemeError> => {
  const reader = new LeReader(value);
  if (reader.u32() === null)
    return err({
      kind: "malformed-signer",
      offset: 0,
      detail: "lineage version missing",
    });
  const nodes: ApkLineageNode[] = [];
  while (reader.remaining > 0) {
    if (nodes.length >= MAX_ELEMENTS)
      return err({
        kind: "budget-exceeded",
        resource: "lineage-nodes",
        declared: nodes.length + 1,
      });
    const node = reader.lenChunk();
    if (node === null)
      return err({
        kind: "malformed-signer",
        offset: reader.offset,
        detail: "lineage node truncated",
      });
    const nodeReader = new LeReader(node);
    const signedData = nodeReader.lenChunk();
    const flags = nodeReader.u32();
    if (signedData === null || flags === null)
      return err({
        kind: "malformed-signer",
        offset: reader.offset,
        detail: "lineage node malformed",
      });
    const certificate = new LeReader(signedData).lenChunk();
    if (certificate === null)
      return err({
        kind: "malformed-signer",
        offset: reader.offset,
        detail: "lineage certificate missing",
      });
    nodes.push({ certificate, flags });
  }
  return ok(nodes);
};

/** Map a signature-algorithm id to the content-digest algorithm it uses. */
export const contentDigestAlgorithm = (
  algorithmId: number,
): "sha256" | "sha512" | "verity-sha256" | null => {
  switch (algorithmId) {
    case 0x0101: // RSASSA-PSS SHA2-256
    case 0x0103: // RSASSA-PKCS1-v1_5 SHA2-256
    case 0x0201: // ECDSA SHA2-256
    case 0x0301: // DSA SHA2-256
      return "sha256";
    case 0x0102: // RSASSA-PSS SHA2-512
    case 0x0104: // RSASSA-PKCS1-v1_5 SHA2-512
    case 0x0202: // ECDSA SHA2-512
      return "sha512";
    case 0x0421: // RSASSA-PKCS1-v1_5 SHA2-256 over the verity tree
    case 0x0423: // ECDSA SHA2-256 over the verity tree
      return "verity-sha256";
    default:
      return null;
  }
};
