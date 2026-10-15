import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import {
  createGoBinaryDiagnosticFixtures,
  createGoBinaryFixture,
} from "../../fixtures/go/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("distinguishes unsupported MZ carriers from damaged PE declarations", async () => {
  const root = await createTestTempDirectory("rea-go-mz-");
  for (const fixture of createGoBinaryDiagnosticFixtures()) {
    const path = join(root, `${fixture.name}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await new GoBinaryProvider().inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(
        fixture.code === "unsupported_target"
          ? AnalysisUnsupportedTargetError
          : AnalysisInputError,
      );
  }
});

it.each([32, 64] as const)(
  "rejects advertised PE%d data directories outside the optional header",
  async (bits) => {
    const root = await createTestTempDirectory("rea-go-pe-directories-");
    const fixture = createGoBinaryFixture({ format: "pe", bits });
    fixture.bytes.writeUInt32LE(1, 152 + (bits === 64 ? 108 : 92));
    const path = join(root, `truncated-pe${String(bits)}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await new GoBinaryProvider().inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisInputError);
      if (!(result.error instanceof AnalysisInputError)) throw result.error;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ reason: "invalid_format" }),
      );
    }
  },
);

it("preserves the actual build-info byte guard as a resource failure", async () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes.set([0x81, 0x80, 0x40], fixture.headerOffset + 32);
  const root = await createTestTempDirectory("rea-go-resource-");
  const path = join(root, "oversized-metadata.elf");
  await writeFile(path, fixture.bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  expect(result.ok).toBe(false);
  if (result.ok)
    throw new Error("Oversized embedded metadata must not succeed");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.reason).toContain(path);
  expect(result.error.reportedLimits).toEqual({
    boundary: "build-info",
    maximum_bytes: 1024 * 1024,
  });
});

it.skipIf(process.platform === "win32")(
  "rejects a symlink without replacing its selected file identity",
  async () => {
    const root = await createTestTempDirectory("rea-go-symlink-");
    const selected = join(root, "selected");
    const original = join(root, "original.elf");
    await writeFile(original, createGoBinaryFixture().bytes);
    await symlink(original, selected);
    const result = await new GoBinaryProvider().inspect({ path: selected });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  },
);

it.each([
  {
    shape: "a GOPATH-mode",
    bytes: () =>
      createGoBinaryFixture({
        moduleText:
          "path\texample.com/tool/cmd/tool\nbuild\t-compiler=gc\nbuild\tGOOS=linux\n",
      }).bytes,
  },
  {
    shape: "a moduleless legacy",
    bytes: () => {
      const fixture = createGoBinaryFixture({
        encoding: "pointer",
        goVersion: "go1.17",
      });
      // The pointer-encoded module string header at file offset 1536 holds a
      // nil data pointer and zero length, as moduleless Go 1.12-1.17 builds do.
      fixture.bytes.writeBigUInt64LE(0n, 1536 + 16);
      fixture.bytes.writeBigUInt64LE(0n, 1536 + 24);
      return fixture.bytes;
    },
  },
])(
  "reports the dependency list of $shape build without a main-module record as unknown",
  async ({ bytes }) => {
    const root = await createTestTempDirectory("rea-go-no-main-module-");
    const path = join(root, "application.elf");
    await writeFile(path, bytes());
    const result = await new GoBinaryProvider().inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.build_info?.module).toMatchObject({
      main: null,
      dependencies: [],
      complete: true,
    });
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining(
        "main module and dependency list are unknown, not empty",
      ),
    );
  },
);

it("keeps an empty dependency list of a module-mode build free of the unknown limitation", async () => {
  const root = await createTestTempDirectory("rea-go-main-module-");
  const path = join(root, "application.elf");
  await writeFile(
    path,
    createGoBinaryFixture({
      moduleText:
        "path\texample.com/tool\nmod\texample.com/tool\t(devel)\t\nbuild\tGOOS=linux\n",
    }).bytes,
  );
  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info?.module).toMatchObject({
    main: { path: "example.com/tool" },
    dependencies: [],
    complete: true,
  });
  expect(result.value.limitations.join(" ")).not.toContain(
    "unknown, not empty",
  );
});
