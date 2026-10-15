import { expect, it } from "vitest";

import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";

it("keeps POSIX parent components for the filesystem to resolve", () => {
  const posix = { cwd: "/work", platform: "linux" } as const;
  expect(absoluteCallerPath("link/../sample", posix)).toBe(
    "/work/link/../sample",
  );
  expect(absoluteCallerPath("/abs/link/../sample", posix)).toBe(
    "/abs/link/../sample",
  );
  expect(absoluteCallerPath("sample", { ...posix, cwd: "/" })).toBe("/sample");
  expect(absoluteCallerPath("./a//b", { ...posix, cwd: "/work/" })).toBe(
    "/work/./a//b",
  );
});

it("uses lexical resolution on Windows, where it is exact", () => {
  const win32 = { cwd: "C:\\work", platform: "win32" } as const;
  expect(absoluteCallerPath("link\\..\\sample", win32)).toBe(
    "C:\\work\\sample",
  );
  expect(absoluteCallerPath("D:\\x\\..\\y", win32)).toBe("D:\\y");
});
