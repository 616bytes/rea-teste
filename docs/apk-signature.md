# APK signature schemes

REA reads the signing of a selected local Android APK (or ZIP/AAB) statically,
so an analyst can answer **who signed this, under which schemes, and whether the
declared content digests match these bytes** before trusting or triaging it. The reader
is in-process and needs no external engine: it parses the ZIP tail and the APK
Signing Block, reads certificates with the platform X.509 parser, and
recomputes the content digest. No Android code executes, and no device or
`adb` is involved.

CLI and MCP share one workflow and return artifact-bound Evidence inline.

```sh
rea inspect-apk-signature /path/app.apk
```

## What it reports

- **Schemes present:** v1 (JAR signing, from the central directory), and the
  APK Signing Block's v2, v3 and v3.1. v1 follows apksig's selection: entries
  under `META-INF/` at any depth ending in `.SF`, or in `.RSA`/`.DSA`/`.EC`
  (case-sensitive). v1 is `present` only when a signature block has its
  matching `.SF` file (`META-INF/x/CERT.RSA` pairs with `META-INF/x/CERT.SF`);
  `signature_files` and `block_files` list every candidate either way.
- **Per v1 signer** (each block paired with its `.SF`): REA inflates the block
  and reads its PKCS#7 `SignedData`. `certificate` is the certificate the
  block's one `SignerInfo` names by `issuerAndSerialNumber` or
  `subjectKeyIdentifier` (not by position), with the same facts and raw-DER
  SHA-256 as a v2/v3 signer, so a v1-only APK can be fingerprinted and
  clustered with v2/v3-signed ones. `certificates` lists every certificate the
  block carries (SHA-256 and subject) and `signer_infos` gives each
  `SignerInfo`'s certificate and digest/signature algorithm OIDs.
  `certificate` is `null` when the block has more than one `SignerInfo` (with
  nothing verified there is no single signer) or names a certificate it does
  not carry. A block that cannot be read (malformed DER, an unsupported
  compression method, Zip64 sizes, an encrypted entry, a local header that
  disagrees with the central directory on the name, data-descriptor flag,
  CRC-32 or a size, as apksig refuses it, or over a bound) keeps its names
  and carries `decode_error`; it is never reported as an absent signer.
  A signing name (`MANIFEST.MF`, `.SF` or a block) the central directory
  holds more than once, which apksig rejects as a "Duplicate entry", leaves
  one signer per block name with `decode_error` `duplicate entry: <name>`,
  and a limitation names the duplicates; other entries are not checked.
  Bytes after the block's `ContentInfo` are ignored, as apksig's BER parser
  ignores them, and a limitation names the block and their count.
- **Per signer:** the certificate's **SHA-256 fingerprint over the raw embedded
  DER** (the same value `apksigner --print-certs` prints), plus subject, issuer,
  serial, ISO 8601 validity and public-key algorithm when the X.509 parser can
  read them (each is `null` otherwise); declared digest algorithms; and for
  v3/v3.1 the bound min/max SDK.
- **Key rotation (v3/v3.1):** the declared proof-of-rotation lineage, oldest
  first. Each node carries its certificate and the capability flags **retained
  by that node's own certificate** after rotation (installed data, shared UID,
  permission, rollback, auth). A lineage attribute that cannot be decoded is
  reported with `decode_error`, never silently emptied.
- **Source stamp:** whether a source-stamp block is present and the stamp
  certificate it declares (the V2 stamp block is preferred over V1, as apksig
  does). `certificate` is `null` when no stamp is present, or when the block
  could not be decoded and `decode_error` says why. Stamp signatures are not
  verified.
- **Declared digest consistency:** for SHA-256/SHA-512 digests, REA recomputes
  the v2/v3 content digest and reports `matches_apk` per digest and
  `posture.self_consistent`. This only shows that the **declared** digest
  equals the digest of the current bytes. It is **not a signature
  verification**: anyone who changes the bytes can recompute the digest and
  write it into the signed data, and REA still reports `true` while
  `apksigner verify` rejects the APK. A changed byte with an unchanged
  declared digest reads `false`.
- **Posture** (derived from the facts above):
  - `v1_only`: v1 is present and no v2/v3/v3.1 block is. The v1
    `X-Android-APK-Signed` marker is not read, so this cannot distinguish an
    APK signed only with v1 from one whose v2/v3 block was removed.
  - `schemes_agree_on_signer` (observed): every present block scheme presents
    the same _set_ of signer certificates. An extra signer in one scheme is
    disagreement; a signer without a certificate makes it `null` (unknown).
    Build-tools 33+ rotate through v3.1 by default, so a rotated app usually
    reads `false` here and `true` below.
  - `signer_change_declared_by_rotation` (declared): the signers differ, but
    each appears in a lineage the APK declares. Read the two together: a
    rotated APK shows `false` / `true`; signers that differ with no declared
    lineage containing them show `false` / `false`. It is `null` when a
    signer's identity is unknown, or when the signers differ and a declared
    lineage could not be decoded.
  - `v1_signers_match_block_signers` (observed): the v1 signer certificates
    equal what the lowest block scheme that has signers (v2, else v3, else
    v3.1) expects v1 to carry. That is its signer set, except that a v3/v3.1
    signer declaring a rotation lineage expects the lineage's first
    (original) certificate, as apksig requires. `false` is notable: the JAR
    signature names a different key than the block signature. A key rotation
    keeps v1 (and v2) on the original key, so it reads `true` while
    `schemes_agree_on_signer` reads `false`, with or without v2. `null` when
    v1 or a block scheme is absent, any signer's identity is unknown (a
    `decode_error` or a `null` certificate), or the lineage's original
    certificate cannot be identified; a limitation then says why.
  - `strongest_scheme`, `rotation_present`, `source_stamp_present`,
    `self_consistent`.

## What it does not claim

This is **declared identity and digest consistency, not trust**. No signature
is cryptographically verified (including the v1 PKCS#7 signature and the
`.SF`/`MANIFEST.MF` digests, so a v1 signer is reported even where `keytool`
or `apksigner` reject the archive), certificate chains and revocation are not
evaluated, and nothing here says an app is authentic. `self_consistent: true`
means the declared digest equals the digest of the current bytes; it is not a
signature verification, and it does not prove who made the bytes. Rotation-lineage node signatures are not verified either, so a lineage is
what the APK _declares_: an attacker who re-signs an APK can declare any
lineage, which is why `signer_change_declared_by_rotation` is kept apart from
the observed agreement. SHA-256 identifies exact bytes, not authenticity.

Not yet read: v4 `.apk.idsig` (a sibling file), verity (`0x0421`/`0x0423`/`0x0425`) digests (reported with
`matches_apk: null`), and the v1 `X-Android-APK-Signed` marker.

## Bounds and errors

The archive is read once, bounded at 512 MiB, without following symlinks and
with change detection. Every size and offset in the ZIP tail and signing block
is checked against the buffer before use. Signers per scheme, v1 signers and
lineage nodes are capped at 32 each (real APKs use a handful; apksig accepts
at most 10 v1 signers). Each v1 block is inflated to at most 1 MiB, and its DER
is read within 32 levels of nesting and 65,536 elements, with at most 32
certificates and 32 `SignerInfo`s; BER indefinite lengths are accepted. The report's size is
estimated from those counts before anything is materialised, and the exact
serialized size is then checked against an 8 MiB output budget (the exact check
is authoritative); an over-budget report is refused, not truncated.

Peak memory is about 2.5 times the file size: the shared stable reader keeps
its read chunks and then concatenates them. A 500 MiB APK measured 1.25 GiB
peak resident memory through the CLI, so an archive at the 512 MiB cap needs
about 1.3 GB.

A file that is not a ZIP is refused as an unsupported target. A damaged ZIP
(local headers but no end-of-central-directory), a central directory that
cannot be walked or whose declared record count does not account for all of
its bytes, or a malformed signing block or signer is an input error naming the
scheme and reason. When the central directory is not immediately followed by
the end-of-central-directory record (a declared-size mismatch or a Zip64
record), the content digest is not recomputed and a limitation says so. A
rotation attribute that cannot be decoded still counts as `rotation_present`
(the attribute exists) and carries its `decode_error`.

Verified by the `verify:apk-signature` real lane. It builds a real minimal APK
with `aapt2`, signs it with the SDK's `apksigner` (default v2+v3, v1-only with
RSA and EC keys, v1+v2+v3 on a legacy target, a rotated key lineage with and
without v1, rotation carried by v3.1, a source stamp, and a copy
with one changed byte), and cross-checks REA against
`apksigner verify --print-certs`, `apksigner lineage --print-certs` and
`keytool -printcert -jarfile` through the CLI and MCP.
