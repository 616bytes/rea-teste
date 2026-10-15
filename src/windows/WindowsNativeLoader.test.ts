import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  loadWindowsNativeAuthority,
  type WindowsNativeLoadHost,
} from "./WindowsNativeLoader.js";

const fixture = (
  capabilities: {
    protocolStdin?: boolean;
    jobMemoryLimit?: unknown;
    privateBridgeDescriptorAccess?: unknown;
  } = {},
  architecture: "x64" | "arm64" = "x64",
) => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  const manifest = {
    packageVersion: "1.0.0",
    platform: "win32",
    architecture,
    abiVersion: 1,
    nodeApiVersion: 8,
    artifact:
      architecture === "arm64"
        ? "rea-windows-arm64.node"
        : "rea-windows-x64.node",
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSha256: "a".repeat(64),
  };
  const identity = {
    requestedPath: "D:\\fixture\\runtime",
    finalPath: "\\\\?\\D:\\fixture\\runtime",
    filesystem: "NTFS",
    volumeSerial: "0123456789abcdef",
    fileId: "0123456789abcdef0123456789abcdef",
    size: 0,
    directory: true,
  };
  let reads = 0;
  let loads = 0;
  const host: WindowsNativeLoadHost = {
    platform: "win32",
    architecture,
    nodeApiVersion: "8",
    packageVersion: "1.0.0",
    readManifest: () => manifest,
    readArtifact: () => {
      reads++;
      return bytes;
    },
    loadArtifact: () => {
      loads++;
      return {
        call: () => ({
          abiVersion: 1,
          nodeApiVersion: 8,
          architecture,
          filesystem: identity,
          privateDacl: true,
          privateBridgeDescriptorAccess: true,
          atomicJobAssignment: true,
          killOnOwnerClose: true,
          ...capabilities,
        }),
      };
    },
  };
  return {
    host,
    manifest,
    bytes,
    reads: () => reads,
    loads: () => loads,
  };
};

describe("packaged Windows native compatibility", () => {
  it.each([true, false])(
    "preserves protocol stdin capability %s alongside existing job controls",
    (protocolStdin) => {
      const value = fixture({ protocolStdin });
      expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
        available: true,
        authority: {
          inspection: {
            protocolStdin,
            atomicJobAssignment: true,
            killOnOwnerClose: true,
          },
        },
      });
    },
  );
  it("admits the Job Object memory limit control only as an affirmative observation", () => {
    expect(
      loadWindowsNativeAuthority(fixture({ jobMemoryLimit: true }).host),
    ).toMatchObject({
      available: true,
      authority: { inspection: { jobMemoryLimit: true } },
    });
    // Earlier artifacts omit the control; callers must refuse a limit then.
    const earlier = loadWindowsNativeAuthority(fixture().host);
    if (!earlier.available) throw new Error(earlier.reason);
    expect(earlier.authority.inspection.jobMemoryLimit).toBeUndefined();
    expect(
      loadWindowsNativeAuthority(fixture({ jobMemoryLimit: false }).host)
        .available,
    ).toBe(false);
  });
  it("loads only after compatibility and digest checks, preserving producer identity", () => {
    const value = fixture();
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: true,
      authority: {
        inspection: { filesystem: { requestedPath: "D:\\fixture\\runtime" } },
      },
    });
    expect(value.loads()).toBe(1);
  });

  it.each([
    [{ platform: "linux" as const }, "host"],
    [{ architecture: "ia32" }, "host"],
    [{ nodeApiVersion: "7" }, "host"],
    [{ nodeApiVersion: undefined }, "host"],
    [{ packageVersion: "2.0.0" }, "artifact"],
  ] as const)(
    "rejects incompatible host metadata before loading: %j",
    (override, failureStage) => {
      const value = fixture();
      expect(
        loadWindowsNativeAuthority({ ...value.host, ...override }),
      ).toMatchObject({ available: false, failureStage });
      expect(value.loads()).toBe(0);
    },
  );

  it("names the absent packaged manifest and matching-version recovery", () => {
    const value = fixture();
    const missing = Object.assign(new Error("file absent"), {
      code: "ENOENT",
    });
    expect(
      loadWindowsNativeAuthority({
        ...value.host,
        readManifest: () => {
          throw missing;
        },
      }),
    ).toMatchObject({
      available: false,
      failureStage: "artifact",
      reason: expect.stringMatching(
        /Missing packaged Windows native file native\/windows\/build\/manifest\.json \(ENOENT\).*native\/windows\/build\/rea-windows-x64\.node.*native\/windows\/README\.md/u,
      ),
    });
    expect(value.loads()).toBe(0);
  });
});

describe("packaged Windows native artifact validation", () => {
  it("rejects tampering even when the original file was a valid PE image", () => {
    const value = fixture();
    value.bytes[127] = 1;
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: false,
      failureStage: "artifact",
      reason: expect.stringContaining("SHA-256"),
    });
    expect(value.loads()).toBe(0);
  });

  it.each([
    "abiVersion",
    "nodeApiVersion",
    "architecture",
    "artifact",
    "sourceSha256",
  ])("rejects invalid manifest %s", (key) => {
    const value = fixture();
    expect(
      loadWindowsNativeAuthority({
        ...value.host,
        readManifest: () => ({ ...value.manifest, [key]: "invalid" }),
      }).available,
    ).toBe(false);
    expect(value.loads()).toBe(0);
  });

  it.each([
    { signature: "MZ", offset: 0 },
    { signature: "PE", offset: 64 },
  ])(
    "rejects digest-valid high-bit $signature lookalikes before loading",
    ({ offset }) => {
      const value = fixture();
      value.bytes[offset] = (value.bytes[offset] ?? 0) | 0x80;
      value.manifest.artifactSha256 = createHash("sha256")
        .update(value.bytes)
        .digest("hex");
      expect(loadWindowsNativeAuthority(value.host).available).toBe(false);
      expect(value.loads()).toBe(0);
    },
  );

  it("admits an ARM64 host when the packaged artifact matches that machine", () => {
    const value = fixture({}, "arm64");
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: true,
      authority: { inspection: { architecture: "arm64" } },
    });
    expect(value.loads()).toBe(1);
  });

  it("rejects a digest-valid artifact for another machine", () => {
    const value = fixture();
    value.bytes.writeUInt16LE(0xaa64, 68);
    value.manifest.artifactSha256 = createHash("sha256")
      .update(value.bytes)
      .digest("hex");
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: false,
      reason: expect.stringContaining("PE32+"),
    });
    expect(value.loads()).toBe(0);
  });

  it("preserves host permission failure rather than promoting a partial probe", () => {
    const value = fixture();
    expect(
      loadWindowsNativeAuthority({
        ...value.host,
        loadArtifact: () => ({
          call: () => {
            throw new Error("private DACL: access denied");
          },
        }),
      }),
    ).toMatchObject({
      available: false,
      failureStage: "self-test",
      retryable: true,
      reason: expect.stringContaining("private DACL: access denied"),
    });
  });

  it("requires every inspected native fact", () => {
    const value = fixture();
    const loaded = loadWindowsNativeAuthority({
      ...value.host,
      loadArtifact: () => ({ call: () => ({ privateDacl: true }) }),
    });
    expect(loaded.available).toBe(false);
    expect(loaded).toMatchObject({ failureStage: "inspection" });
    expect(loaded).not.toHaveProperty("retryable");
  });

  it("rejects Windows controls without handle-bound Cutter descriptor access", () => {
    const value = fixture({ privateBridgeDescriptorAccess: undefined });
    expect(loadWindowsNativeAuthority(value.host)).toMatchObject({
      available: false,
      reason: expect.stringContaining("privateBridgeDescriptorAccess"),
    });
  });
});

describe("packaged Windows native architecture boundaries", () => {
  it.each([
    ["x64", "arm64", 0xaa64],
    ["arm64", "x64", 0x8664],
  ] as const)(
    "rejects cross-architecture manifest, artifact, PE image, and inspection mismatches on %s hosts",
    (hostArch, otherArch, otherMachine) => {
      const value = fixture({}, hostArch);
      const other = fixture({}, otherArch);

      expect(
        loadWindowsNativeAuthority({
          ...value.host,
          readManifest: () => other.manifest,
        }),
      ).toMatchObject({
        available: false,
        failureStage: "artifact",
        reason: expect.stringContaining("architecture"),
      });
      expect(value.reads()).toBe(0);
      expect(value.loads()).toBe(0);

      expect(
        loadWindowsNativeAuthority({
          ...value.host,
          readManifest: () => ({
            ...value.manifest,
            artifact: other.manifest.artifact,
          }),
        }),
      ).toMatchObject({
        available: false,
        failureStage: "artifact",
        reason: expect.stringContaining("artifact"),
      });
      expect(value.reads()).toBe(0);
      expect(value.loads()).toBe(0);

      const wrongMachine = fixture({}, hostArch);
      wrongMachine.bytes.writeUInt16LE(otherMachine, 68);
      wrongMachine.manifest.artifactSha256 = createHash("sha256")
        .update(wrongMachine.bytes)
        .digest("hex");
      expect(loadWindowsNativeAuthority(wrongMachine.host)).toMatchObject({
        available: false,
        failureStage: "artifact",
        reason: expect.stringContaining("PE32+"),
      });
      expect(wrongMachine.reads()).toBe(1);
      expect(wrongMachine.loads()).toBe(0);

      const wrongInspection = fixture(
        { architecture: otherArch } as Record<string, unknown>,
        hostArch,
      );
      expect(loadWindowsNativeAuthority(wrongInspection.host)).toMatchObject({
        available: false,
        failureStage: "inspection",
        reason: expect.stringContaining("architecture"),
      });
      expect(wrongInspection.loads()).toBe(1);
    },
  );

  it.each([
    ["x64", "arm64"],
    ["arm64", "x64"],
  ] as const)(
    "admits %s hosts from a multi-architecture manifest when top-level metadata records %s",
    (hostArch, topLevelArch) => {
      const current = fixture({}, hostArch);
      const topLevel = fixture({}, topLevelArch);
      const multiManifest = {
        ...topLevel.manifest,
        artifacts: {
          [topLevelArch]: {
            artifact: topLevel.manifest.artifact,
            artifactSha256: topLevel.manifest.artifactSha256,
          },
          [hostArch]: {
            artifact: current.manifest.artifact,
            artifactSha256: current.manifest.artifactSha256,
          },
        },
      };
      expect(
        loadWindowsNativeAuthority({
          ...current.host,
          readManifest: () => multiManifest,
        }),
      ).toMatchObject({
        available: true,
        authority: { inspection: { architecture: hostArch } },
      });
      expect(current.loads()).toBe(1);

      expect(
        loadWindowsNativeAuthority({
          ...current.host,
          readManifest: () => ({
            ...multiManifest,
            artifacts: {
              ...multiManifest.artifacts,
              [topLevelArch]: {
                artifact: current.manifest.artifact,
                artifactSha256: topLevel.manifest.artifactSha256,
              },
            },
          }),
        }),
      ).toMatchObject({
        available: false,
        failureStage: "artifact",
        reason: expect.stringContaining("artifacts table"),
      });
    },
  );
});
