import { X509Certificate } from "node:crypto";

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

const digestsOf = (signer: ApkSigner): Signer["digests"] =>
  signer.digests.map((d) => ({
    algorithm: contentDigestAlgorithm(d.algorithmId) ?? "unknown",
    matches_apk: null, // content-digest self-consistency is a layered follow-up
  }));

const baseSigner = (signer: ApkSigner): Signer => ({
  certificate: signer.certificates[0]
    ? certificateFacts(signer.certificates[0])
    : null,
  digests: digestsOf(signer),
  min_sdk: signer.minSdk,
  max_sdk: signer.maxSdk,
});

const v3Signer = (signer: ApkSigner): SignerV3 => ({
  ...baseSigner(signer),
  rotation: {
    present: signer.attributes.some((a) => a.id === PROOF_OF_ROTATION_ATTR_ID),
  },
});

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

    const v2signers = v2.value.signers.map((s) => baseSigner(s));
    const v3signers = v3.value.signers.map((s) => v3Signer(s));
    const v31signers = v31.value.signers.map((s) => v3Signer(s));

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
        selfConsistent: null,
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
