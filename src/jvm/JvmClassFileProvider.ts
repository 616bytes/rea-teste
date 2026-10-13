import { createHash } from "node:crypto";
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
import { classifyJarEntry, resolveJarSelection } from "./jarClassEntry.js";
import { JVM_LIMITS, JVM_PROVIDER_IDENTITY } from "./JvmClassFileRelease.js";
import { jvmClassFileFailure, mapParseError } from "./jvmFailures.js";

const OPERATION = "inspect_jvm_debug_metadata";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A JAR is multi-release only when its main manifest section carries
 * `Multi-Release: true` (JAR File Specification). Otherwise META-INF/versions
 * entries are inert resources the runtime never loads. Parses only the main
 * section (up to the first blank line), honoring line continuations.
 */
const isMultiReleaseManifest = (bytes: Uint8Array): boolean => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  const logical: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") break; // end of the main section
    if (line.startsWith(" ") && logical.length > 0)
      logical[logical.length - 1] += line.slice(1); // value continuation
    else logical.push(line);
  }
  for (const attribute of logical) {
    const colon = attribute.indexOf(":");
    if (colon < 0) continue;
    if (attribute.slice(0, colon).trim().toLowerCase() === "multi-release")
      return (
        attribute
          .slice(colon + 1)
          .trim()
          .toLowerCase() === "true"
      );
  }
  return false;
};

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
      const selected = await this.#selectJarMember(
        reader,
        entry,
        input.release,
        jar,
        options?.signal,
      );
      if (!selected.ok) return selected;
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      const classBytes = await this.#readEntryBytes(
        reader,
        selected.value.member,
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
            release: selected.value.release,
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

  /**
   * Enumerate the archive once, honor the Multi-Release manifest, and resolve
   * the caller's entry/release to exactly one member — refusing an inert
   * versioned selection, an absent release, or an ambiguous duplicate.
   */
  async #selectJarMember(
    reader: ZipArtifactReader,
    entry: string,
    requestedRelease: number | undefined,
    jar: string,
    signal: AbortSignal | undefined,
  ): Promise<
    Result<
      { readonly member: ArtifactEntry; readonly release: number | null },
      AnalysisError
    >
  > {
    let manifestEntry: ArtifactEntry | undefined;
    const byRelease = new Map<number | null, ArtifactEntry[]>();
    for await (const member of reader.entries(signal)) {
      if (member.kind !== "file" || member.encrypted) continue;
      if (member.path === "META-INF/MANIFEST.MF") {
        manifestEntry = member;
        continue;
      }
      const candidate = classifyJarEntry(member.path, entry);
      if (candidate === undefined) continue;
      const members = byRelease.get(candidate.release) ?? [];
      members.push(member);
      byRelease.set(candidate.release, members);
    }
    const multiRelease =
      manifestEntry !== undefined &&
      isMultiReleaseManifest(
        await this.#readEntryBytes(reader, manifestEntry, signal),
      );
    if (!multiRelease && requestedRelease !== undefined)
      return err(
        this.#inputError(
          "release",
          `${jar} is not a multi-release JAR (no Multi-Release: true manifest attribute); META-INF/versions entries are inert, so only the base entry is selectable.`,
        ),
      );
    // Outside a multi-release JAR, versioned entries never load; drop them.
    const effective = new Map<number | null, ArtifactEntry[]>();
    if (multiRelease) for (const [r, m] of byRelease) effective.set(r, m);
    else {
      const base = byRelease.get(null);
      if (base !== undefined) effective.set(null, base);
    }
    const candidates = [...effective.entries()].map(([release, members]) => ({
      release,
      path: members[0]!.path,
    }));
    const selection = resolveJarSelection(candidates, requestedRelease);
    if (!selection.ok) return err(this.#selectionError(selection, jar, entry));
    const selectedMembers = effective.get(selection.release) ?? [];
    if (selectedMembers.length !== 1)
      return err(
        this.#inputError(
          "entry",
          `${jar} holds ${String(selectedMembers.length)} members at the selected entry and release; the identity is ambiguous, so no member is chosen.`,
        ),
      );
    return ok({ member: selectedMembers[0]!, release: selection.release });
  }

  #inputError(field: "entry" | "release", message: string): AnalysisInputError {
    return new AnalysisInputError(OPERATION, undefined, [
      { path: [field], reason: "invalid_value", message },
    ]);
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
