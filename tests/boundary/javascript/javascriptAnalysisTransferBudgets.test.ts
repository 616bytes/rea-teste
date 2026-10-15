import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "../../../src/domain/javascript/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../../../src/domain/javascript/javascriptSourceParser.js";
import { projectJavaScriptModuleSemantics } from "../../../src/domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { completeJavaScriptAnalysisSteps } from "../../../src/application/javascript/JavaScriptAnalysisControl.js";
import { projectJavaScriptSemanticFileSteps } from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import {
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
  writeJavaScriptAnalysisTransfer,
  readJavaScriptAnalysisTransfer,
} from "../../../src/javascript/analysis/JavaScriptAnalysisTransfer.js";

it("allows larger streamed transfers only with corresponding parent capacity", () => {
  const mib = 1024 * 1024;
  expect(javaScriptTransferByteBudget(0)).toBe(512 * mib);
  expect(javaScriptTransferByteBudget(4096 * mib)).toBe(512 * mib);
  expect(javaScriptTransferByteBudget(12288 * mib)).toBe(1536 * mib);
  expect(javaScriptTransferByteBudget(32768 * mib)).toBe(2048 * mib);
});

it("enforces the offered complete-file byte budget while preserving authenticated round trips", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-budget-");
  const text = "export function add(value) { return value + 1; }";
  const file: JavaScriptArtifactFile = {
    path: "app.mjs",
    sha256: createHash("sha256").update(text).digest("hex"),
    container_sha256: "a".repeat(64),
    bytes: Buffer.byteLength(text),
    inventory_artifact_id: "fixture-source",
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: text },
  };
  const ir = analyzeJavaScriptSemantics(text);
  const module = projectJavaScriptModuleSemantics(ir);
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(file, ir, 100),
  );
  const observed = await writeJavaScriptAnalysisTransfer(
    join(root, "observed"),
    module,
    projection,
  );
  const measured = measureJavaScriptModuleTransfer(module);
  expect(measured).toMatchObject({
    bytes: observed.module_bytes,
    records: observed.module_records,
  });
  expect(measureJavaScriptModuleTransfer(module, measured.bytes)).toEqual(
    measured,
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, measured.bytes - 1),
  ).toThrowError(
    expect.objectContaining({
      resource: "transport",
      reportedLimits: expect.objectContaining({
        transfer_file_bytes: measured.bytes - 1,
      }),
    }),
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, 2 ** 31 + 1),
  ).toThrowError(RangeError);
  const exactPath = join(root, "exact");
  const exact = await writeJavaScriptAnalysisTransfer(
    exactPath,
    module,
    projection,
    observed.bytes,
  );
  expect(exact).toEqual(observed);
  expect(await readJavaScriptAnalysisTransfer(exactPath, exact, file)).toEqual({
    module,
    projection,
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "short"),
      module,
      projection,
      observed.bytes - 1,
    ),
  ).rejects.toMatchObject({
    resource: "transport",
    reportedLimits: { transfer_file_bytes: observed.bytes - 1 },
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "oversized"),
      module,
      projection,
      2 ** 31 + 1,
    ),
  ).rejects.toBeInstanceOf(RangeError);
});

it("retains namespace scope kinds and export owners across transfer records", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-namespace-");
  const text = `import electron = require("electron");
namespace A.B { export const ipc = electron.ipcMain; }
namespace A.B { ipc.handle("ping", () => "pong"); }`;
  const parsed = parseJavaScriptSource(text, "namespaces.ts");
  if (parsed === null) throw new Error("Expected parsed TypeScript source");
  const ir = analyzeParsedJavaScriptSemantics(parsed);
  const namespaceScopes = ir.scopes.filter(({ kind }) => kind === "namespace");
  expect(namespaceScopes.length).toBeGreaterThan(0);
  expect(
    namespaceScopes.some(
      ({ namespaceExportScopeId }) => namespaceExportScopeId !== undefined,
    ),
  ).toBe(true);
  const file: JavaScriptArtifactFile = {
    path: "namespaces.ts",
    sha256: createHash("sha256").update(text).digest("hex"),
    container_sha256: "b".repeat(64),
    bytes: Buffer.byteLength(text),
    inventory_artifact_id: "fixture-source",
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: text },
  };
  // The wire schema validates every emitted scope shape, so retain the
  // namespace scopes alongside the program scope the module projection keeps.
  const module = {
    ...projectJavaScriptModuleSemantics(ir),
    scopes: ir.scopes,
  };
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(file, ir, 100),
  );
  const descriptor = await writeJavaScriptAnalysisTransfer(
    join(root, "wire"),
    module,
    projection,
  );
  expect(
    await readJavaScriptAnalysisTransfer(join(root, "wire"), descriptor, file),
  ).toEqual({ module, projection });
});
