import { expect, it } from "vitest";
import { nativeWindowsUiCapabilities } from "./NativeWindowsUiProviderMetadata.js";
import type { WindowsWindowCaptureLoadResult } from "./WindowsNativeLoader.js";
const loaded = (): WindowsWindowCaptureLoadResult => ({
  available: true,
  authority: {
    call: () => undefined,
  },
});
it("requires affirmative inspected capture support on the shipped Windows architecture", () => {
  expect(nativeWindowsUiCapabilities("win32", "arm64")[0]).toMatchObject({
    available: false,
    availabilityCode: "unsupported_host",
  });
  expect(nativeWindowsUiCapabilities("win32", "x64", loaded)[0]).toMatchObject({
    available: true,
    cachePolicy: "live",
    effects: { launchesProcess: true },
  });
  expect(
    nativeWindowsUiCapabilities("win32", "x64", () => ({
      available: false,
      reason: "artifact unavailable",
    }))[0],
  ).toMatchObject({ available: false, reason: "artifact unavailable" });
});

it("keeps retryable admission unavailable until a fresh successful snapshot", () => {
  let readiness: WindowsWindowCaptureLoadResult = {
    available: false,
    reason: "Private runtime admission is still unresolved",
    retryable: true,
  };
  const first = nativeWindowsUiCapabilities("win32", "x64", () => readiness);
  expect(first[0]).toMatchObject({
    available: false,
    reason: readiness.reason,
  });
  readiness = loaded();
  expect(
    nativeWindowsUiCapabilities("win32", "x64", () => readiness)[0],
  ).toMatchObject({ available: true });
  expect(first[0]).toMatchObject({ available: false });
});
