import { createHash, X509Certificate } from "node:crypto";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  ApkSignatureExecution,
  ApkSignaturePort,
} from "../application/apkSignature/ApkSignaturePort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  APK_BLOCK_ID,
  locateApkSigningBlock,
  parseZipTail,
  type ApkSigningBlock,
  type ZipTail,
} from "../domain/apkSignature/apkSigningBlock.js";
import {
  contentDigestAlgorithm,
  decodeSigners,
  PROOF_OF_ROTATION_ATTR_ID,
  type ApkSchemeVersion,
  type ApkSigner,
} from "../domain/apkSignature/apkSignatureSchemes.js";
import {
  APK_SIGNATURE_LIMITATIONS,
  apkSignatureResultSchema,
  deriveApkPosture,
  type ApkSignatureResult,
} from "../domain/apkSignature/apkSignatureReport.js";
import {
  computeApkContentDigest,
  type HashFactory,
} from "../domain/apkSignature/apkContentDigest.js";
import {
  centralDirectoryNames,
  detectV1Signature,
} from "../domain/apkSignature/apkV1Signature.js";
import { err, ok, type Result } from "../domain/result.js";
import { zipPackageFormatForPath } from "../domain/zipPackageFormat.js";
import {
  apkSignatureFailure,
  mapApkBlockError,
} from "./apkSignatureFailures.js";
import {
  APK_SIGNATURE_LIMITS,
  APK_SIGNATURE_PROVIDER_IDENTITY,
} from "./ApkSignatureRelease.js";

const OPERATION = "inspect_apk_signature";

type Certificate =
  ApkSignatureResult["schemes"]["v2"]["signers"][number]["certificate"];
type Signer = ApkSignatureResult["schemes"]["v2"]["signers"][number];
type SignerV3 = ApkSignatureResult["schemes"]["v3"]["signers"][number];

/** Extract plain certificate facts from DER via the platform X.509 parser. */
const certificateFacts = (der: Uint8Array): Certificate => {
  try {
    const cert = new X509Certificate(Buffer.from(der));
    return {
      subject: cert.subject,
      issuer: cert.issuer,
      serial_number: cert.serialNumber,
      not_before: cert.validFrom,
      not_after: cert.validTo,
      public_key_algorithm: cert.publicKey.asymmetricKeyType ?? null,
      sha256_fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
    };
  } catch {
    return null;
  }
};

/** Compares a signed digest with the recomputed content digest; null when not computable. */
type DigestMatcher = (
  algorithmId: number,
  signed: Uint8Array,
) => boolean | null;

const nodeHash: HashFactory = (algorithm) => {
  const hash = createHash(algorithm);
  return {
    update: (data) => {
      hash.update(data);
    },
    digest: () => new Uint8Array(hash.digest()),
  };
};

/** Recompute each content digest at most once per algorithm, lazily. */
const digestMatcher = (
  bytes: Uint8Array,
  tail: ZipTail,
  blockStart: number | null,
): DigestMatcher => {
  const cache = new Map<"sha256" | "sha512", Uint8Array | null>();
  return (algorithmId, signed) => {
    const algorithm = contentDigestAlgorithm(algorithmId);
    // verity (fs-verity Merkle) digests and unknown algorithms are not recomputed.
    if (
      blockStart === null ||
      (algorithm !== "sha256" && algorithm !== "sha512")
    )
      return null;
    if (!cache.has(algorithm))
      cache.set(
        algorithm,
        computeApkContentDigest(
          bytes,
          { tail, blockStart, algorithm },
          nodeHash,
        ),
      );
    const computed = cache.get(algorithm) ?? null;
    return computed === null ? null : Buffer.from(computed).equals(signed);
  };
};

const digestsOf = (
  signer: ApkSigner,
  match: DigestMatcher,
): Signer["digests"] =>
  signer.digests.map((d) => ({
    algorithm: contentDigestAlgorithm(d.algorithmId) ?? "unknown",
    matches_apk: match(d.algorithmId, d.digest),
  }));

const baseSigner = (signer: ApkSigner, match: DigestMatcher): Signer => ({
  certificate: signer.certificates[0]
    ? certificateFacts(signer.certificates[0])
    : null,
  digests: digestsOf(signer, match),
  min_sdk: signer.minSdk,
  max_sdk: signer.maxSdk,
});

const v3Signer = (signer: ApkSigner, match: DigestMatcher): SignerV3 => ({
  ...baseSigner(signer, match),
  rotation: {
    present: signer.attributes.some((a) => a.id === PROOF_OF_ROTATION_ATTR_ID),
  },
});

/** All recomputed digests agree → true; any mismatch → false; none computed → null. */
const selfConsistency = (
  signers: readonly { readonly digests: Signer["digests"] }[],
): boolean | null => {
  const results = signers
    .flatMap((s) => s.digests.map((d) => d.matches_apk))
    .filter((m): m is boolean => m !== null);
  if (results.length === 0) return null;
  return results.every(Boolean);
};

/** Read exactly the selected APK bytes and report its signature schemes. */
export class ApkSignatureProvider implements ApkSignaturePort {
  close(): Promise<void> {
    return Promise.resolve();
  }

  async inspect(
    input: { readonly path: string },
    options?: ExecutionOptions,
  ): Promise<Result<ApkSignatureExecution, AnalysisError>> {
    try {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      const selected = await readStableArtifact(
        input.path,
        APK_SIGNATURE_LIMITS.inputBytes,
        options?.signal,
      );
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      return this.#analyze(selected.bytes, {
        path: input.path,
        sha256: selected.sha256,
        bytes: selected.bytes.length,
      });
    } catch (cause: unknown) {
      return err(apkSignatureFailure(cause, input.path));
    }
  }

  #analyze(
    bytes: Uint8Array,
    artifact: { path: string; sha256: string; bytes: number },
  ): Result<ApkSignatureExecution, AnalysisError> {
    const tail = parseZipTail(bytes);
    if (!tail.ok) return err(mapApkBlockError(tail.error, artifact.path));
    const block = locateApkSigningBlock(bytes, tail.value);
    if (!block.ok) return err(mapApkBlockError(block.error, artifact.path));

    const names = centralDirectoryNames(
      bytes,
      tail.value.centralDirectoryOffset,
      tail.value.centralDirectorySize,
      tail.value.totalEntries,
    );
    const v1 = detectV1Signature(names.ok ? names.value : []);

    const v2 = this.#decodeScheme(block.value, APK_BLOCK_ID.signatureV2, "v2");
    if (!v2.ok) return err(v2.error);
    const v3 = this.#decodeScheme(block.value, APK_BLOCK_ID.signatureV3, "v3");
    if (!v3.ok) return err(v3.error);
    const v31 = this.#decodeScheme(
      block.value,
      APK_BLOCK_ID.signatureV31,
      "v3",
    );
    if (!v31.ok) return err(v31.error);

    const match = digestMatcher(
      bytes,
      tail.value,
      block.value?.blockStart ?? null,
    );
    const v2signers = v2.value.signers.map((s) => baseSigner(s, match));
    const v3signers = v3.value.signers.map((s) => v3Signer(s, match));
    const v31signers = v31.value.signers.map((s) => v3Signer(s, match));

    const sourceStampPresent =
      block.value !== null &&
      block.value.pairs.some(
        (p) =>
          p.id === APK_BLOCK_ID.sourceStampV1 ||
          p.id === APK_BLOCK_ID.sourceStampV2,
      );
    const rotationPresent = [...v3signers, ...v31signers].some(
      (s) => s.rotation.present,
    );
    const fingerprints = new Set(
      [v2signers, v3signers, v31signers]
        .map((signers) => signers[0]?.certificate?.sha256_fingerprint)
        .filter((fp): fp is string => typeof fp === "string"),
    );

    const result: ApkSignatureResult = {
      artifact,
      schemes: {
        v1: {
          present: v1.present,
          has_manifest: v1.hasManifest,
          signature_files: [...v1.signatureFiles],
          block_files: [...v1.blockFiles],
        },
        v2: { present: v2.value.present, signers: v2signers },
        v3: { present: v3.value.present, signers: v3signers },
        "v3.1": { present: v31.value.present, signers: v31signers },
      },
      source_stamp: { present: sourceStampPresent, certificate: null },
      posture: deriveApkPosture({
        v1Present: v1.present,
        v2Present: v2.value.present,
        v3Present: v3.value.present,
        v31Present: v31.value.present,
        sourceStampPresent,
        rotationPresent,
        distinctSignerFingerprints: fingerprints.size,
        selfConsistent: selfConsistency([
          ...v2signers,
          ...v3signers,
          ...v31signers,
        ]),
      }),
      runtime_execution: "not-performed",
      limitations: [...APK_SIGNATURE_LIMITATIONS],
    };

    const parsed = apkSignatureResultSchema.safeParse(result);
    if (!parsed.success)
      return err(apkSignatureFailure(parsed.error, artifact.path));
    const format =
      (zipPackageFormatForPath(artifact.path) ?? "zip") === "apk"
        ? "apk"
        : "zip";
    return ok(
      createAnalysisExecution(parsed.data, APK_SIGNATURE_PROVIDER_IDENTITY, {
        subject: { path: artifact.path, format, sha256: artifact.sha256 },
        locations: [{ kind: "artifact-path", path: artifact.path }],
        limitations: parsed.data.limitations,
      }) as ApkSignatureExecution,
    );
  }

  #decodeScheme(
    block: ApkSigningBlock | null,
    id: number,
    version: ApkSchemeVersion,
  ): Result<
    { present: boolean; signers: readonly ApkSigner[] },
    AnalysisError
  > {
    const pair = block?.pairs.find((p) => p.id === id);
    if (pair === undefined) return ok({ present: false, signers: [] });
    const signers = decodeSigners(pair.value, version);
    if (!signers.ok)
      return err(
        apkSignatureFailure(
          new Error(`malformed ${version} signer: ${signers.error.kind}`),
          "",
        ),
      );
    return ok({ present: true, signers: signers.value });
  }
}
