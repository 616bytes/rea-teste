import { z } from "zod";

/**
 * GNU objdump facets of one artifact. The dynamic facets answer which shared
 * libraries an executable needs (private_headers lists DT_NEEDED) and which
 * functions it imports (dynamic_symbols, dynamic_relocations); stripped
 * binaries keep these when their static symbol and relocation tables are gone.
 */
export const OBJDUMP_ARTIFACT_OPERATIONS = [
  "file_headers",
  "private_headers",
  "section_headers",
  "symbols",
  "dynamic_symbols",
  "relocations",
  "dynamic_relocations",
  "dwarf",
  "disassemble",
  "disassemble_all",
] as const;

const objdumpArtifactInputSchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum(OBJDUMP_ARTIFACT_OPERATIONS),
    follow_debug_links: z.boolean().default(false),
  })
  .strict();

/** Caller-selected artifact facet or pathless provider capability query. */
export const objdumpInputSchema = z.discriminatedUnion("operation", [
  objdumpArtifactInputSchema,
  z.strictObject({ operation: z.literal("architectures") }),
]);

/** Caller-selected Rizin command against one local artifact. */
export const rizinInputSchema = z
  .object({
    path: z.string().min(1),
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n\u0000]/u.test(value),
        "A single command line is required",
      ),
  })
  .strict();

export type ObjdumpInput = z.input<typeof objdumpInputSchema>;
export type RizinInput = z.input<typeof rizinInputSchema>;
