import { z } from "zod";

const range = z.strictObject({
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
});
const address = z.string().regex(/^0x[0-9a-f]{1,16}$/u);

/** Compiler-declared function names and entry coordinates, not recovered source or behavior. */
export const goFunctionEntrySchema = z.strictObject({
  name: z.string().min(1),
  entry_address: address,
  file_offset: z.number().int().nonnegative(),
  table_row_offset: z.number().int().nonnegative(),
  function_data_offset: z.number().int().nonnegative(),
  name_location: range,
});

/** Unknown coverage is explicit; an unavailable table never asserts that no functions exist. */
export const goFunctionTableSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("not-requested"),
    entries: z.array(goFunctionEntrySchema).max(0),
  }),
  z.strictObject({
    state: z.literal("complete"),
    layout: z.literal("go1.20-pclntab"),
    table: range,
    text_start: address,
    declared_text_start: address,
    text_start_source: z.literal(".text-section"),
    entries: z.array(goFunctionEntrySchema),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    table: range.nullable(),
    reason: z.enum(["not-found", "unsupported", "malformed"]),
    limitation: z.string(),
    entries: z.array(goFunctionEntrySchema).max(0),
  }),
]);

export type GoFunctionTable = z.infer<typeof goFunctionTableSchema>;
export type GoFunctionEntry = z.infer<typeof goFunctionEntrySchema>;
