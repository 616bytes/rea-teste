import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { readBinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import { BinaryNinjaProvider } from "./BinaryNinjaProvider.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const registration = async (value: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "rea-binary-ninja-config-"));
  roots.push(root);
  const path = join(root, "binary-ninja-mcp.json");
  await writeFile(path, JSON.stringify(value));
  return path;
};

const provider = (path?: string) => {
  const config = parseConfig(
    path === undefined ? {} : { REA_BINARY_NINJA_MCP_CONFIG: path },
  );
  if (!config.ok) throw config.error;
  return new BinaryNinjaProvider(config.value);
};

const pe = (managed: boolean): BinaryTarget => ({
  path: "/tmp/app.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed,
});

describe("Binary Ninja registration", () => {
  it("accepts the GUI server URL with an optional header, alone or in a client envelope", async () => {
    const direct = readBinaryNinjaConfiguration(
      await registration({ url: "http://127.0.0.1:24642/mcp" }),
    );
    expect(direct.ok && direct.value).toMatchObject({
      timeoutMs: 300_000,
      headers: {},
    });
    const envelope = readBinaryNinjaConfiguration(
      await registration({
        mcpServers: {
          "binaryninja-gui": {
            url: "http://[::1]:24642/mcp",
            headers: { Authorization: "Bearer t" },
          },
        },
      }),
    );
    expect(envelope.ok).toBe(true);
  });

  it("rejects non-loopback hosts, URL credentials, queries and ambiguous envelopes", async () => {
    for (const value of [
      { url: "http://192.168.1.2:24642/mcp" },
      { url: "http://localhost:24642/mcp" },
      { url: "http://user:pass@127.0.0.1:24642/mcp" },
      { url: "http://127.0.0.1:24642/mcp?token=x" },
      { url: "http://127.0.0.1:24642/mcp", command: "binaryninja_mcp" },
      {
        mcpServers: {
          a: { url: "http://127.0.0.1:1/mcp" },
          b: { url: "http://127.0.0.1:2/mcp" },
        },
      },
    ])
      expect(readBinaryNinjaConfiguration(await registration(value)).ok).toBe(
        false,
      );
  });
});

describe("Binary Ninja provider", () => {
  it("is not configured without a registration, so auto selection stays unambiguous", () => {
    expect(provider().inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
  });

  it("reports an invalid registration as invalid open options", async () => {
    const path = await registration({ url: "http://example.com/mcp" });
    expect(provider(path).inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "open_options_invalid",
    });
  });

  it("admits PE, ELF and thin Mach-O executables only", async () => {
    const candidate = provider(
      await registration({ url: "http://127.0.0.1:24642/mcp" }),
    );
    expect(candidate.inspectTargetSupport(pe(false)).status).toBe("supported");
    expect(candidate.inspectTargetSupport(pe(true))).toMatchObject({
      code: "managed_target_unsupported",
    });
    expect(
      candidate.inspectTargetSupport({
        path: "/tmp/fw.bin",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "raw-binary",
        architecture: "arm",
        availableArchitectures: ["arm"],
        entryPoint: "0x0",
        entryPointSource: "0x0",
      }),
    ).toMatchObject({ code: "target_format_unsupported" });
    expect(
      candidate.inspectTargetSupport({
        path: "/tmp/db.bndb",
        sha256: "a".repeat(64),
        kind: "database",
        format: "analysis-database",
      }),
    ).toMatchObject({ code: "target_kind_unsupported" });
  });

  it("commits registration settings without credential-derived values", async () => {
    const first = await provider(
      await registration({
        url: "http://127.0.0.1:24642/mcp",
        headers: { Authorization: "Bearer one" },
      }),
    ).resolveAnalysisProfile(pe(false));
    const second = await provider(
      await registration({
        url: "http://127.0.0.1:24642/mcp",
        headers: { Authorization: "Bearer two" },
      }),
    ).resolveAnalysisProfile(pe(false));
    if (!first.ok || !second.ok) throw new Error("expected profiles");
    expect(first.value.profile?.digest).toBe(second.value.profile?.digest);
    expect(JSON.stringify(first.value.profile)).not.toContain("one");
  });
});
