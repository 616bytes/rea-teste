import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Largest original input whose bytes REA hashes through the attached Raw view. */
export const BINARY_NINJA_DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;

const loopbackUrl = (value: string): boolean => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    ["127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    !value.includes("?") &&
    !value.includes("#")
  );
};

const registrationSchema = z
  .object({
    type: z.literal("http").optional(),
    url: z
      .url()
      .refine(
        loopbackUrl,
        "Binary Ninja MCP must use a 127.0.0.1 or [::1] HTTP endpoint without URL credentials, query, or fragment",
      ),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(BINARY_NINJA_DEFAULT_MAX_INPUT_BYTES),
  })
  .strict();

/** A GUI MCP server registration: endpoint, optional authorization header, and REA limits. */
export type BinaryNinjaConfiguration = z.infer<typeof registrationSchema>;

const envelopeSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

/**
 * Read one explicit registration without connecting. A client-style
 * `mcpServers` object is accepted when it names exactly one server.
 */
export const readBinaryNinjaConfiguration = (
  path: string,
): Result<BinaryNinjaConfiguration, ConfigurationError> => {
  try {
    if (statSync(path).size > 65_536)
      return err(
        binaryNinjaConfigurationError(
          "REA_BINARY_NINJA_MCP_CONFIG exceeds the 64 KiB registration size.",
        ),
      );
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    const envelope = envelopeSchema.safeParse(input);
    const servers = envelope.success
      ? Object.values(envelope.data.mcpServers)
      : [input];
    if (servers.length !== 1)
      return err(
        binaryNinjaConfigurationError(
          "REA_BINARY_NINJA_MCP_CONFIG must name exactly one Binary Ninja MCP server.",
        ),
      );
    const parsed = registrationSchema.safeParse(servers[0]);
    return parsed.success
      ? ok(parsed.data)
      : err(
          binaryNinjaConfigurationError(
            "REA_BINARY_NINJA_MCP_CONFIG must contain the Binary Ninja GUI MCP url and optional Authorization header; see docs/binary-ninja.md.",
            parsed.error,
          ),
        );
  } catch (cause: unknown) {
    return err(
      binaryNinjaConfigurationError(
        `Cannot read Binary Ninja MCP registration ${path}; provide a readable JSON configuration.`,
        cause,
      ),
    );
  }
};

/** A REA_BINARY_NINJA_MCP_CONFIG rejection that names the setting it concerns. */
export const binaryNinjaConfigurationError = (
  constraint: string,
  cause?: unknown,
): ConfigurationError =>
  new ConfigurationError(constraint, {
    ...(cause === undefined ? {} : { cause }),
    settings: [{ setting: "REA_BINARY_NINJA_MCP_CONFIG", constraint }],
  });
