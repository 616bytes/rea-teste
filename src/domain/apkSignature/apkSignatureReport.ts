/**
 * Public contract shape for `inspect_apk_signature` and the pure signing
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

/**
 * A signer certificate. `sha256_fingerprint` is always SHA-256 over the raw
 * embedded DER (exactly what apksig/apksigner hash); the parsed X.509 facts are
 * individually null when the platform parser cannot read the DER. The whole
 * object is null only when the signer carries no certificate at all.
 */
const certificate = z
  .strictObject({
    sha256_fingerprint: digest,
    subject: z.string().nullable(),
    issuer: z.string().nullable(),
    serial_number: z.string().nullable(),
    /** ISO 8601. */
    not_before: z.string().nullable(),
    /** ISO 8601. */
    not_after: z.string().nullable(),
    public_key_algorithm: z.string().nullable(),
  })
  .nullable();

const digestEntry = z.strictObject({
  algorithm: z.enum(["sha256", "sha512", "verity-sha256", "unknown"]),
  /**
   * Whether the DECLARED content digest equals the digest recomputed over the
   * current bytes; null when not recomputed. Not a signature verification:
   * anyone who changes the bytes can recompute and replace the declared digest.
   */
  matches_apk: z.boolean().nullable(),
});

const signer = z.strictObject({
  certificate,
  digests: z.array(digestEntry),
  min_sdk: z.number().int().nullable(),
  max_sdk: z.number().int().nullable(),
});

const lineageNode = z.strictObject({
  certificate,
  /**
   * Raw capability flags RETAINED by this node's own certificate after the
   * rotation (kept raw so unknown future bits are preserved).
   */
  flags: z.number().int().nonnegative(),
  capabilities: z.strictObject({
    installed_data: z.boolean(),
    shared_uid: z.boolean(),
    permission: z.boolean(),
    rollback: z.boolean(),
    auth: z.boolean(),
  }),
});

const signerV3 = signer.extend({
  /**
   * The proof-of-rotation lineage the APK DECLARES, oldest signer first. Node
   * signatures are not verified. `decode_error` is set (and `lineage` empty)
   * when the attribute is present but could not be decoded.
   */
  rotation: z.strictObject({
    present: z.boolean(),
    lineage: z.array(lineageNode),
    decode_error: z.string().nullable(),
  }),
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
      /** Structural: META-INF signature files exist (not platform applicability). */
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
  /**
   * The source stamp the APK declares (V2 block preferred over V1, as apksig
   * does). `certificate` is the declared stamp certificate; it is null when no
   * stamp is present or when `decode_error` says why it could not be read.
   * Stamp signatures are not verified.
   */
  source_stamp: z.strictObject({
    present: z.boolean(),
    certificate,
    decode_error: z.string().nullable(),
  }),
  /** Derived from the observed and declared facts above; not separately observed. */
  posture: z.strictObject({
    /**
     * v1 present and no v2/v3/v3.1 block. The v1 X-Android-APK-Signed marker
     * is not read, so this cannot distinguish a v1-only APK from one whose
     * v2/v3 block was removed.
     */
    v1_only: z.boolean(),
    /**
     * Observed: every present block scheme (v2/v3/v3.1) presents the same set
     * of signer certificates. Null when no block scheme has a signer, or when
     * any signer carries no certificate (identity unknown).
     */
    schemes_agree_on_signer: z.boolean().nullable(),
    /**
     * Declared: the signers differ, but every one appears in a rotation
     * lineage the APK declares. Unverified — an APK can declare any lineage.
     * Null when a signer's identity is unknown, or when the signers differ and
     * a declared lineage could not be decoded.
     */
    signer_change_declared_by_rotation: z.boolean().nullable(),
    rotation_present: z.boolean(),
    source_stamp_present: z.boolean(),
    strongest_scheme: SCHEME,
    /**
     * Every recomputed declared content digest equals the current bytes; null
     * when none was recomputed. Not a signature verification.
     */
    self_consistent: z.boolean().nullable(),
  }),
  runtime_execution: z.literal("not-performed"),
});
export type ApkSignatureResult = z.infer<typeof apkSignatureResultSchema>;

export const APK_SIGNATURE_LIMITATIONS: readonly string[] = [
  "Static structural inspection only. No Android code executes, no device or adb is involved, and odex/vdex/oat/cdex are not read.",
  "No signature is verified: signer, rotation-lineage and source-stamp signatures are NOT cryptographically checked, and certificate chains, revocation and authenticity are NOT evaluated. Certificates and lineages are what the APK declares.",
  "matches_apk and self_consistent only show that the declared content digest equals the digest of the current bytes. This is not a signature verification: anyone who changes the bytes can recompute the digest and write it into the signed data. SHA-256 identifies the exact bytes, not the producer.",
  "Not read: v1 signer certificates (PKCS#7), v4 .apk.idsig, verity digests (matches_apk null), and the v1 X-Android-APK-Signed marker, so v1_only cannot distinguish a v1-only APK from one whose v2/v3 block was removed.",
];

/** Inputs to the pure posture derivation (scheme presence + agreement facts). */
export interface ApkPostureInput {
  readonly v1Present: boolean;
  readonly v2Present: boolean;
  readonly v3Present: boolean;
  readonly v31Present: boolean;
  readonly sourceStampPresent: boolean;
  readonly rotationPresent: boolean;
  /**
   * Per present block scheme, the fingerprint of every signer's certificate;
   * `null` for a signer that carries no certificate (identity unknown).
   */
  readonly schemeSignerFingerprints: readonly (readonly (string | null)[])[];
  /** Fingerprints of every certificate in the declared v3/v3.1 rotation lineage(s). */
  readonly lineageFingerprints: readonly string[];
  /** True when any declared v3/v3.1 lineage could not be decoded. */
  readonly lineageUnknown: boolean;
  readonly selfConsistent: boolean | null;
}

const setKey = (fingerprints: readonly string[]): string =>
  [...new Set(fingerprints)].sort().join(",");

/** Unknown signer identity or an undecoded lineage can hide the answer. */
const signerChangeDeclared = (
  identityUnknown: boolean,
  signers: ReadonlySet<string>,
  lineage: ReadonlySet<string>,
  lineageUnknown: boolean,
): boolean | null => {
  if (identityUnknown) return null;
  if (signers.size <= 1) return false;
  if ([...signers].every((fp) => lineage.has(fp))) return true;
  return lineageUnknown ? null : false;
};

/** Derive the conservative signing posture from observed and declared scheme facts. */
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
  const sets = input.schemeSignerFingerprints.filter((fps) => fps.length > 0);
  // A signer without a certificate has unknown identity: agreement is unknown,
  // never assumed.
  const identityUnknown = sets.some((fps) => fps.includes(null));
  const known = sets.map((fps) =>
    fps.filter((fp): fp is string => fp !== null),
  );
  const union = new Set(known.flat());
  const lineage = new Set(input.lineageFingerprints);
  return {
    v1_only: input.v1Present && !blockPresent,
    schemes_agree_on_signer:
      sets.length === 0 || identityUnknown
        ? null
        : new Set(known.map(setKey)).size === 1,
    signer_change_declared_by_rotation: signerChangeDeclared(
      identityUnknown,
      union,
      lineage,
      input.lineageUnknown,
    ),
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
