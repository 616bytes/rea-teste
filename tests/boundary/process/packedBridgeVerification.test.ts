import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import {
  PrivateRuntimeRoot,
  privateRuntimeRootCapability,
} from "../../../src/process/PrivateRuntimeRoot.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const exec = promisify(execFile);
const bridgeUrl = pathToFileURL(
  resolve("scripts/verify-packed-bridge.mjs"),
).href;
const { verifyPackedBridge } = (await import(bridgeUrl)) as {
  verifyPackedBridge: (input: {
    workspace: string;
    tarball: string;
    packedFiles: string[];
  }) => Promise<void>;
};
const packedFiles = [
  "package/bridge/hopper_bridge.py",
  "package/bridge/cutter/rea_bridge.py",
  "package/bridge/ghidra/ReaGhidraBridge.java",
  "package/bridge/ghidra/ReaGhidraBundleActivator.java",
];
const hopper = packedFiles[0]!;
const validSource = 'raise RuntimeError("Packed source must never execute")\n';

async function fixture(source: string = validSource, omitHopper = false) {
  const directory = await createTestTempDirectory("rea-packed-bridge-");
  const staging = join(directory, "source");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  for (const member of packedFiles) {
    if (omitHopper && member === hopper) continue;
    const path = join(staging, member);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, member === hopper ? source : "fixture\n");
  }
  const tarball = join(directory, "packed bridges.tgz");
  await exec("tar", ["-czf", tarball, "-C", staging, "package"]);
  return { workspace, tarball, packedFiles };
}

it("parses packed Python without executing it or extracting archive members", async () => {
  const input = await fixture();
  const sentinel = join(input.workspace, "caller-owned.txt");
  await writeFile(sentinel, "preserved\n");
  await verifyPackedBridge(input);
  expect(await readdir(input.workspace)).toEqual(["caller-owned.txt"]);
  expect(await readFile(sentinel, "utf8")).toBe("preserved\n");
});

it.each(packedFiles)(
  "rejects an unadvertised required member: %s",
  async (member) => {
    const input = await fixture();
    await expect(
      verifyPackedBridge({
        ...input,
        packedFiles: packedFiles.filter((path) => path !== member),
      }),
    ).rejects.toThrow(`package omitted ${member}`);
    expect(await readdir(input.workspace)).toEqual([]);
  },
);

it("rejects a missing actual Python member even when the listing advertises it", async () => {
  const input = await fixture(validSource, true);
  await expect(verifyPackedBridge(input)).rejects.toMatchObject({
    stderr: expect.stringContaining(hopper),
  });
  expect(await readdir(input.workspace)).toEqual([]);
});

it("reports invalid packed Python syntax with the member filename", async () => {
  const input = await fixture("def broken(:\n");
  await expect(verifyPackedBridge(input)).rejects.toMatchObject({
    stderr: expect.stringMatching(/hopper_bridge\.py[\s\S]*SyntaxError/u),
  });
  expect(await readdir(input.workspace)).toEqual([]);
});

it.runIf(
  process.platform === "win32" && privateRuntimeRootCapability().available,
)(
  "reads an archive under a retained native private-root lease and preserves owner cleanup",
  async () => {
    const input = await fixture();
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-packed-bridge-lease-",
    });
    try {
      const pack = join(root.path, "pack");
      await mkdir(pack);
      const tarball = join(pack, "packed bridges.tgz");
      await copyFile(input.tarball, tarball);
      const leasedInput = { workspace: root.path, tarball, packedFiles };
      await verifyPackedBridge(leasedInput);
      expect(await readdir(root.path)).toEqual(["pack"]);
      expect(await readFile(tarball)).toEqual(await readFile(input.tarball));
    } finally {
      await root.close();
    }
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
