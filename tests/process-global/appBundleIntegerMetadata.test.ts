import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { resolveAppBundleExecutable } from "../../src/application/AppBundleExecutable.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("resolves an app without arbitrary-precision conversion of unrelated integers", async () => {
  const root = await createTestTempDirectory("rea-app-large-integer-");
  const bundle = join(root, "Fixture.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", "Fixture");
  const digits = "9".repeat(5_000_000);
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(executable, "fixture");
  await writeFile(
    join(contents, "Info.plist"),
    `<plist><dict><key>CFBundleExecutable</key><string>Fixture</string><key>Unrelated</key><integer>${digits}</integer></dict></plist>`,
  );
  const parseInteger = BigInt;
  let largeConversions = 0;
  const conversion = vi
    .spyOn(globalThis, "BigInt")
    .mockImplementation((value) => {
      if (typeof value === "string" && value.length === digits.length) {
        largeConversions += 1;
        // Observe the real resolver without paying for the prohibited conversion.
        throw new Error("Unexpected arbitrary-precision conversion");
      }
      return parseInteger(value);
    });
  try {
    const result = await resolveAppBundleExecutable(bundle);
    expect(largeConversions).toBe(0);
    if (!result.ok) throw result.error;
    expect(result.value.executable).toBe(await realpath(executable));
  } finally {
    conversion.mockRestore();
  }
});
