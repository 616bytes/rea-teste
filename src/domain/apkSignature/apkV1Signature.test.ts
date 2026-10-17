import { describe, expect, it } from "vitest";

import {
  centralDirectoryV1SignatureEntries,
  detectV1Signature,
  localEntryData,
  MAX_V1_SIGNATURE_ENTRIES,
  type ApkV1Entry,
} from "./apkV1Signature.js";

/** A central-directory entry with no stored data. */
const entry = (name: string): ApkV1Entry => ({
  name,
  method: 0,
  compressedSize: 0,
  uncompressedSize: 0,
  localHeaderOffset: 0,
});
const entries = (names: readonly string[]): ApkV1Entry[] => names.map(entry);

/** A central-directory file header (46 fixed bytes) for one entry name. */
const cdRecord = (name: string): number[] => {
  const nameBytes = [...name].map((c) => c.charCodeAt(0));
  const buf = new Uint8Array(46);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x02014b50, true); // signature
  view.setUint16(28, nameBytes.length, true); // file name length
  return [...buf, ...nameBytes];
};

const centralDirectory = (names: readonly string[]): Uint8Array =>
  Uint8Array.from(names.flatMap((name) => cdRecord(name)));

describe("APK v1 (JAR) signature detection", () => {
  const names = [
    "AndroidManifest.xml",
    "classes.dex",
    "META-INF/MANIFEST.MF",
    "META-INF/CERT.SF",
    "META-INF/CERT.RSA",
  ];

  it("walks every record and keeps the META-INF signing names at any depth", () => {
    const all = [
      ...names,
      "META-INF/services/x.Y",
      "META-INF/sub/S.SF",
      "META-INF/sub/S.EC",
      "lib/META-INF/z.SF",
    ];
    const bytes = centralDirectory(all);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length,
      all.length,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((e) => e.name)).toEqual([
      "META-INF/MANIFEST.MF",
      "META-INF/CERT.SF",
      "META-INF/CERT.RSA",
      "META-INF/sub/S.SF",
      "META-INF/sub/S.EC",
    ]);
  });

  it("pairs signature files and blocks as apksig does", () => {
    expect(
      detectV1Signature(
        entries(["META-INF/sub/CERT.SF", "META-INF/sub/CERT.DSA"]),
      ),
    ).toEqual({
      present: true,
      hasManifest: false,
      signatureFiles: ["META-INF/sub/CERT.SF"],
      blockFiles: ["META-INF/sub/CERT.DSA"],
      signers: [
        {
          signatureFile: "META-INF/sub/CERT.SF",
          block: entry("META-INF/sub/CERT.DSA"),
        },
      ],
    });
    // A block without its own .SF partner is not a v1 signer.
    expect(
      detectV1Signature(
        entries([
          "META-INF/MANIFEST.MF",
          "META-INF/RSA1.SF",
          "META-INF/OTHER.RSA",
        ]),
      ).present,
    ).toBe(false);
    // Suffixes are case-sensitive.
    expect(
      detectV1Signature(entries(["META-INF/CERT.sf", "META-INF/CERT.rsa"]))
        .present,
    ).toBe(false);
  });

  it("refuses more META-INF signing entries than a signed archive needs", () => {
    const many = Array.from(
      { length: MAX_V1_SIGNATURE_ENTRIES + 1 },
      (_, i) => `META-INF/F${String(i)}.SF`,
    );
    const bytes = centralDirectory(many);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length,
      many.length,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "budget-exceeded",
      resource: "v1-signature-entries",
      limit: MAX_V1_SIGNATURE_ENTRIES,
    });
  });

  it("detects a v1-signed APK from its META-INF files", () => {
    const bytes = centralDirectory(names);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length,
      names.length,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v1 = detectV1Signature(result.value);
    expect(v1).toMatchObject({
      present: true,
      hasManifest: true,
      signatureFiles: ["META-INF/CERT.SF"],
      blockFiles: ["META-INF/CERT.RSA"],
      signers: [{ signatureFile: "META-INF/CERT.SF" }],
    });
  });

  it("refuses a directory that ends before its declared record count", () => {
    const bytes = centralDirectory(names);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length - 3,
      names.length,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed-central-directory");
  });

  it("refuses an under-declared record count instead of hiding entries", () => {
    const bytes = centralDirectory(names);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length,
      1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "malformed-central-directory",
      detail: expect.stringContaining("remain after 1 records") as string,
    });
  });

  it("reports absent v1 signing when no META-INF signature files exist", () => {
    const v1 = detectV1Signature(
      entries(["classes.dex", "res/layout/main.xml"]),
    );
    expect(v1.present).toBe(false);
    expect(v1.signatureFiles).toEqual([]);
  });
});

describe("APK v1 signature block locations", () => {
  it("keeps each record's data location for its signature block", () => {
    const record = cdRecord("META-INF/CERT.RSA");
    const view = new DataView(Uint8Array.from(record).buffer);
    view.setUint16(10, 8, true);
    view.setUint32(20, 70, true);
    view.setUint32(24, 90, true);
    view.setUint32(42, 1234, true);
    const bytes = new Uint8Array(view.buffer);
    const result = centralDirectoryV1SignatureEntries(
      bytes,
      0,
      bytes.length,
      1,
    );
    expect(result.ok && result.value).toEqual([
      {
        name: "META-INF/CERT.RSA",
        method: 8,
        compressedSize: 70,
        uncompressedSize: 90,
        localHeaderOffset: 1234,
      },
    ]);
  });

  it("locates stored data through the local header, within the entry region", () => {
    const local = new Uint8Array(30 + 3 + 4);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(26, 3, true);
    local.set([9, 8, 7, 6], 33);
    const block = { ...entry("META-INF/A.RSA"), compressedSize: 4 };
    const found = localEntryData(local, block, local.length);
    expect(found.ok && [...found.value]).toEqual([9, 8, 7, 6]);
    expect(localEntryData(local, block, local.length - 1)).toEqual({
      ok: false,
      error: { detail: "entry data at byte 33 runs past the entries" },
    });
    expect(
      localEntryData(local, { ...block, localHeaderOffset: 1 }, local.length),
    ).toMatchObject({ ok: false });
    expect(
      localEntryData(
        local,
        { ...block, compressedSize: 0xffffffff },
        local.length,
      ),
    ).toEqual({
      ok: false,
      error: { detail: "Zip64 entry sizes are not read" },
    });
  });
});
