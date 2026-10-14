import {
  chmod,
  lstat,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { VineflowerProvider } from "../../../src/jvm/VineflowerProvider.js";
import { jvmResultSchemas } from "../../../src/domain/jvm/jvmAnalysis.js";

const require = createRequire(import.meta.url);
const fixture = async (body = "") => {
  const root = await createTestTempDirectory("rea-vineflower-boundary-");
  const path = join(root, "Probe.class");
  await writeFile(path, Buffer.from("cafebabe000000340001", "hex"));
  const command = join(root, "vineflower");
  await writeFile(
    command,
    `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');\nif (process.argv.includes('--help')) { console.log('=== Vineflower Decompiler 1.11.2 ==='); process.exit(0); }\nconst { ZipWriter, Uint8ArrayWriter, TextReader } = require(${JSON.stringify(require.resolve("@zip.js/zip.js"))});\nasync function writeArchive(entries) { const writer = new ZipWriter(new Uint8ArrayWriter()); for (const [name, text] of Object.entries(entries)) await writer.add(name, new TextReader(text)); fs.writeFileSync(process.argv.at(-1), await writer.close()); }\nvoid (async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });\n`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);
  const provider = new VineflowerProvider({
    environment: {
      ...process.env,
      REA_VINEFLOWER_COMMAND: command,
      REA_VINEFLOWER_TEST_ROOT: root,
    },
  });
  return { root, path, command, provider, output: join(root, "sources") };
};
const request = (path: string, output: string) => ({
  operation: "decompile_jvm_artifact" as const,
  input: { path, output_directory: output, classpath: [] },
});

it("reports an explicit missing executable without falling back", async () => {
  const root = await createTestTempDirectory("rea-vineflower-missing-");
  const provider = new VineflowerProvider({
    environment: { REA_VINEFLOWER_COMMAND: join(root, "absent") },
  });
  try {
    expect(await provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "executable_missing",
    });
    const result = await provider.execute({
      operation: "inspect_jvm_decompiler",
      input: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(
      await provider.execute(
        request(join(root, "absent.class"), join(root, "output")),
      ),
    ).toMatchObject({
      ok: false,
      error: { operation: "decompile_jvm_artifact" },
    });
  } finally {
    await provider.close();
  }
});

it("discovers the selected executable without starting a process", async () => {
  const f = await fixture();
  await writeFile(
    f.command,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(f.root, "launched"))}, 'yes');\n`,
    { mode: 0o700 },
  );
  try {
    expect(await f.provider.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        command: f.command,
        command_source: "environment",
        version_probe: "not_attempted",
      },
    });
    await expect(lstat(join(f.root, "launched"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.provider.close();
  }
  expect(await f.provider.inspectAvailability()).toMatchObject({
    status: "unavailable",
    reason: "Provider is closed",
  });
});

it("preserves case-distinct archive entries until destination admission", async () => {
  const f = await fixture(
    "await writeArchive({'p/Foo.java': 'class Foo {}', 'p/foo.java': 'class foo {}'});",
  );
  const archive = join(f.root, "case.jar");
  await writeOrderedZip(archive, ["p/Foo.class", "p/foo.class"]);
  const probe = join(f.root, "case-probe");
  await writeFile(probe, "probe");
  const caseSensitive = await lstat(join(f.root, "CASE-PROBE")).then(
    () => false,
    () => true,
  );
  try {
    const result = await f.provider.execute(request(archive, f.output));
    if (caseSensitive) {
      if (!result.ok) throw result.error;
      const value = jvmResultSchemas.decompile_jvm_artifact.parse(
        result.value.result,
      );
      expect(
        value.sources.map((source) => source.relative_path).sort(),
      ).toEqual(["sources/p/Foo.java", "sources/p/foo.java"]);
    } else {
      expect(result).toMatchObject({ ok: false });
      await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await f.provider.close();
  }
});

it("publishes verified sources and provenance from a copied input", async () => {
  const f = await fixture(
    `const target = process.argv.at(-2); const output = process.argv.at(-1); if (!target.endsWith('.class') || fs.readFileSync(target).readUInt32BE(0) !== 0xcafebabe) process.exit(3); fs.writeFileSync(path.join(output, 'Probe.java'), 'class Probe {}\\n');`,
  );
  const before = await readFile(f.path);
  try {
    const result = await f.provider.execute(request(f.path, f.output));
    if (!result.ok) throw result.error;
    const value = jvmResultSchemas.decompile_jvm_artifact.parse(
      result.value.result,
    );
    expect(value.client).toMatchObject({
      command: f.command,
      command_source: "environment",
      version: "1.11.2",
    });
    expect(value.sources).toHaveLength(1);
    expect(await readFile(value.sources[0]!.path, "utf8")).toBe(
      "class Probe {}\n",
    );
    expect(value.target.path).toBe(f.path);
    expect(value.source_inventory_complete).toBe(true);
    expect(value.compilation_status).toBe("not_attempted");
    expect(
      JSON.parse(await readFile(value.manifest.path, "utf8")),
    ).toMatchObject({ target: value.target, sources: value.sources });
    expect(await readFile(f.path)).toEqual(before);
    expect(await readdir(f.root)).toEqual(
      expect.arrayContaining(["Probe.class", "vineflower", "sources"]),
    );
  } finally {
    await f.provider.close();
  }
});

it("refuses existing output, symlink input and malformed class headers", async () => {
  const f = await fixture("process.exit(99);");
  try {
    await writeFile(f.output, "preserve");
    expect(await f.provider.execute(request(f.path, f.output))).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(await readFile(f.output, "utf8")).toBe("preserve");
    const link = join(f.root, "linked.class");
    await symlink(f.path, link);
    expect(
      await f.provider.execute(request(link, join(f.root, "linked-output"))),
    ).toMatchObject({ ok: false });
    await writeFile(f.path, "not bytecode");
    expect(
      await f.provider.execute(request(f.path, join(f.root, "bad-output"))),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisUnsupportedTargetError" },
    });
    await expect(lstat(join(f.root, "bad-output"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.provider.close();
  }
});

it("preserves process diagnostics and removes an uncommitted output", async () => {
  const f = await fixture(
    "console.error('invalid constant pool'); process.exit(7);",
  );
  try {
    const result = await f.provider.execute(request(f.path, f.output));
    expect(result).toMatchObject({
      ok: false,
      error: {
        capturedOutput: { stderr: "invalid constant pool\n", exit_code: 7 },
      },
    });
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.provider.close();
  }
});

it("cancels an owned worker and rolls back output", async () => {
  const f = await fixture(
    "fs.writeFileSync(path.join(process.env.REA_VINEFLOWER_TEST_ROOT, 'worker.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd() })); setInterval(() => {}, 1000);",
  );
  const controller = new AbortController();
  const running = f.provider.execute(request(f.path, f.output), {
    signal: controller.signal,
  });
  try {
    await vi.waitFor(() => lstat(join(f.root, "worker.json")), {
      timeout: 10_000,
      interval: 25,
    });
    controller.abort();
    expect(await running).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    const worker = JSON.parse(
      await readFile(join(f.root, "worker.json"), "utf8"),
    ) as { pid: number; cwd: string };
    expect(() => process.kill(worker.pid, 0)).toThrow();
    await expect(lstat(worker.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    controller.abort();
    await running;
    await f.provider.close();
  }
});

it("rejects traversal archives before running the decompiler", async () => {
  const f = await fixture(
    "fs.writeFileSync(path.join(process.env.REA_VINEFLOWER_TEST_ROOT, 'ran'), 'yes');",
  );
  const archive = join(f.root, "unsafe.jar");
  await writeOrderedZip(archive, ["../escape.class"]);
  try {
    expect(await f.provider.execute(request(archive, f.output))).toMatchObject({
      ok: false,
    });
    await expect(lstat(join(f.root, "ran"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.provider.close();
  }
});

it("preserves archive entry paths and the selected prefix", async () => {
  const f = await fixture(
    "if (!process.argv.includes('--only=fixture/Probe')) process.exit(9); await writeArchive({'fixture/Probe.java': 'package fixture; class Probe {}'});",
  );
  const archive = join(f.root, "selected.jar");
  await writeOrderedZip(archive, ["fixture/Probe.class"]);
  try {
    const result = await f.provider.execute({
      operation: "decompile_jvm_artifact",
      input: {
        path: archive,
        output_directory: f.output,
        classpath: [],
        class_prefix: "fixture/Probe",
      },
    });
    if (!result.ok) throw result.error;
    const value = jvmResultSchemas.decompile_jvm_artifact.parse(
      result.value.result,
    );
    expect(value.sources.map((source) => source.relative_path)).toEqual([
      "sources/fixture/Probe.java",
    ]);
    expect(value.class_prefix).toBe("fixture/Probe");
  } finally {
    await f.provider.close();
  }
});

it.each(["original", "snapshot"])(
  "refuses changed %s bytes before publication",
  async (selection) => {
    const f = await fixture(
      `const selected = ${selection === "original" ? "path.join(process.env.REA_VINEFLOWER_TEST_ROOT, 'Probe.class')" : "process.argv.at(-2)"}; fs.chmodSync(selected, 0o600); fs.appendFileSync(selected, 'changed'); fs.writeFileSync(path.join(process.argv.at(-1), 'Probe.java'), 'class Probe {}');`,
    );
    try {
      expect(await f.provider.execute(request(f.path, f.output))).toMatchObject(
        {
          ok: false,
          error: { _tag: "AnalysisArtifactChangedError" },
        },
      );
      await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.provider.close();
    }
  },
);

it("rejects a replaced generated directory without deleting its symlink target", async () => {
  const f = await fixture(
    "fs.rmdirSync('generated'); fs.symlinkSync(process.env.REA_VINEFLOWER_TEST_ROOT, 'generated');",
  );
  const original = await readFile(f.path);
  try {
    expect(await f.provider.execute(request(f.path, f.output))).toMatchObject({
      ok: false,
    });
    expect(await readFile(f.path)).toEqual(original);
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.provider.close();
  }
});

it("retains failed output cleanup for close to retry", async () => {
  const f = await fixture("process.exit(7);");
  const rollback = SafeOutputTree.prototype.rollback;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockImplementation(function (this: SafeOutputTree) {
      return this.outputRoot === f.output
        ? Promise.reject(new Error("fixture output cleanup failure"))
        : rollback.call(this);
    });
  try {
    expect(await f.provider.execute(request(f.path, f.output))).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, cleanupResources: [f.output] },
    });
    await expect(f.provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect((await lstat(f.output)).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
    await f.provider.close();
  }
  await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves a published manifest when descriptor cleanup remains pending", async () => {
  const f = await fixture(
    "fs.writeFileSync('generated/Probe.java', 'class Probe {}');",
  );
  const rollback = SafeOutputTree.prototype.rollback;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockImplementation(function (this: SafeOutputTree) {
      return this.outputRoot === f.output && this.published
        ? Promise.reject(new Error("fixture published descriptor cleanup"))
        : rollback.call(this);
    });
  try {
    const result = await f.provider.execute(request(f.path, f.output));
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: {
          published_result: {
            manifest: { path: join(f.output, "manifest.json") },
            sources: [{ relative_path: "sources/Probe.java" }],
          },
        },
      },
    });
    expect(await readFile(join(f.output, "sources/Probe.java"), "utf8")).toBe(
      "class Probe {}",
    );
    await expect(f.provider.close()).rejects.toMatchObject({
      diagnostics: {
        published_result: {
          manifest: { path: join(f.output, "manifest.json") },
        },
      },
    });
  } finally {
    spy.mockRestore();
    await f.provider.close();
  }
  expect((await lstat(f.output)).isDirectory()).toBe(true);
});
