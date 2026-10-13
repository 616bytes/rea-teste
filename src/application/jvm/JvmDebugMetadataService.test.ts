import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JvmDebugMetadataService } from "./JvmDebugMetadataService.js";
import { JvmClassFileProvider } from "../../jvm/JvmClassFileProvider.js";
import { CONSTANT_TAG } from "../../domain/jvm/javaClassFile.js";

class Blob {
  readonly parts: number[] = [];
  u1(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u2(v: number): this {
    this.parts.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  u4(v: number): this {
    this.parts.push(
      (v >>> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff,
    );
    return this;
  }
  utf8(text: string): this {
    const b = [...text].map((c) => c.charCodeAt(0));
    this.u2(b.length);
    this.parts.push(...b);
    return this;
  }
}

/** Minimal `Example` class: `<init>()V` with a Code attribute, class-level SourceFile. */
const minimalClass = (): Uint8Array =>
  Uint8Array.from(
    new Blob()
      .u4(0xcafebabe)
      .u2(0)
      .u2(52)
      .u2(8)
      .u1(CONSTANT_TAG.utf8)
      .utf8("<init>")
      .u1(CONSTANT_TAG.utf8)
      .utf8("()V")
      .u1(CONSTANT_TAG.utf8)
      .utf8("Code")
      .u1(CONSTANT_TAG.utf8)
      .utf8("SourceFile")
      .u1(CONSTANT_TAG.utf8)
      .utf8("Example.java")
      .u1(CONSTANT_TAG.utf8)
      .utf8("Example")
      .u1(CONSTANT_TAG.class)
      .u2(6)
      .u2(0x0021)
      .u2(7)
      .u2(0)
      .u2(0)
      .u2(0)
      .u2(1)
      .u2(0x0001)
      .u2(1)
      .u2(2)
      .u2(1)
      .u2(3)
      .u4(0)
      .u2(1)
      .u2(4)
      .u4(2)
      .u2(5).parts,
  );

describe("JvmDebugMetadataService", () => {
  let dir: string;
  const service = new JvmDebugMetadataService(new JvmClassFileProvider());

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rea-jvm-"));
  });
  afterAll(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns Evidence with the selected identity and decoded class facts", async () => {
    const path = join(dir, "Example.class");
    await writeFile(path, minimalClass());
    const result = await service.inspect({ path });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.value.normalized_result as Record<
      string,
      unknown
    >;
    expect((normalized.artifact as { path: string }).path).toBe(path);
    expect((normalized.class as { internal_name: string }).internal_name).toBe(
      "Example",
    );
    expect((normalized.source_file as { name: string }).name).toBe(
      "Example.java",
    );
    expect(result.value.subject?.digest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a relative path before any read", async () => {
    const result = await service.inspect({ path: "Example.class" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("reports an unsupported target when magic is not a class file", async () => {
    const path = join(dir, "notclass.bin");
    await writeFile(path, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const result = await service.inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
  });

  it("maps a missing file to an input error, not a producer fault", async () => {
    const result = await service.inspect({ path: join(dir, "absent.class") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisInputError");
  });
});
