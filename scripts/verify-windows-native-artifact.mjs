#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("native/windows/build/manifest.json", root), "utf8"),
);
const artifactNames = {
  x64: "rea-windows-x64.node",
  arm64: "rea-windows-arm64.node",
};
const machines = { x64: 0x8664, arm64: 0xaa64 };
const verifyEntry = async (architecture, entry) => {
  const artifactName = artifactNames[architecture];
  if (artifactName === undefined)
    throw new Error(
      "Windows native manifest architecture must be x64 or arm64; run the Windows native build lane.",
    );
  const bytes = await readFile(
    new URL(`native/windows/build/${artifactName}`, root),
  );
  if (
    entry?.artifact !== artifactName ||
    createHash("sha256").update(bytes).digest("hex") !== entry?.artifactSha256
  )
    throw new Error(
      "Windows native artifact metadata or SHA-256 does not match this package; run the Windows native build lane.",
    );
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
  if (
    bytes.toString("latin1", 0, 2) !== "MZ" ||
    offset > bytes.length - 26 ||
    bytes.toString("latin1", offset, offset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(offset + 4) !== machines[architecture] ||
    bytes.readUInt16LE(offset + 24) !== 0x20b
  )
    throw new Error(
      "Windows native artifact must be a Windows x64 or ARM64 PE32+ image.",
    );
  return bytes.length;
};
if (
  manifest.packageVersion !== packageJson.version ||
  manifest.platform !== "win32" ||
  manifest.abiVersion !== 1 ||
  manifest.nodeApiVersion !== 8
)
  throw new Error(
    "Windows native artifact metadata or SHA-256 does not match this package; run the Windows native build lane.",
  );
const artifactBytes = await verifyEntry(manifest.architecture, manifest);
if (manifest.artifacts !== undefined) {
  const primary = manifest.artifacts[manifest.architecture];
  if (
    primary?.artifact !== manifest.artifact ||
    primary?.artifactSha256 !== manifest.artifactSha256
  )
    throw new Error(
      "Windows native manifest artifacts table does not match top-level metadata.",
    );
  for (const [architecture, entry] of Object.entries(manifest.artifacts)) {
    if (entry !== undefined) await verifyEntry(architecture, entry);
  }
}
process.stdout.write(
  `${JSON.stringify({ ok: true, ...manifest, artifactBytes })}\n`,
);
