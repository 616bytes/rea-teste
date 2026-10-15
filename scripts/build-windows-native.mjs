#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = "22.19.0";
const cache = join(homedir(), ".cache", "rea-windows-native");
const arguments_ = process.argv.slice(2);
const inspectionFixture = arguments_.includes("--inspection-fixture");
const archFlag = arguments_.find((argument) => argument.startsWith("--arch="));
const architecture = archFlag?.slice("--arch=".length) ?? "x64";
if (architecture !== "x64" && architecture !== "arm64")
  throw new Error("Windows native --arch must be x64 or arm64");
const allowed = new Set(
  [inspectionFixture ? "--inspection-fixture" : undefined, archFlag].filter(
    (argument) => argument !== undefined,
  ),
);
if (arguments_.some((argument) => !allowed.has(argument)))
  throw new Error("Unknown Windows native build argument");
const compilerPrefix =
  architecture === "arm64" ? "aarch64-w64-mingw32" : "x86_64-w64-mingw32";
const compiler = `${compilerPrefix}-g++`;
const output = inspectionFixture
  ? join(root, ".cache", "windows-native-inspection-fixture")
  : join(root, "native", "windows", "build");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: 120_000,
  });
  if (result.error !== undefined)
    throw new Error(
      `Windows native build lane requires ${command}: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `Windows native build failed: ${result.stdout}${result.stderr}`,
    );
  return result.stdout;
};
if (process.platform !== "linux")
  throw new Error(
    "The Windows native artifact build lane currently requires Linux and MinGW-w64.",
  );
run(compiler, ["--version"]);
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const fetchBytes = async (name) => {
  const response = await fetch(
    `https://nodejs.org/dist/v${nodeVersion}/${name}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Node build prerequisite download failed: ${name}: HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
};
const checksums = (await fetchBytes("SHASUMS256.txt")).toString("utf8");
const verifiedDownload = async (name, path) => {
  if (!(await exists(path))) await writeFile(path, await fetchBytes(name));
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const expected = checksums
    .split("\n")
    .find((line) => line.slice(66) === name)
    ?.slice(0, 64);
  if (expected === undefined || digest !== expected)
    throw new Error(`Node build prerequisite SHA-256 mismatch: ${name}`);
};
const cachedHeaders = join(
  homedir(),
  ".cache",
  "node-gyp",
  nodeVersion,
  "include",
  "node",
);
let headers = cachedHeaders;
if (!(await exists(join(headers, "node_api.h")))) {
  const archive = join(cache, `node-v${nodeVersion}-headers.tar.gz`);
  await verifiedDownload(`node-v${nodeVersion}-headers.tar.gz`, archive);
  run("tar", ["xzf", archive, "-C", cache]);
  headers = join(cache, `node-v${nodeVersion}`, "include", "node");
}
const artifactNames = {
  x64: "rea-windows-x64.node",
  arm64: "rea-windows-arm64.node",
};
const artifact = artifactNames[architecture];
// MSVC short-import libraries do not produce a correct Node import table with
// GNU ld. Generate a GNU delay-import library for the exact stable Node-API
// symbols; addon.cc binds it to the host executable, whatever its file name.
const sources = ["addon.cc", "filesystem.cc", "process.cc"];
const sourceText = (
  await Promise.all(
    sources.map((path) =>
      readFile(join(root, "native", "windows", "src", path), "utf8"),
    ),
  )
).join("\n");
const buildInputs = [
  "native/windows/src/addon.cc",
  "native/windows/src/authority.hpp",
  inspectionFixture
    ? "tests/fixtures/windows-native-inspection-failure.cc"
    : "native/windows/src/filesystem.cc",
  "native/windows/src/process.cc",
];
const buildInputBytes = await Promise.all(
  buildInputs.map((path) => readFile(join(root, path))),
);
const sourceHash = createHash("sha256")
  .update(`node:${nodeVersion}\n`)
  .update(`fixture:${String(inspectionFixture)}\n`);
for (const [index, path] of buildInputs.entries()) {
  sourceHash.update(`${path}\0`);
  sourceHash.update(buildInputBytes[index]);
  sourceHash.update("\0");
}
const sourceSha256 = sourceHash.digest("hex");
const symbols = [
  ...new Set(
    [...sourceText.matchAll(/\b(napi_[a-z0-9_]+)\s*\(/gu)].map(
      (match) => match[1],
    ),
  ),
].sort();
const definition = join(cache, "node-api.def");
const library = join(cache, `libnode-api-${architecture}.a`);
await writeFile(
  definition,
  `LIBRARY node.exe\nEXPORTS\n${symbols.join("\n")}\n`,
);
run(
  `${compilerPrefix}-dlltool`,
  architecture === "arm64"
    ? ["-d", definition, "-l", library]
    : ["-d", definition, "-y", library],
);
run(compiler, [
  "-std=c++17",
  "-O2",
  "-DNAPI_VERSION=8",
  "-D_WIN32_WINNT=0x0A00",
  "-shared",
  "-static",
  "-static-libgcc",
  "-static-libstdc++",
  "-Wl,--no-insert-timestamp",
  ...(architecture === "arm64" ? ["-Wl,--delayload=node.exe"] : []),
  `-I${headers}`,
  "native/windows/src/addon.cc",
  inspectionFixture
    ? "tests/fixtures/windows-native-inspection-failure.cc"
    : "native/windows/src/filesystem.cc",
  "native/windows/src/process.cc",
  library,
  ...(architecture === "arm64" ? ["-ldelayimp"] : []),
  "-ladvapi32",
  "-lbcrypt",
  "-lntdll",
  "-o",
  join(output, artifact),
]);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const bytes = await readFile(join(output, artifact));
const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
const manifestPath = join(output, "manifest.json");
const existingArtifacts = {};
if (await exists(manifestPath)) {
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      previous?.packageVersion === packageJson.version &&
      previous?.abiVersion === 1 &&
      previous?.nodeApiVersion === 8 &&
      previous?.sourceSha256 === sourceSha256
    ) {
      const candidates = previous.artifacts ?? {
        [previous.architecture]: {
          artifact: previous.artifact,
          artifactSha256: previous.artifactSha256,
        },
      };
      for (const [arch, entry] of Object.entries(candidates)) {
        const expectedName = artifactNames[arch];
        if (
          expectedName !== undefined &&
          entry?.artifact === expectedName &&
          typeof entry?.artifactSha256 === "string" &&
          (await exists(join(output, expectedName)))
        ) {
          const existingBytes = await readFile(join(output, expectedName));
          const existingDigest = createHash("sha256")
            .update(existingBytes)
            .digest("hex");
          if (existingDigest === entry.artifactSha256)
            existingArtifacts[arch] = {
              artifact: expectedName,
              artifactSha256: existingDigest,
            };
        }
      }
    }
  } catch {
    // Replace unreadable or stale manifest state with the newly built target.
  }
}
const artifacts = {
  ...existingArtifacts,
  [architecture]: { artifact, artifactSha256 },
};
for (const [arch, fileName] of Object.entries(artifactNames)) {
  if (artifacts[arch] === undefined)
    await rm(join(output, fileName), { force: true });
}
const primaryArchitecture =
  artifacts.x64 !== undefined && architecture !== "arm64"
    ? "x64"
    : architecture;
const primaryEntry = artifacts[primaryArchitecture];
const metadata = {
  packageVersion: packageJson.version,
  platform: "win32",
  architecture: primaryArchitecture,
  abiVersion: 1,
  nodeApiVersion: 8,
  artifact: primaryEntry.artifact,
  artifactSha256: primaryEntry.artifactSha256,
  sourceSha256,
  artifacts,
};
await writeFile(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ...metadata, artifactBytes: bytes.length })}\n`,
);
