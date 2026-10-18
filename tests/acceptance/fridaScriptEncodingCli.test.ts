import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

const inputs = [
  { name: "ff", bytes: Buffer.from([0x2f, 0x2f, 0xff, 0x0a]), valid: false },
  { name: "fe", bytes: Buffer.from([0x2f, 0x2f, 0xfe, 0x0a]), valid: false },
  { name: "replacement", bytes: Buffer.from("//\ufffd\n"), valid: true },
  { name: "ascii", bytes: Buffer.from("//comment\n"), valid: true },
  { name: "unicode", bytes: Buffer.from("//中文\n"), valid: true },
  { name: "bom", bytes: Buffer.from("\ufeff//comment\n"), valid: true },
];
const cases = (["CLI", "stdio MCP"] as const).flatMap((surface) =>
  inputs.map((input) => ({ surface, ...input })),
);
const sourceReport = z.object({
  source_kind: z.literal("file"),
  source_path: z.string(),
  source_sha256: z.string(),
});

cliTest.for(cases)(
  "preserves script-file identity for $name through $surface with simulated Frida",
  async ({ surface, bytes, valid }, { cli }) => {
    const root = await createTestTempDirectory("rea-frida-source-encoding-");
    const path = join(root, "script.js");
    const content = Buffer.concat([bytes, Buffer.from("send('marker');\n")]);
    await writeFile(path, content);
    const loadedPath = join(root, "loaded-sha256.txt");
    const environment = {
      NODE_OPTIONS:
        "--import=" +
        pathToFileURL(resolve("tests/fixtures/fridaScriptSource.mjs")).href,
      REA_FRIDA_TEST_SOURCE_LOG: loadedPath,
      REA_LOG_LEVEL: "silent",
    };
    let document: unknown;
    let success: boolean;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: [
          "instrument-with-frida",
          "attach",
          "1",
          "--script-file",
          path,
          "--duration-ms",
          "0",
          "--json",
        ],
        environment,
      });
      success = response.exitCode === 0;
      document = success
        ? z.object({ evidence: z.unknown() }).parse(response.json).evidence
        : response.json;
    } else {
      const { call } = await connectLocalToolsMcp(environment);
      const started = await call("start_frida_session", {
        mode: "attach",
        device_id: "local",
        pid: 1,
      });
      expect(started.isError, JSON.stringify(started)).not.toBe(true);
      const sessionId = z
        .object({ session_id: z.string() })
        .parse(started.structuredContent).session_id;
      const response = await call("load_frida_script", {
        session_id: sessionId,
        source_kind: "file",
        path,
      });
      success = response.isError !== true;
      document = response.structuredContent ?? response.content;
      const closed = await call("close_frida_session", {
        session_id: sessionId,
      });
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
    }
    expect(success, JSON.stringify(document)).toBe(valid);
    if (!valid) {
      expect(JSON.stringify(document)).toContain("invalid_request");
      expect(JSON.stringify(document)).toContain("invalid_format");
      expect(JSON.stringify(document)).toContain("UTF-8");
      await expect(readFile(loadedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      return;
    }
    const expected = createHash("sha256").update(content).digest("hex");
    const report = z
      .object({ normalized_result: sourceReport })
      .parse(document).normalized_result;
    expect(report).toEqual({
      source_kind: "file",
      source_path: path,
      source_sha256: expected,
    });
    expect(await readFile(loadedPath, "utf8")).toBe(expected);
  },
);
