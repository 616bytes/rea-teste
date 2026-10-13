import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  JvmDebugMetadataExecution,
  JvmDebugMetadataPort,
} from "../application/jvm/JvmDebugMetadataPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { parseJavaClassFile } from "../domain/jvm/javaClassFile.js";
import {
  buildJavaDebugMetadataResult,
  type InspectJvmDebugMetadataInput,
} from "../domain/jvm/javaDebugMetadataReport.js";
import { err, ok, type Result } from "../domain/result.js";
import { JVM_LIMITS, JVM_PROVIDER_IDENTITY } from "./JvmClassFileRelease.js";
import { jvmClassFileFailure, mapParseError } from "./jvmFailures.js";

const OPERATION = "inspect_jvm_debug_metadata";

/** Read exactly the selected class-file bytes and decode compiler-emitted debug metadata. */
export class JvmClassFileProvider implements JvmDebugMetadataPort {
  /** The reader owns no retained resources; the bounded read closes its own handle. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  async inspect(
    input: InspectJvmDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmDebugMetadataExecution, AnalysisError>> {
    try {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      const selected = await readStableArtifact(
        input.path,
        JVM_LIMITS.inputBytes,
        options?.signal,
      );
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      const parsed = parseJavaClassFile(selected.bytes);
      if (!parsed.ok) return err(mapParseError(parsed.error, input.path));
      const result = buildJavaDebugMetadataResult(parsed.value, {
        path: input.path,
        sha256: selected.sha256,
        bytes: selected.bytes.length,
      });
      // Input bounds do not bound the projected result; a crafted class can
      // declare millions of table entries. Refuse past the inline budget
      // instead of emitting oversized Evidence (mirrors the Go/Rust readers).
      if (
        Buffer.byteLength(JSON.stringify(result), "utf8") >
        JVM_LIMITS.outputBytes
      )
        return err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "transport",
            `Decoded debug metadata for ${input.path} exceeds the inline output budget; no partial success is returned.`,
            { maximum_output_bytes: JVM_LIMITS.outputBytes },
          ),
        );
      return ok(
        createAnalysisExecution(result, JVM_PROVIDER_IDENTITY, {
          subject: {
            path: input.path,
            format: "file",
            sha256: selected.sha256,
          },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations: result.limitations,
        }),
      );
    } catch (cause: unknown) {
      return err(jvmClassFileFailure(cause, input.path));
    }
  }
}
