import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

// Moonshot's function-calling API rejects requests while any single tool
// parameters schema exceeds its literal serialized size cap. Community
// measurements bound the cap between ~13.7 KB (accepted) and ~15 KB
// (rejected); 13 KiB leaves margin under the lower bound. See
// https://github.com/morluto/rea/issues/1484 for the measured evidence.
export const COMPACT_INPUT_SCHEMA_BUDGET_BYTES = 13 * 1024;

export const mcpInputSchemaProfileSchema = z.enum(["full", "compact"]);

/** Select the exact compact presentation budget shared by registration and identity. */
export const compactPresentationForMcpInputSchemaProfile = (
  profile: "full" | "compact" | undefined,
): { readonly budgetBytes: number } | undefined =>
  profile === "compact"
    ? { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES }
    : undefined;

const profileConstraint =
  'REA_MCP_INPUT_SCHEMA_PROFILE must be "full" (default) or "compact". The compact profile advertises bounded input schemas with fewer nested annotations for providers with schema compatibility constraints.';

export type McpInputSchemaProfile = z.infer<typeof mcpInputSchemaProfileSchema>;

/**
 * Clients whose connector rejects an oversized single-tool schema, so setup
 * selects the bounded advertisement unless the caller chose a profile.
 * Moonshot's cap is measured in COMPACT_INPUT_SCHEMA_BUDGET_BYTES; Claude
 * Desktop fails to register `compare_web_captures` while the full profile
 * advertises that tool's 179,878-byte schema (issue #4081).
 */
export const compactInputSchemaProfileByDefault = (
  clientName: string,
): boolean => clientName === "kimi" || clientName === "claude_desktop";

/** Parse the advertised input schema presentation selection. */
export const parseMcpInputSchemaProfile = (
  value: string | undefined,
): Result<McpInputSchemaProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpInputSchemaProfileSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(profileConstraint, {
          settings: [
            {
              setting: "REA_MCP_INPUT_SCHEMA_PROFILE",
              constraint: profileConstraint,
            },
          ],
        }),
      );
};
