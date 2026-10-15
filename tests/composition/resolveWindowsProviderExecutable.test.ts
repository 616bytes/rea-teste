import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveWindowsProviderExecutable,
  WINDOWS_PATH_ENTRY_LIMIT,
} from "../../src/composition/resolveWindowsProviderExecutable.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";

const windowsLookup = (cwd: string, files: readonly string[]) => {
  const existingFiles = new Set(
    files.map((path) => win32.normalize(path).toLowerCase()),
  );
  return {
    cwd,
    isFile: (path: string): boolean =>
      existingFiles.has(win32.normalize(path).toLowerCase()),
  };
};

describe("resolveWindowsProviderExecutable", () => {
  it("resolves a bare name from quoted and relative Windows PATH entries", () => {
    const cwd = "C:\\work";
    const expected = "C:\\work\\Program Files\\REA Tools\\objdump.EXE";
    expect(
      resolveWindowsProviderExecutable(
        "objdump",
        {
          PATH: `.;".\\Program Files\\REA Tools";D:\\unused`,
          PATHEXT: ".COM;.EXE;.BAT",
        },
        windowsLookup(cwd, [expected]),
      ),
    ).toBe(expected);
  });

  it("resolves a relative configured path against the caller's Windows CWD", () => {
    expect(
      resolveWindowsProviderExecutable(
        ".\\tools\\objdump.exe",
        {},
        windowsLookup("D:\\analysis", []),
      ),
    ).toBe("D:\\analysis\\tools\\objdump.exe");
  });

  it("resolves relative PATH hits to absolute drive paths", () => {
    const expected = "D:\\analysis\\bin\\rizin.EXE";
    expect(
      resolveWindowsProviderExecutable(
        "rizin",
        { PATH: ".\\bin", PATHEXT: ".EXE" },
        windowsLookup("D:\\analysis", [expected]),
      ),
    ).toBe(expected);
  });

  it("skips script extensions and preserves a caller-selected absolute path", () => {
    const expected = "C:\\tools\\rizin.EXE";
    const selected = "C:\\tools\\rizin.exe";
    expect(
      resolveWindowsProviderExecutable(
        "rizin",
        { PATH: "C:\\tools", PATHEXT: ".CMD;.BAT;.EXE;.COM" },
        windowsLookup("C:\\work", ["C:\\tools\\rizin.CMD", expected]),
      ),
    ).toBe(expected);
    expect(
      resolveWindowsProviderExecutable(
        selected,
        {},
        windowsLookup("D:\\work", []),
      ),
    ).toBe(selected);
  });

  it("keeps unresolved bare command names unchanged", () => {
    expect(
      resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: ".\\tools", PATHEXT: ".EXE" },
        windowsLookup("C:\\work", []),
      ),
    ).toBe("missing-tool");
  });

  it("preserves an absolute UNC selection verbatim instead of re-rooting it", () => {
    // win32.resolve appends a separator to a share root and rewrites forward
    // separators, so a UNC selection must bypass the CWD-relative resolution.
    const shareRoot = "\\\\server\\share";
    const forwardSlashed = "//server/share/Program Files/objdump.exe";
    const lookup = windowsLookup("D:\\work", []);
    expect(resolveWindowsProviderExecutable(shareRoot, {}, lookup)).toBe(
      shareRoot,
    );
    expect(resolveWindowsProviderExecutable(forwardSlashed, {}, lookup)).toBe(
      forwardSlashed,
    );
  });

  it("resolves a bare name through a UNC PATH entry", () => {
    const expected = "\\\\server\\share\\bin\\objdump.EXE";
    expect(
      resolveWindowsProviderExecutable(
        "objdump",
        { PATH: "\\\\server\\share\\bin;D:\\unused", PATHEXT: ".EXE" },
        windowsLookup("D:\\work", [expected]),
      ),
    ).toBe(expected);
  });

  it("keeps an unresolved bare name unchanged when PATH entries are UNC", () => {
    expect(
      resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: "\\\\server\\share\\empty", PATHEXT: ".EXE" },
        windowsLookup("D:\\work", []),
      ),
    ).toBe("missing-tool");
  });

  it("caps PATH probing at the stated entry limit", () => {
    // Entry `WINDOWS_PATH_ENTRY_LIMIT` (the 65th) is beyond the cap and is
    // never probed, while the entry at `WINDOWS_PATH_ENTRY_LIMIT - 1` still is.
    const withinCap = `D:\\entry${WINDOWS_PATH_ENTRY_LIMIT - 1}\\objdump.EXE`;
    const beyondCap = `D:\\entry${WINDOWS_PATH_ENTRY_LIMIT}\\objdump.EXE`;
    const path = Array.from(
      { length: WINDOWS_PATH_ENTRY_LIMIT + 1 },
      (_unused, index) => `D:\\entry${index}`,
    ).join(";");
    const environment = { PATH: path, PATHEXT: ".EXE" };
    expect(
      resolveWindowsProviderExecutable(
        "objdump",
        environment,
        windowsLookup("D:\\work", [beyondCap]),
      ),
    ).toBe("objdump");
    expect(
      resolveWindowsProviderExecutable(
        "objdump",
        environment,
        windowsLookup("D:\\work", [withinCap]),
      ),
    ).toBe(withinCap);
  });

  it("passes an absolute selected command through provider composition", () => {
    const commands = createReverseEngineeringCommandPort(
      { REA_OBJDUMP_COMMAND: "C:\\tools\\objdump.exe" },
      "win32",
    );
    expect(
      commands.objdump({ path: "artifact", operation: "file_headers" })
        .executable,
    ).toBe("C:\\tools\\objdump.exe");
  });
});
