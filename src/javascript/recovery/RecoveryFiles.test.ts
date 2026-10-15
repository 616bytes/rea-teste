import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { readWithoutFifoWriter } from "../../../tests/fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { readRecoveryFile } from "./RecoveryFiles.js";

it.skipIf(process.platform === "win32")(
  "rejects a named pipe without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-recovery-fifo-");
    const regular = join(root, "regular.js");
    await writeFile(regular, "module.exports = 1;\n");
    await expect(readRecoveryFile(regular, 1024)).resolves.toHaveLength(20);

    const fifoPath = join(root, "sample.js");
    await promisify(execFile)("mkfifo", [fifoPath]);
    const outcome = await readWithoutFifoWriter(fifoPath, () =>
      readRecoveryFile(fifoPath, 1024).catch((cause: unknown) => cause),
    );
    if (outcome.state !== "completed")
      throw new Error("Recovery input read waited for a FIFO writer");
    expect(outcome.result).toBeInstanceOf(AnalysisOutputError);
  },
);
