import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NeExecutablePort } from "./NeExecutablePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectNeExecutableInputSchema,
  neExecutableSchema,
  type NeExecutable,
} from "../../domain/native/neExecutable.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class NeExecutableService {
  constructor(readonly provider: NeExecutablePort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_ne_executable";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectNeExecutableInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    const report = neExecutableSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      !validReport(report.data, input.data.max_rows, input.data.max_file_bytes)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "NE provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "ne",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
      options?.signal,
    );
  }
}

/** Check cross-field invariants before provider output becomes public Evidence. */
const validReport = (
  report: NeExecutable,
  maxRows: number,
  maxBytes: number,
): boolean => {
  const inside = ({ offset, bytes }: { offset: number; bytes: number }) =>
    offset <= report.artifact.bytes - bytes;
  const rows =
    report.segments.length +
    report.resources.length +
    report.resident_names.length +
    report.nonresident_names.length +
    (report.module_name === null ? 0 : 1) +
    (report.description === null ? 0 : 1) +
    report.module_references.length +
    report.entries.length;
  if (
    report.artifact.bytes > maxBytes ||
    report.coverage.examined_rows > maxRows ||
    report.coverage.examined_rows !== rows ||
    !inside(report.header.location)
  )
    return false;
  const names = [
    report.module_name,
    report.description,
    ...report.resident_names,
    ...report.nonresident_names,
    ...report.module_references,
  ];
  return (
    names.every((name) => name === null || inside(name.location)) &&
    report.segments.every(
      (segment, index) =>
        segment.index === index + 1 &&
        (segment.location === null || inside(segment.location)) &&
        (segment.relocations === null ||
          (segment.location !== null &&
            inside(segment.relocations.location) &&
            segment.relocations.location.offset ===
              segment.location.offset + segment.location.bytes)),
    ) &&
    report.resources.every(
      (resource) =>
        (resource.location === null || inside(resource.location)) &&
        inside(resource.entry_location) &&
        [resource.type, resource.name].every(
          (identity) => identity.kind !== "name" || inside(identity.location),
        ),
    ) &&
    report.module_references.every(
      (reference, index) => reference.index === index + 1,
    ) &&
    report.entries.every(
      (entry, index) =>
        inside(entry.location) &&
        (index === 0 ||
          entry.ordinal > (report.entries[index - 1]?.ordinal ?? 0)),
    )
  );
};
