import { stat } from "node:fs/promises";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  JvmDebugMetadataExecution,
  JvmDebugMetadataPort,
} from "../application/jvm/JvmDebugMetadataPort.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../artifacts/ArtifactReader.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { parseJavaClassFile } from "../domain/jvm/javaClassFile.js";
import {
  buildJavaDebugMetadataResult,
  type InspectJvmDebugMetadataInput,
  type JavaDebugMetadataResult,
} from "../domain/jvm/javaDebugMetadataReport.js";
import { err, ok, type Result } from "../domain/result.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import {
  classifyJarEntry,
  type JarEntryCandidate,
  resolveJarSelection,
} from "./jarClassEntry.js";
import { JVM_LIMITS, JVM_PROVIDER_IDENTITY } from "./JvmClassFileRelease.js";
import { createHash } from "node:crypto";
import { jvmClassFileFailure, mapParseError } from "./jvmFailures.js";

const OPERATION = "inspect_jvm_debug_metadata";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const execution = (
  result: JavaDebugMetadataResult,
  path: string,
  subjectSha256: string,
  format: "file" | "zip",
): JvmDebugMetadataExecution =>
  createAnalysisExecution(result, JVM_PROVIDER_IDENTITY, {
    subject: { path, format, sha256: subjectSha256 },
    locations: [{ kind: "artifact-path", path }],
    limitations: result.limitations,
  });

/** Read exactly the selected class-file bytes and decode compiler-emitted debug metadata. */
export class JvmClassFileProvider implements JvmDebugMetadataPort {
  /** The reader owns no retained resources; each bounded read closes its own handle. */
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
      const result =
        input.entry === undefined
          ? await this.#inspectClassFile(input, options)
          : await this.#inspectJarEntry(
              input.path,
              input.entry,
              input,
              options,
            );
      return result;
    } catch (cause: unknown) {
      return err(jvmClassFileFailure(cause, input.path));
    }
  }

  async #inspectClassFile(
    input: InspectJvmDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmDebugMetadataExecution, AnalysisError>> {
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
    const tooLarge = this.#rejectIfOversized(result, input.path);
    if (tooLarge) return err(tooLarge);
    return ok(execution(result, input.path, selected.sha256, "file"));
  }

  async #inspectJarEntry(
    jar: string,
    entry: string,
    input: InspectJvmDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmDebugMetadataExecution, AnalysisError>> {
    const info = await stat(jar);
    if (info.size > JVM_LIMITS.archiveBytes)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          `Selected JAR exceeds ${String(JVM_LIMITS.archiveBytes)} bytes: ${jar}`,
          { maximum_archive_bytes: JVM_LIMITS.archiveBytes },
        ),
      );
    const jarDigest = await hashStableFile(jar, options?.signal);
    const reader = new ZipArtifactReader(
      jar,
      "zip",
      JVM_LIMITS.archiveMetadataBytes,
    );
    try {
      const matches = new Map<string, ArtifactEntry>();
      const candidates: JarEntryCandidate[] = [];
      for await (const member of reader.entries(options?.signal)) {
        if (member.kind !== "file" || member.encrypted) continue;
        const candidate = classifyJarEntry(member.path, entry);
        if (candidate === undefined) continue;
        candidates.push(candidate);
        matches.set(member.path, member);
      }
      const selection = resolveJarSelection(candidates, input.release);
      if (!selection.ok)
        return err(this.#selectionError(selection, jar, entry));
      const selectedMember = matches.get(selection.path);
      if (selectedMember === undefined)
        return err(
          this.#selectionError(
            { reason: "not-found", available: [] },
            jar,
            entry,
          ),
        );
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      const classBytes = await this.#readEntryBytes(
        reader,
        selectedMember,
        options?.signal,
      );
      const parsed = parseJavaClassFile(classBytes);
      if (!parsed.ok) return err(mapParseError(parsed.error, jar));
      const result = buildJavaDebugMetadataResult(
        parsed.value,
        { path: jar, sha256: jarDigest.sha256, bytes: jarDigest.bytes },
        {
          container: "jar",
          selectedEntry: {
            entry,
            release: selection.release,
            sha256: sha256(classBytes),
            bytes: classBytes.length,
          },
        },
      );
      const tooLarge = this.#rejectIfOversized(result, jar);
      if (tooLarge) return err(tooLarge);
      return ok(execution(result, jar, jarDigest.sha256, "zip"));
    } finally {
      await reader.close();
    }
  }

  /** Buffer one archive member, bounded by the class-file input budget. */
  async #readEntryBytes(
    reader: ZipArtifactReader,
    member: ArtifactEntry,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const stream = await reader.open(member, signal);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new ArtifactReaderFailure("cancelled", "JAR read cancelled");
      }
      if (!Buffer.isBuffer(chunk)) {
        stream.destroy();
        throw new ArtifactReaderFailure(
          "format",
          "JAR entry did not yield bytes",
        );
      }
      size += chunk.length;
      if (size > JVM_LIMITS.inputBytes) {
        stream.destroy();
        throw new ArtifactReaderFailure(
          "limit",
          `Selected class entry exceeds ${String(JVM_LIMITS.inputBytes)} bytes`,
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  #rejectIfOversized(
    result: JavaDebugMetadataResult,
    path: string,
  ): AnalysisResourceConstraintError | undefined {
    // Input bounds do not bound the projected result; a crafted class can
    // declare millions of table entries. Refuse past the inline output budget
    // instead of emitting oversized Evidence (mirrors the Go/Rust readers).
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") <=
      JVM_LIMITS.outputBytes
    )
      return undefined;
    return new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      `Decoded debug metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
      { maximum_output_bytes: JVM_LIMITS.outputBytes },
    );
  }

  #selectionError(
    selection: {
      readonly reason: "not-found" | "release-absent";
      readonly available: readonly number[];
    },
    jar: string,
    entry: string,
  ): AnalysisInputError {
    const message =
      selection.reason === "not-found"
        ? `No class entry ${entry} exists in ${jar}.`
        : `Entry ${entry} is not available for the requested release in ${jar}; available multi-release versions: ${selection.available.length === 0 ? "none (base only)" : selection.available.join(", ")}.`;
    return new AnalysisInputError(OPERATION, undefined, [
      {
        path: [selection.reason === "not-found" ? "entry" : "release"],
        reason: "invalid_value",
        message,
      },
    ]);
  }
}
