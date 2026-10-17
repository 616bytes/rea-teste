import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LEAF_CERTIFICATE,
  organizationalUnits,
  signedDataBlock,
  signerInfo,
  withSubject,
} from "../../tests/fixtures/apkSignature/v1SignatureBlock.js";
import { decodeV1SignatureBlock } from "../domain/apkSignature/apkV1SignatureBlock.js";
import {
  projectedV1SignerBytes,
  v1SignerFacts,
  type DecodedV1Signer,
} from "./apkV1Signers.js";

const signerOf = (certificate: Uint8Array): DecodedV1Signer => {
  const decoded = decodeV1SignatureBlock(
    signedDataBlock({
      certificates: [certificate],
      signerInfos: [signerInfo({ names: certificate })],
    }),
  );
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.error));
  const name = "META-INF/CERT.RSA";
  return {
    entry: {
      signatureFile: "META-INF/CERT.SF",
      duplicate: null,
      block: {
        name,
        rawName: new TextEncoder().encode(name),
        flags: 0,
        method: 0,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        localHeaderOffset: 0,
      },
    },
    decoded,
  };
};

describe("v1 signer output projection", () => {
  it("is an upper bound when the named certificate's subject is all escapes", () => {
    // RFC 2253 escapes `"` as `\"`, 4 bytes once JSON-escaped, and the named
    // certificate's subject is serialized twice.
    const certificate = withSubject(
      LEAF_CERTIFICATE,
      organizationalUnits(64, '"'.repeat(64)),
    );
    expect(new X509Certificate(certificate).subject).toContain('\\"');
    const signer = signerOf(certificate);
    const facts = v1SignerFacts(signer);
    expect(facts.certificate?.subject).not.toBeNull();
    expect(projectedV1SignerBytes(signer)).toBeGreaterThanOrEqual(
      Buffer.byteLength(JSON.stringify(facts)),
    );
  });
});
