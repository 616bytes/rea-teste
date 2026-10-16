import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DexFileProvider } from "./DexFileProvider.js";
import { debuggableDex, zipArchive } from "../../tests/fixtures/dexFile.js";

let dir: string;
const provider = new DexFileProvider();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rea-dex-"));
});
afterAll(async () => {
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});

const write = async (name: string, bytes: Uint8Array): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
};

describe("DexFileProvider loose .dex", () => {
  it("summarizes a loose dex with readiness present", async () => {
    const result = await provider.inspect({
      path: await write("a.dex", debuggableDex()),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as Record<string, unknown>;
    expect(r.container).toBe("dex-file");
    expect(r.mode).toBe("summary");
    const members = r.members as {
      entry: null;
      summary: { readiness: string };
    }[];
    expect(members).toHaveLength(1);
    expect(members[0]!.entry).toBeNull();
    expect(members[0]!.summary.readiness).toBe("present");
  });

  it("returns full per-method detail for a selected class", async () => {
    const result = await provider.inspect({
      path: await write("b.dex", debuggableDex()),
      class_descriptor: "Lcom/example/Foo;",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as {
      mode: string;
      class_detail: {
        source_file: string;
        methods: {
          name: string;
          descriptor: string;
          locals: { name: string | null; type: string | null }[];
        }[];
      };
    };
    expect(r.mode).toBe("class-detail");
    expect(r.class_detail.source_file).toBe("Foo.java");
    const method = r.class_detail.methods[0]!;
    expect(method.name).toBe("run");
    expect(method.descriptor).toBe("(I)V");
    // The implicit parameter local is seeded and resolved (regression guard).
    expect(method.locals).toContainEqual(
      expect.objectContaining({ name: "x", type: "I" }),
    );
  });

  it("refuses a class descriptor not present", async () => {
    const result = await provider.inspect({
      path: await write("c.dex", debuggableDex()),
      class_descriptor: "LNope;",
    });
    expect(result.ok).toBe(false);
  });
});

describe("DexFileProvider APK selection", () => {
  it("refuses an encrypted root member instead of silently skipping it", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("classes.dex", new Uint8ArrayReader(debuggableDex()), {
      password: "secret",
    });
    await writer.add("classes2.dex", new Uint8ArrayReader(debuggableDex()));
    const result = await provider.inspect({
      path: await write("encrypted.apk", await writer.close()),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
    expect(result.error.message).toContain("classes.dex");
  });

  it("summarizes every root classes*.dex when no entry is given", async () => {
    const apk = await write(
      "app.apk",
      await zipArchive([
        { name: "classes.dex", bytes: debuggableDex() },
        { name: "classes2.dex", bytes: debuggableDex() },
        { name: "res/raw/note.txt", bytes: Uint8Array.from([1, 2, 3]) },
      ]),
    );
    const result = await provider.inspect({ path: apk });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as {
      container: string;
      members: { entry: string }[];
    };
    expect(r.container).toBe("apk");
    expect(r.members.map((m) => m.entry)).toEqual([
      "classes.dex",
      "classes2.dex",
    ]);
  });

  it("auto-loads members by their stored name, as ART does", async () => {
    const dotted = await write(
      "dotted.apk",
      await zipArchive([
        { name: "./classes.dex", bytes: debuggableDex() },
        { name: "classes.dex", bytes: debuggableDex() },
      ]),
    );
    const result = await provider.inspect({ path: dotted });
    // Only the plain stored name loads; `./classes.dex` is not ambiguous with it.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as { members: { entry: string }[] };
    expect(r.members.map((m) => m.entry)).toEqual(["classes.dex"]);
    const onlyDotted = await provider.inspect({
      path: await write(
        "only-dotted.apk",
        await zipArchive([{ name: "./classes.dex", bytes: debuggableDex() }]),
      ),
    });
    expect(onlyDotted.ok).toBe(false);
  });

  it("reports bytes after file_size as unread instead of refusing the DEX", async () => {
    const dex = debuggableDex();
    const padded = new Uint8Array(dex.length + 5);
    padded.set(dex);
    const result = await provider.inspect({
      path: await write("trailing.dex", padded),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitations.at(-1)).toContain("5 bytes after");
  });

  it("keeps the unread-trailing-bytes fact on a refused class lookup", async () => {
    const dex = debuggableDex();
    const padded = new Uint8Array(dex.length + 3);
    padded.set(dex);
    const result = await provider.inspect({
      path: await write("trailing-absent.dex", padded),
      class_descriptor: "LAbsent;",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message + JSON.stringify(result.error)).toContain(
      "3 bytes after",
    );
  });

  it("names canonical members Android would not auto-load after a gap", async () => {
    const result = await provider.inspect({
      path: await write(
        "gap.apk",
        await zipArchive([
          { name: "classes.dex", bytes: debuggableDex() },
          { name: "classes3.dex", bytes: debuggableDex() },
        ]),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as { members: { entry: string }[] };
    expect(r.members.map((m) => m.entry)).toEqual(["classes.dex"]);
    expect(result.value.limitations.join(" ")).toContain(
      "also holds classes3.dex",
    );
  });

  it("selects one dex member by entry", async () => {
    const apk = await write(
      "one.apk",
      await zipArchive([{ name: "classes.dex", bytes: debuggableDex() }]),
    );
    const result = await provider.inspect({ path: apk, entry: "classes.dex" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.value.result as { members: { entry: string }[] };
    expect(r.members[0]!.entry).toBe("classes.dex");
  });

  it("reports a missing entry as an input error", async () => {
    const apk = await write(
      "miss.apk",
      await zipArchive([{ name: "classes.dex", bytes: debuggableDex() }]),
    );
    const result = await provider.inspect({ path: apk, entry: "classes9.dex" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("steers a non-dex, non-zip file to a useful refusal", async () => {
    const result = await provider.inspect({
      path: await write("x.bin", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])),
    });
    expect(result.ok).toBe(false);
  });
});
