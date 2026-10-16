import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PackerIndicatorsPort } from "./PackerIndicatorsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPackerIndicatorsInputSchema,
  packerIndicatorsSchema,
  type PackerIndicators,
} from "../../domain/native/packerIndicators.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class PackerIndicatorsService {
  constructor(readonly provider: PackerIndicatorsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_packer_indicators";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectPackerIndicatorsInputSchema.safeParse(rawInput);
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
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = packerIndicatorsSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      !validReport(report.data, input.data.max_file_bytes)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Packer indicator provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          format: value.format.startsWith("pe") ? "pe" : "elf",
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
    );
  }
}

/** Every reported location stays inside the snapshot and every reference resolves. */
const validReport = (report: PackerIndicators, maxBytes: number): boolean => {
  const size = report.artifact.bytes;
  const inside = ({ offset, bytes }: { offset: number; bytes: number }) =>
    bytes === 0 || offset <= size - bytes;
  const region = (index: number | null) =>
    index === null || report.regions[index]?.index === index;
  return (
    size <= maxBytes &&
    report.regions.every(
      (item, index) => item.index === index && inside(item.raw),
    ) &&
    region(report.entry_point.region_index) &&
    (report.entry_point.file_offset === null ||
      report.entry_point.file_offset < size) &&
    report.signatures.section_names.every(
      (item) => region(item.region_index) && inside(item.location),
    ) &&
    report.signatures.magic.every((item) => inside(item.location)) &&
    report.signatures.magic_matches_total >= report.signatures.magic.length &&
    (report.overlay === null ||
      report.overlay.location.offset + report.overlay.location.bytes === size)
  );
};
