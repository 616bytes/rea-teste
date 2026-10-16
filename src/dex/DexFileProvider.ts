import { createHash } from "node:crypto";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  DexDebugMetadataExecution,
  DexDebugMetadataPort,
} from "../application/dex/DexDebugMetadataPort.js";
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import {
  looksLikeZip,
  normalizeArchiveMemberPath,
  readArchiveMember,
} from "../artifacts/archiveMember.js";
import { hashStableRootArtifactHandle } from "../artifacts/inventory/hashStableRootArtifact.js";
import {
  peekArtifactMagic,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { dexWorkBudget } from "../domain/dex/dexDebugInfo.js";
import {
  assembleClassDetail,
  type DexClassDetail,
  type DexWork,
  summarizeDex,
} from "../domain/dex/dexDebugMetadata.js";
import {
  buildDexClassDetailResult,
  buildDexSummaryResult,
  type DexDebugMetadataResult,
  type DexSummaryMember,
  type InspectDexDebugMetadataInput,
} from "../domain/dex/dexDebugMetadataReport.js";
import { parseDexFile } from "../domain/dex/dexFile.js";
import { err, ok, type Result } from "../domain/result.js";
import { zipPackageFormatForPath } from "../domain/zipPackageFormat.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  dexFileFailure,
  mapDexParseError,
  mapDexWorkError,
} from "./dexFailures.js";
import { dexMemberOrder, isRootDexMember } from "./dexEntry.js";
import { DEX_LIMITS, DEX_PROVIDER_IDENTITY } from "./DexFileRelease.js";

const OPERATION = "inspect_dex_debug_metadata";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A selected DEX member, read on demand. Members are loaded, analysed and
 * released one at a time, so peak memory holds one member, not all 64.
 */
interface MemberSource {
  readonly entry: string | null;
  readonly load: () => Promise<Uint8Array>;
  /** Where a parse error is reported (`path` or `path!entry`). */
  readonly label: string;
}

/** What one inspection keeps from its members after each is released. */
type MemberFindings =
  | { readonly mode: "summary"; readonly members: DexSummaryMember[] }
  | {
      readonly mode: "detail";
      readonly found: {
        readonly entry: string | null;
        readonly detail: DexClassDetail;
      }[];
    };

const execution = (
  result: DexDebugMetadataResult,
  path: string,
  subjectSha256: string,
  format: "file" | "apk" | "zip",
): DexDebugMetadataExecution =>
  createAnalysisExecution(result, DEX_PROVIDER_IDENTITY, {
    subject: { path, format, sha256: subjectSha256 },
    locations: [{ kind: "artifact-path", path }],
    limitations: result.limitations,
  });

/** Read exactly the selected DEX bytes and report compiler-emitted debug metadata. */
export class DexFileProvider implements DexDebugMetadataPort {
  close(): Promise<void> {
    return Promise.resolve();
  }

  async inspect(
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    try {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      if (input.entry !== undefined)
        return await this.#inspectArchive(input.path, input, options);
      const magic = await peekArtifactMagic(input.path, 8, options?.signal);
      return looksLikeZip(magic)
        ? await this.#inspectArchive(input.path, input, options)
        : await this.#inspectLooseDex(input.path, input, options);
    } catch (cause: unknown) {
      return err(dexFileFailure(cause, input.path));
    }
  }

  async #inspectLooseDex(
    path: string,
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    const selected = await readStableArtifact(
      path,
      DEX_LIMITS.inputBytes,
      options?.signal,
    );
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const findings = await this.#analyse(
      [
        {
          entry: null,
          load: () => Promise.resolve(selected.bytes),
          label: path,
        },
      ],
      input,
      options?.signal,
    );
    if (!findings.ok) return findings;
    return this.#assemble(findings.value, input, {
      artifact: {
        path,
        sha256: selected.sha256,
        bytes: selected.bytes.length,
      },
      container: "dex-file",
      format: "file",
    });
  }

  async #inspectArchive(
    path: string,
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    const handle = await openRegularFile(path, {
      symlinks: "reject",
      signal: options?.signal,
    });
    const owner = new OwnedFileHandle(handle);
    try {
      const initial = await handle.stat();
      if (initial.size > DEX_LIMITS.archiveBytes)
        return err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            `Selected archive exceeds ${String(DEX_LIMITS.archiveBytes)} bytes: ${path}`,
            { maximum_archive_bytes: DEX_LIMITS.archiveBytes },
          ),
        );
      const zipFormat = zipPackageFormatForPath(path) ?? "zip";
      const reader = new ZipArtifactReader(
        path,
        zipFormat,
        DEX_LIMITS.archiveMetadataBytes,
        { handle, initial },
      );
      try {
        const selected = await this.#selectDexMembers(
          reader,
          input.entry,
          path,
          options?.signal,
        );
        if (!selected.ok) return err(selected.error);
        const findings = await this.#analyse(
          selected.value.map(({ entry, member }) => ({
            entry,
            label: `${path}!${entry}`,
            load: () =>
              readArchiveMember(
                reader,
                member,
                DEX_LIMITS.inputBytes,
                options?.signal,
              ),
          })),
          input,
          options?.signal,
        );
        if (!findings.ok) return findings;
        const digest = await hashStableRootArtifactHandle(
          path,
          handle,
          initial,
          options?.signal,
        );
        const format = zipFormat === "apk" ? "apk" : "zip";
        return this.#assemble(findings.value, input, {
          artifact: { path, sha256: digest.sha256, bytes: digest.bytes },
          container: format,
          format,
        });
      } finally {
        await reader.close();
      }
    } finally {
      await owner.close();
    }
  }

  /** Choose the archive's DEX members: the explicit entry, or every root classes*.dex. */
  async #selectDexMembers(
    reader: ZipArtifactReader,
    entry: string | undefined,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<
    Result<{ entry: string; member: ArtifactEntry }[], AnalysisError>
  > {
    const requested =
      entry === undefined ? undefined : normalizeArchiveMemberPath(entry);
    const matches: { entry: string; member: ArtifactEntry }[] = [];
    for await (const member of reader.entries(signal)) {
      if (member.kind !== "file") continue;
      if (requested !== undefined) {
        if (member.path === requested)
          matches.push({ entry: member.path, member });
      } else if (isRootDexMember(member.path) && !member.encrypted) {
        matches.push({ entry: member.path, member });
      }
    }
    if (requested !== undefined)
      return this.#resolveRequested(matches, requested, path);
    if (matches.length === 0)
      return err(
        this.#inputError(
          "entry",
          `${path} holds no root classes*.dex member; select a .dex with entry.`,
        ),
      );
    if (matches.length > DEX_LIMITS.maxDexMembers)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          `${path} holds ${String(matches.length)} dex members, over the ${String(DEX_LIMITS.maxDexMembers)} limit; select one with entry.`,
          { maximum_dex_members: DEX_LIMITS.maxDexMembers },
        ),
      );
    matches.sort((a, b) => dexMemberOrder(a.entry) - dexMemberOrder(b.entry));
    return ok(matches);
  }

  #resolveRequested(
    matches: readonly { entry: string; member: ArtifactEntry }[],
    requested: string,
    path: string,
  ): Result<{ entry: string; member: ArtifactEntry }[], AnalysisError> {
    if (matches.length === 0)
      return err(
        this.#inputError("entry", `No member ${requested} exists in ${path}.`),
      );
    if (matches.length > 1)
      return err(
        this.#inputError(
          "entry",
          `${path} holds ${String(matches.length)} members named ${requested}; the identity is ambiguous.`,
        ),
      );
    const only = matches[0]!;
    if (only.member.encrypted)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          path,
          `The selected member ${requested} is encrypted and cannot be read without a key; unavailable, not absent.`,
        ),
      );
    return ok([only]);
  }

  /**
   * Load, frame and analyse each member in turn under one call-wide work
   * budget, keeping only its summary or matching class detail before the next
   * member is read.
   */
  async #analyse(
    sources: readonly MemberSource[],
    input: InspectDexDebugMetadataInput,
    signal: AbortSignal | undefined,
  ): Promise<Result<MemberFindings, AnalysisError>> {
    const work: DexWork = {
      budget: dexWorkBudget(DEX_LIMITS.maxDebugOpcodes),
      cancelled: () => signal?.aborted === true,
    };
    const summaries: DexSummaryMember[] = [];
    const found: { entry: string | null; detail: DexClassDetail }[] = [];
    for (const source of sources) {
      if (signal?.aborted) return err(new AnalysisCancelledError(OPERATION));
      const buffer = await source.load();
      const parsed = parseDexFile(buffer);
      if (!parsed.ok) return err(mapDexParseError(parsed.error, source.label));
      if (input.class_descriptor === undefined) {
        const summary = summarizeDex(parsed.value, buffer, work);
        if (!summary.ok) return err(mapDexWorkError(summary.error));
        summaries.push({
          entry: source.entry,
          sha256: sha256(buffer),
          bytes: buffer.length,
          summary: summary.value,
        });
        continue;
      }
      const detail = assembleClassDetail(
        parsed.value,
        buffer,
        input.class_descriptor,
        work,
        DEX_LIMITS.outputBytes,
      );
      if (!detail.ok) return err(mapDexWorkError(detail.error));
      if (detail.value !== null)
        found.push({ entry: source.entry, detail: detail.value });
      // A second match is already ambiguous; reading further members is waste.
      if (found.length > 1) break;
    }
    return ok(
      input.class_descriptor === undefined
        ? { mode: "summary", members: summaries }
        : { mode: "detail", found },
    );
  }

  /** Decide summary vs class-detail over the decoded members and build the result. */
  #assemble(
    findings: MemberFindings,
    input: InspectDexDebugMetadataInput,
    context: {
      readonly artifact: { path: string; sha256: string; bytes: number };
      readonly container: DexDebugMetadataResult["container"];
      readonly format: "file" | "apk" | "zip";
    },
  ): Result<DexDebugMetadataExecution, AnalysisError> {
    const { artifact, container, format } = context;
    const result: Result<DexDebugMetadataResult, AnalysisError> =
      findings.mode === "summary"
        ? ok(buildDexSummaryResult(artifact, container, findings.members))
        : this.#classDetail(
            findings.found,
            input.class_descriptor ?? "",
            artifact,
            container,
          );
    if (!result.ok) return result;
    const tooLarge = this.#rejectIfOversized(result.value, artifact.path);
    if (tooLarge) return err(tooLarge);
    return ok(execution(result.value, artifact.path, artifact.sha256, format));
  }

  #classDetail(
    found: readonly {
      readonly entry: string | null;
      readonly detail: DexClassDetail;
    }[],
    descriptor: string,
    artifact: { path: string; sha256: string; bytes: number },
    container: DexDebugMetadataResult["container"],
  ): Result<DexDebugMetadataResult, AnalysisError> {
    if (found.length === 0)
      return err(
        this.#inputError(
          "class_descriptor",
          `No class ${descriptor} exists in the selected DEX member(s).`,
        ),
      );
    if (found.length > 1)
      return err(
        this.#inputError(
          "class_descriptor",
          `Class ${descriptor} appears in more than one dex member; select one with entry.`,
        ),
      );
    return ok(buildDexClassDetailResult(artifact, container, found[0]!));
  }

  #rejectIfOversized(
    result: DexDebugMetadataResult,
    path: string,
  ): AnalysisResourceConstraintError | undefined {
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") <=
      DEX_LIMITS.outputBytes
    )
      return undefined;
    return new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      `Decoded DEX detail for ${path} exceeds the inline output budget; select a narrower class.`,
      { maximum_output_bytes: DEX_LIMITS.outputBytes },
    );
  }

  #inputError(
    field: "entry" | "class_descriptor",
    message: string,
  ): AnalysisInputError {
    return new AnalysisInputError(OPERATION, undefined, [
      { path: [field], reason: "invalid_value", message },
    ]);
  }
}
