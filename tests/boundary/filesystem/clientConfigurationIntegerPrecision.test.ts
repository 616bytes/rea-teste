import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const COMMAND = ["rea", "mcp"];
/** The largest value TOML 1.0 and the native clients accept. */
const EXACT_MAXIMUM = "9223372036854775807";

it.each([
  ["codex", "toml"],
  ["grok", "grok"],
] as const)(
  "preserves an exact signed 64-bit setting through %s registration",
  async (name, format) => {
    const root = await createTestTempDirectory("rea-setup-integer-");
    const configPath = join(root, "config.toml");
    const client = { name, format, configPath };
    const original = `[history]\nmax_bytes = ${EXACT_MAXIMUM}\n`;
    await writeFile(configPath, original);
    expect(await inspectClientConfiguration(client, {}, COMMAND)).toMatchObject(
      { status: "update" },
    );
    expect(
      await configureClientConfiguration(client, {}, COMMAND),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    // The registration edit must keep the client's own value, not round it.
    expect(configured).toContain(`max_bytes = ${EXACT_MAXIMUM}`);
    expect(
      (
        parseClientConfiguration(configured, format).document.history as {
          max_bytes?: unknown;
        }
      ).max_bytes,
    ).toBe(BigInt(EXACT_MAXIMUM));
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await clientConfigurationAligned(client, {}, COMMAND)).toBe(true);
    expect(await configureClientConfiguration(client, {}, COMMAND)).toEqual({
      status: "unchanged",
    });
  },
);

it("still refuses a client integer outside the signed 64-bit range", async () => {
  const root = await createTestTempDirectory("rea-setup-integer-range-");
  const configPath = join(root, "config.toml");
  const client = { name: "codex", format: "toml", configPath } as const;
  await writeFile(configPath, "[history]\nmax_bytes = 9223372036854775808\n");
  expect(await inspectClientConfiguration(client, {}, COMMAND)).toMatchObject({
    status: "invalid",
  });
});
