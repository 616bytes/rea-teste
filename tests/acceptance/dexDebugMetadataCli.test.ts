import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { debuggableDex, zipArchive } from "../fixtures/dexFile.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const TOOL = "inspect_dex_debug_metadata";
const CLASS = "Lcom/example/Foo;";

const evidenceOf = (value: unknown) =>
  toolContract(TOOL).outputSchema.parse(value);

cliTest(
  "summarizes, selects a member and drills into a class through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dex-cli-");
    const apk = join(root, "app.apk");
    await writeFile(
      apk,
      await zipArchive([
        { name: "classes.dex", bytes: debuggableDex() },
        { name: "classes2.dex", bytes: debuggableDex() },
      ]),
    );

    const summary = await cli.run({
      arguments: ["inspect-dex-debug-metadata", apk, "--json"],
    });
    expect(summary.exitCode, summary.stderr).toBe(0);
    const summaryResult = evidenceOf(summary.json).normalized_result;
    if (summaryResult.mode !== "summary") throw new Error("Expected summary");
    expect(summaryResult.container).toBe("apk");
    expect(summaryResult.members.map((member) => member.entry)).toEqual([
      "classes.dex",
      "classes2.dex",
    ]);
    expect(summaryResult.members[0]?.summary.readiness).toBe("present");

    const entry = await cli.run({
      arguments: [
        "inspect-dex-debug-metadata",
        apk,
        "--entry",
        "classes2.dex",
        "--class-descriptor",
        CLASS,
        "--json",
      ],
    });
    expect(entry.exitCode, entry.stderr).toBe(0);
    const detail = evidenceOf(entry.json).normalized_result;
    if (detail.mode !== "class-detail") throw new Error("Expected detail");
    expect(detail.class_detail).toMatchObject({
      entry: "classes2.dex",
      descriptor: CLASS,
      source_file: "Foo.java",
      methods: [
        {
          name: "run",
          descriptor: "(I)V",
          state: "present",
          parameter_names: ["x"],
        },
      ],
    });

    const ambiguous = await cli.run({
      arguments: [
        "inspect-dex-debug-metadata",
        apk,
        "--class-descriptor",
        CLASS,
        "--json",
      ],
    });
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.json).toMatchObject({ code: "invalid_request" });
  },
);

cliTest(
  "selects a ./-stored member by either spelling and reports its stored name over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dex-dot-");
    const apk = join(root, "dot.apk");
    await writeFile(
      apk,
      await zipArchive([
        { name: "classes.dex", bytes: debuggableDex() },
        { name: "./classes2.dex", bytes: debuggableDex() },
      ]),
    );
    const { call } = await connectLocalToolsMcp();
    for (const entry of ["classes2.dex", "./classes2.dex"])
      for (const classDescriptor of [undefined, CLASS]) {
        const viaCli = await cli.run({
          arguments: [
            "inspect-dex-debug-metadata",
            apk,
            "--entry",
            entry,
            ...(classDescriptor === undefined
              ? []
              : ["--class-descriptor", classDescriptor]),
            "--json",
          ],
        });
        expect(viaCli.exitCode, viaCli.stdout + viaCli.stderr).toBe(0);
        const result = evidenceOf(viaCli.json).normalized_result;
        expect(
          result.mode === "summary"
            ? result.members.map((member) => member.entry)
            : [result.class_detail.entry],
        ).toEqual(["./classes2.dex"]);
        const viaMcp = await call(TOOL, {
          path: apk,
          entry,
          ...(classDescriptor === undefined
            ? {}
            : { class_descriptor: classDescriptor }),
        });
        expect(viaMcp.isError, JSON.stringify(viaMcp.content)).not.toBe(true);
        expect(evidenceOf(viaMcp.structuredContent).normalized_result).toEqual(
          result,
        );
      }
  },
);

cliTest("refuses a non-DEX file through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-dex-cli-bad-");
  const path = join(root, "bad.dex");
  await writeFile(path, new Uint8Array(256).fill(0x41));
  const result = await cli.run({
    arguments: ["inspect-dex-debug-metadata", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    details: { operation: TOOL },
  });
});

cliTest(
  "answers the CLI's selection identically over stdio MCP, refuses malformed input, and keeps serving after a cancelled call",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dex-mcp-");
    const dex = join(root, "a.dex");
    await writeFile(dex, debuggableDex());
    const { call } = await connectLocalToolsMcp();

    const viaCli = await cli.run({
      arguments: ["inspect-dex-debug-metadata", dex, "--json"],
    });
    expect(viaCli.exitCode, viaCli.stderr).toBe(0);
    const viaMcp = await call(TOOL, { path: dex });
    expect(viaMcp.isError).not.toBe(true);
    expect(evidenceOf(viaMcp.structuredContent).normalized_result).toEqual(
      evidenceOf(viaCli.json).normalized_result,
    );

    const bad = join(root, "bad.dex");
    await writeFile(bad, new Uint8Array(256).fill(0x41));
    const refused = await call(TOOL, { path: bad });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("unsupported_target");

    const long = join(root, "long.dex");
    await writeFile(long, debuggableDex(1_500_000));
    const controller = new AbortController();
    const cancelled = call(TOOL, { path: long }, { signal: controller.signal });
    setImmediate(() => controller.abort(new Error("caller cancelled")));
    await expect(cancelled).rejects.toThrow();
    // The server settled the cancelled call and still answers.
    const after = await call(TOOL, { path: long });
    expect(after.isError).not.toBe(true);
    const result = evidenceOf(after.structuredContent).normalized_result;
    if (result.mode !== "summary") throw new Error("Expected summary");
    expect(result.members[0]?.summary.line_positions).toBe(1_500_001);
  },
);
