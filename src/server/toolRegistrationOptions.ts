import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";

const retainedInventoryReceiptSchema = z.strictObject({
  operation: z.enum(["list_procedures", "list_strings"]),
  delivery: z.literal("retained-inventory"),
  total_items: z.number().int().nonnegative(),
  message: z.string(),
  evidence_id: z.string().min(1),
  evidence_reference: z.strictObject({
    kind: z.literal("retained-evidence"),
    evidence_id: z.string().min(1),
  }),
  continuation: z.strictObject({
    name: z.literal("inspect_analysis_view"),
    arguments: z.record(z.string(), z.unknown()),
  }),
});

/** Preserve advertised contracts while the application owns structured input failures. */
export const applicationValidatedInputSchema = (
  schema: StandardSchemaWithJSON,
): StandardSchemaWithJSON => ({
  "~standard": {
    ...schema["~standard"],
    vendor: "rea-application",
    validate: (value: unknown) => ({ value }),
  },
});

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = <Contract extends ToolContract>(
  contract: Contract,
): {
  readonly title: Contract["title"];
  readonly description: Contract["description"];
  readonly inputSchema: Contract["inputSchema"];
  readonly outputSchema: StandardSchemaWithJSON;
  readonly annotations: Contract["annotations"];
} => {
  const outputSchema =
    contract.name === "list_procedures" || contract.name === "list_strings"
      ? z.union([contract.outputSchema, retainedInventoryReceiptSchema])
      : contract.outputSchema;
  const outputContract = { ...contract, outputSchema } as Contract;

  return {
    title: contract.title,
    description: contract.description,
    inputSchema: toolInputSchemaWithMetadata(contract),
    outputSchema: toolOutputSchemaWithMetadata(outputContract),
    annotations: contract.annotations,
  };
};
