import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPackerIndicatorsService } from "../../../src/composition/binaryDiagnostics.js";
import {
  CODE_RX,
  peImage,
  plain,
} from "../../../src/native/packer/PackerIndicators.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const image = () =>
  peImage({
    entryRva: 0x1000,
    sections: [
      {
        name: ".text",
        virtualSize: 0x200,
        rva: 0x1000,
        raw: plain(0x200),
        characteristics: CODE_RX,
      },
    ],
  });

describe("packer indicator stable filesystem boundary", () => {
  it("returns observed Evidence for a selected PE file", async () => {
    const root = await createTestTempDirectory("rea-packer-files-");
    const path = join(root, "image.exe");
    await writeFile(path, image());
    const result = await createPackerIndicatorsService().inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      subject: { format: "pe" },
      operation: "inspect_packer_indicators",
      normalized_result: {
        format: "pe32",
        verdict: { status: "not_observed" },
      },
    });
  });

  it("reports non-file and malformed selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-packer-inputs-");
    const path = join(root, "image.exe");
    const alias = join(root, "alias.exe");
    const malformed = join(root, "malformed.bin");
    await writeFile(path, image());
    await writeFile(malformed, Buffer.from("not an executable image"));
    await symlink(path, alias);
    const service = createPackerIndicatorsService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.exe"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_packer_indicators",
        issues: [{ path: ["path"], reason }],
      });
    }
    const relative = await service.inspect({ path: "image.exe" });
    expect(relative.ok).toBe(false);
  });

  it("returns typed budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-packer-budget-");
    const path = join(root, "image.exe");
    await writeFile(path, image());
    const service = createPackerIndicatorsService();
    const budget = await service.inspect({ path, max_file_bytes: 64 });
    if (budget.ok) throw new Error("Expected budget failure");
    expect(budget.error._tag).toBe("AnalysisResourceConstraintError");
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
