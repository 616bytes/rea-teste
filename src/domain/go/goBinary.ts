import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { CANONICAL_BASE64_PATTERN } from "../stringPatterns.js";
import { goFunctionTableSchema } from "./goFunctionTable.js";

const sourceRangeSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
const moduleIdentitySchema = z.strictObject({
  path: z.string(),
  version: z.string(),
  sum: z.string().nullable(),
});

/** Module identities retain development versions, local replacements and missing sums verbatim. */
export const goModuleSchema = moduleIdentitySchema.extend({
  replacement: moduleIdentitySchema.nullable(),
});

/** Parsed records alongside unrecognized text lines and exact non-UTF-8 line bytes. */
export const goModuleMetadataSchema = z.strictObject({
  path: z.string().nullable(),
  main: goModuleSchema.nullable(),
  dependencies: z.array(goModuleSchema),
  settings: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  unparsed_lines: z.array(z.string()),
  unparsed_line_bytes_base64: z.array(
    z.string().regex(CANONICAL_BASE64_PATTERN),
  ),
  complete: z.boolean(),
});

/** One exact local artifact, independent of any active disassembler target. */
export const inspectGoBinaryInputSchema = z.strictObject({
  functions: z
    .boolean()
    .optional()
    .describe(
      "Read supported compiler-declared function entries; omitted/false avoids function-table work and output",
    ),
  path: localPathStringSchema.describe(
    "Absolute filesystem path to the selected executable or library",
  ),
});

/** Compiler-written build information and its original file-backed source ranges. */
export const goBuildInfoSchema = z.strictObject({
  header_offset: z.number().int().nonnegative(),
  encoding: z.enum(["inline", "pointer"]),
  go_version: z.string().nullable(),
  go_version_bytes_base64: z.string().regex(CANONICAL_BASE64_PATTERN),
  module_text: z.string().nullable(),
  module_bytes_base64: z.string().regex(CANONICAL_BASE64_PATTERN),
  version_location: sourceRangeSchema,
  module_location: sourceRangeSchema,
  module: goModuleMetadataSchema,
});

/** Complete bounded build-metadata observation; absence does not identify a binary as non-Go. */
export const goBinarySchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: z.number().int().nonnegative(),
    }),
    format: z.enum(["elf", "pe", "macho"]),
    architecture: z.string(),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    build_info: goBuildInfoSchema.nullable(),
    functions: goFunctionTableSchema,
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const functions = report.functions;
    const table = functions.state === "not-requested" ? null : functions.table;
    const inside = (
      offset: number,
      bytes: number,
      start: number,
      size: number,
    ) => offset >= start && bytes <= size && offset - start <= size - bytes;
    if (
      table !== null &&
      !inside(table.offset, table.bytes, 0, report.artifact.bytes)
    )
      context.addIssue({
        code: "custom",
        path: ["functions", "table"],
        message: "Function table leaves the selected artifact.",
      });
    if (functions.state === "complete") {
      if (
        report.format !== "elf" ||
        report.architecture !== "amd64" ||
        report.bits !== 64 ||
        report.byte_order !== "little"
      )
        context.addIssue({
          code: "custom",
          path: ["functions"],
          message:
            "Complete function coverage requires ELF64 little-endian amd64.",
        });
      let previous = -1n;
      for (const [index, entry] of functions.entries.entries()) {
        const address = BigInt(entry.entry_address);
        if (
          address < BigInt(functions.text_start) ||
          address <= previous ||
          !inside(entry.file_offset, 1, 0, report.artifact.bytes) ||
          !inside(
            entry.table_row_offset,
            8,
            functions.table.offset,
            functions.table.bytes,
          ) ||
          !inside(
            entry.function_data_offset,
            8,
            functions.table.offset,
            functions.table.bytes,
          ) ||
          !inside(
            entry.name_location.offset,
            entry.name_location.bytes + 1,
            functions.table.offset,
            functions.table.bytes,
          )
        )
          context.addIssue({
            code: "custom",
            path: ["functions", "entries", index],
            message:
              "Function coordinates contradict the artifact, table or entry order.",
          });
        previous = address;
      }
    }
    const info = report.build_info;
    if (info === null) return;
    if (info.header_offset > report.artifact.bytes - 32)
      context.addIssue({
        code: "custom",
        path: ["build_info", "header_offset"],
        message: "Build-info header is outside the selected artifact.",
      });
    for (const field of ["version_location", "module_location"] as const) {
      const range = info[field];
      if (
        range.offset > report.artifact.bytes ||
        range.bytes > report.artifact.bytes - range.offset
      )
        context.addIssue({
          code: "custom",
          path: ["build_info", field],
          message: "Build-info source range is outside the selected artifact.",
        });
    }
    for (const [field, range, description] of [
      ["go_version_bytes_base64", info.version_location, "compiler"],
      ["module_bytes_base64", info.module_location, "module"],
    ] as const) {
      const encoded = info[field];
      const padding = encoded.endsWith("==")
        ? 2
        : encoded.endsWith("=")
          ? 1
          : 0;
      if ((encoded.length / 4) * 3 - padding !== range.bytes)
        context.addIssue({
          code: "custom",
          path: ["build_info", field],
          message: `Encoded ${description} bytes do not match their reported source length.`,
        });
    }
  });

export type GoModule = z.infer<typeof goModuleSchema>;
export type GoModuleMetadata = z.infer<typeof goModuleMetadataSchema>;
export type GoBinary = z.infer<typeof goBinarySchema>;
export type InspectGoBinaryInput = z.infer<typeof inspectGoBinaryInputSchema>;
