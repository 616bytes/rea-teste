import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApkSignatureProvider } from "./ApkSignatureProvider.js";

type Report = {
  schemes: Record<
    string,
    {
      present: boolean;
      signers?: {
        certificate: unknown;
        digests: { algorithm: string; matches_apk: boolean | null }[];
      }[];
    }
  >;
  posture: Record<string, unknown>;
};

const zipOf = async (names: readonly string[]): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const name of names) await writer.add(name, new TextReader("x"));
  return writer.close();
};

const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
];
const u64 = (v: number): number[] => [...u32(v), ...u32(0)];
const lp = (b: readonly number[]): number[] => [...u32(b.length), ...b];
const seq = (els: readonly (readonly number[])[]): number[] =>
  lp(els.flatMap((e) => lp(e)));

/** [entries][signing block with one v2 pair][central directory][EOCD]. */
const syntheticSigned = (
  v2Value: readonly number[],
  corruptLeadingSize = false,
): Uint8Array => {
  const entries = Array.from({ length: 64 }, (_, i) => i & 0xff);
  const pair = [...u64(4 + v2Value.length), ...u32(0x7109871a), ...v2Value];
  const size = pair.length + 8 + 16;
  const block = [
    ...u64(size),
    ...pair,
    ...u64(size),
    ...[..."APK Sig Block 42"].map((c) => c.charCodeAt(0)),
  ];
  if (corruptLeadingSize) block[0] = 0xff;
  const cd = [0x50, 0x4b, 0x01, 0x02, 0, 0, 0, 0];
  const cdOffset = entries.length + block.length;
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(cd.length),
    ...u32(cdOffset),
    ...u16(0),
  ];
  return Uint8Array.from([...entries, ...block, ...cd, ...eocd]);
};

/** A v2 value with one signer: bogus certificate bytes and a bogus SHA-256 digest. */
const bogusV2Value = (): number[] => {
  const digest = [
    ...u32(0x0103),
    ...lp(Array.from({ length: 32 }, () => 0xab)),
  ];
  const signedData = [
    ...seq([digest]),
    ...seq([[0x30, 0x03, 1, 2, 3]]),
    ...seq([]),
  ];
  return seq([lp(signedData)]);
};

let dir: string;
const provider = new ApkSignatureProvider();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rea-apk-sig-"));
});
afterAll(async () => {
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});
const write = async (
  name: string,
  bytes: Uint8Array | string,
): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
};
const reportOf = async (path: string): Promise<Report> => {
  const result = await provider.inspect({ path });
  if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
  return result.value.result as Report;
};

describe("ApkSignatureProvider without the Android SDK", () => {
  it("reports an unsigned ZIP as having no scheme", async () => {
    const r = await reportOf(
      await write(
        "unsigned.apk",
        await zipOf(["classes.dex", "AndroidManifest.xml"]),
      ),
    );
    expect(Object.values(r.schemes).some((s) => s.present)).toBe(false);
    expect(r.posture.strongest_scheme).toBe("none");
    expect(r.posture.self_consistent).toBeNull();
    expect(r.posture.v1_only).toBe(false);
  });

  it("detects v1-only signing from META-INF entries", async () => {
    const r = await reportOf(
      await write(
        "v1.apk",
        await zipOf([
          "classes.dex",
          "META-INF/MANIFEST.MF",
          "META-INF/CERT.SF",
          "META-INF/CERT.RSA",
        ]),
      ),
    );
    expect(r.schemes.v1!.present).toBe(true);
    expect(r.posture.v1_only).toBe(true);
    expect(r.posture.strongest_scheme).toBe("v1");
  });

  it("decodes a v2 signer, keeps an unparseable certificate null, and flags a digest mismatch", async () => {
    const r = await reportOf(
      await write("v2.apk", syntheticSigned(bogusV2Value())),
    );
    expect(r.schemes.v2!.present).toBe(true);
    const signer = r.schemes.v2!.signers![0]!;
    expect(signer.certificate).toBeNull();
    expect(signer.digests).toEqual([
      { algorithm: "sha256", matches_apk: false },
    ]);
    expect(r.posture.self_consistent).toBe(false);
  });

  it("refuses a non-ZIP file as an unsupported target", async () => {
    const result = await provider.inspect({
      path: await write("plain.bin", "not an archive at all"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
  });

  it("reports a malformed signing block as an input error", async () => {
    const result = await provider.inspect({
      path: await write("bad.apk", syntheticSigned(bogusV2Value(), true)),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisInputError");
  });
});
