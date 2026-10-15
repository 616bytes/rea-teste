import { z } from "zod";

import { localPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^0x[0-9a-f]+$/);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Read-only packer indicator inspection of one caller-selected PE or ELF file. */
export const inspectPackerIndicatorsInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to a PE or ELF image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(536870912)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
});

export const packerIndicatorIdSchema = z.enum([
  "packer_section_name",
  "packer_magic",
  "entry_outside_first_section",
  "entry_in_writable_executable_region",
  "entry_outside_mapped_regions",
  "high_entropy_executable_region",
  "virtual_only_region",
  "loader_style_imports_only",
  "elf_without_section_headers",
  "overlay_present",
]);

/** Section or segment facts with file-backed ranges and Shannon entropy. */
const regionSchema = z.strictObject({
  index: uint,
  kind: z.enum(["section", "segment"]),
  name: z.string().nullable(),
  name_hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/)
    .nullable(),
  virtual_address: hex,
  virtual_size: uint,
  raw: range,
  flags_value: uint,
  readable: z.boolean(),
  writable: z.boolean(),
  executable: z.boolean(),
  entropy: z.number().min(0).max(8).nullable(),
});

export const packerIndicatorsSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: uint,
  }),
  format: z.enum(["pe32", "pe32-plus", "elf32", "elf64"]),
  machine: uint,
  regions: z.array(regionSchema),
  entry_point: z.strictObject({
    address: hex,
    region_index: uint.nullable(),
    file_offset: uint.nullable(),
  }),
  signatures: z.strictObject({
    section_names: z.array(
      z.strictObject({
        region_index: uint,
        name: z.string(),
        family: z.string(),
        location: range,
      }),
    ),
    magic: z.array(
      z.strictObject({
        family: z.string(),
        value: z.string(),
        location: range,
      }),
    ),
    magic_matches_total: uint,
  }),
  imports: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_applicable") }),
    z.strictObject({ status: z.literal("absent") }),
    z.strictObject({ status: z.literal("unreadable"), reason: z.string() }),
    z.strictObject({
      status: z.literal("parsed"),
      libraries: z.array(z.string()),
      function_count: uint,
      ordinal_count: uint,
      loader_style_functions: z.array(z.string()),
      only_loader_style: z.boolean(),
    }),
  ]),
  overlay: z
    .strictObject({
      location: range,
      entropy: z.number().min(0).max(8),
      certificate_table: range.nullable(),
    })
    .nullable(),
  indicators: z.array(
    z.strictObject({
      id: packerIndicatorIdSchema,
      strength: z.enum(["strong", "supporting"]),
      detail: z.string(),
    }),
  ),
  verdict: z.strictObject({
    status: z.enum(["likely_packed", "not_observed", "unknown"]),
    basis: z.string(),
  }),
  limitations: z.array(z.string()),
});

export type PackerIndicators = z.infer<typeof packerIndicatorsSchema>;
export type PackerRegion = z.infer<typeof regionSchema>;
export type PackerIndicator = PackerIndicators["indicators"][number];
export type InspectPackerIndicatorsInput = z.infer<
  typeof inspectPackerIndicatorsInputSchema
>;
