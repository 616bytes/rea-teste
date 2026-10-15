/**
 * Public contract shape for `inspect_apk_signature` and the pure tamper-surface
 * posture derivation. The domain owns the schema so CLI and MCP present
 * identical, validated facts. Certificate facts are plain data extracted by the
 * adapter (via the platform X.509 parser); this module never parses DER itself.
 */
import { z } from "zod";

import type { EvidenceSubjectTarget } from "../evidence.js";
import { localPathStringSchema } from "../localPath.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** All artifacts are explicitly selected local files; references never trigger acquisition. */
export const inspectApkSignatureInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute selected local .apk/.zip/.aab (or .apks) to inspect for signing",
  ),
});
export type InspectApkSignatureInput = z.infer<
  typeof inspectApkSignatureInputSchema
>;

const certificate = z
  .strictObject({
    subject: z.string(),
    issuer: z.string(),
    serial_number: z.string(),
    not_before: z.string(),
    not_after: z.string(),
    public_key_algorithm: z.string().nullable(),
    sha256_fingerprint: digest,
  })
  .nullable();

const digestEntry = z.strictObject({
  algorithm: z.enum(["sha256", "sha512", "verity-sha256", "unknown"]),
  /** True/false when the content digest was recomputed; null when not computed. */
  matches_apk: z.boolean().nullable(),
});

const signer = z.strictObject({
  certificate,
  digests: z.array(digestEntry),
  min_sdk: z.number().int().nullable(),
  max_sdk: z.number().int().nullable(),
});

const signerV3 = signer.extend({
  // Presence of the proof-of-rotation attribute. Full lineage-node decode
  // (each previous signer certificate + its trust flags) is a layered follow-up
  // validated against apksigner's lineage output.
  rotation: z.strictObject({ present: z.boolean() }),
});

const SCHEME = z.enum(["none", "v1", "v2", "v3", "v3.1"]);

export const apkSignatureResultSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digest,
    bytes: z.number().int().nonnegative(),
  }),
  schemes: z.strictObject({
    v1: z.strictObject({
      present: z.boolean(),
      has_manifest: z.boolean(),
      signature_files: z.array(z.string()),
      block_files: z.array(z.string()),
    }),
    v2: z.strictObject({ present: z.boolean(), signers: z.array(signer) }),
    v3: z.strictObject({ present: z.boolean(), signers: z.array(signerV3) }),
    "v3.1": z.strictObject({
      present: z.boolean(),
      signers: z.array(signerV3),
    }),
  }),
  source_stamp: z.strictObject({ present: z.boolean(), certificate }),
  posture: z.strictObject({
    v1_only: z.boolean(),
    schemes_agree_on_signer: z.boolean().nullable(),
    rotation_present: z.boolean(),
    source_stamp_present: z.boolean(),
    strongest_scheme: SCHEME,
    self_consistent: z.boolean().nullable(),
  }),
  runtime_execution: z.literal("not-performed"),
  limitations: z.array(z.string()),
});
export type ApkSignatureResult = z.infer<typeof apkSignatureResultSchema>;

export const APK_SIGNATURE_LIMITATIONS: readonly string[] = [
  "Static structural inspection only. No Android code executes, no device or adb is involved, and odex/vdex/oat/cdex are not read.",
  "Identity and self-consistency, not trust: certificate facts and digest matches are reported, but signatures are NOT cryptographically verified and certificate chains, revocation and 'is this the real app' are NOT evaluated.",
  "self_consistent means the signed content digest matches the current bytes (the signature covers these bytes); it is not an authenticity verdict. SHA-256 identifies the exact bytes, not the producer.",
  "v1 signer certificates (PKCS#7), v4 .apk.idsig, and the X-Android-APK-Signed stripping marker (which would distinguish a stripped-v2 downgrade from a genuinely v1-only APK) are follow-ups and not parsed here.",
];

/** Inputs to the pure posture derivation (scheme presence + agreement facts). */
export interface ApkPostureInput {
  readonly v1Present: boolean;
  readonly v2Present: boolean;
  readonly v3Present: boolean;
  readonly v31Present: boolean;
  readonly sourceStampPresent: boolean;
  readonly rotationPresent: boolean;
  /** Distinct signing-certificate fingerprints observed across v2/v3 (and v1 when known). */
  readonly distinctSignerFingerprints: number;
  readonly selfConsistent: boolean | null;
}

/** Derive the conservative tamper-surface posture from observed scheme facts. */
export const deriveApkPosture = (
  input: ApkPostureInput,
): ApkSignatureResult["posture"] => {
  const blockPresent = input.v2Present || input.v3Present || input.v31Present;
  const strongest = input.v31Present
    ? "v3.1"
    : input.v3Present
      ? "v3"
      : input.v2Present
        ? "v2"
        : input.v1Present
          ? "v1"
          : "none";
  return {
    v1_only: input.v1Present && !blockPresent,
    schemes_agree_on_signer:
      input.distinctSignerFingerprints === 0
        ? null
        : input.distinctSignerFingerprints === 1,
    rotation_present: input.rotationPresent,
    source_stamp_present: input.sourceStampPresent,
    strongest_scheme: strongest,
    self_consistent: input.selfConsistent,
  };
};

/** The returned artifact identity must match the caller-selected local file. */
export const apkSignatureMatchesSubject = (
  artifact: ApkSignatureResult["artifact"],
  subject: EvidenceSubjectTarget,
): boolean =>
  artifact.sha256 === subject.sha256 &&
  artifact.path === subject.path &&
  (subject.format === "file" ||
    subject.format === "apk" ||
    subject.format === "zip");
