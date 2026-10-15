import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

export interface WindowsExecutableLookup {
  /** Windows-formatted working directory; defaults to the process CWD. */
  readonly cwd?: string;
  /** Test seam for Windows paths when running on a non-Windows host. */
  readonly isFile?: (path: string) => boolean;
}

/**
 * Bound on the PATH entries one lookup examines, and on the total candidate
 * probes those entries produce. A real Windows PATH is far shorter than the
 * entry bound, so this leaves every ordinary lookup untouched while keeping a
 * hostile or accidental environment from turning one lookup into an unbounded
 * filesystem walk before dispatch.
 */
export const WINDOWS_PATH_ENTRY_LIMIT = 64;
export const WINDOWS_PATH_PROBE_LIMIT = 128;

/**
 * `\\server\share\...` and `//server/share/...` are UNC roots. A single
 * leading separator is drive- or root-relative, and four leading separators
 * are malformed rather than UNC, so neither may take this branch.
 */
const isUncPath = (value: string): boolean => /^[\\/]{2}(?![\\/])/u.test(value);

const splitWindowsPath = (value: string): readonly string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (value[index] === ";" && !quoted) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.flatMap((entry) => {
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2)
      return [entry.slice(1, -1)];
    return entry.includes('"') ? [] : [entry];
  });
};

const isRegularFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolve Windows bare command names against the captured child environment.
 *
 * The probe is synchronous because the command-port contract it feeds is
 * synchronous (`ReverseEngineeringCommandPort` returns `executable: string`).
 * Its cost is bounded by `WINDOWS_PATH_ENTRY_LIMIT`/`WINDOWS_PATH_PROBE_LIMIT`;
 * a non-blocking probe would need an asynchronous port contract, which this
 * boundary does not own.
 */
export const resolveWindowsProviderExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  lookup: WindowsExecutableLookup = {},
): string => {
  const cwd = lookup.cwd ?? process.cwd();
  const absolute = (...paths: string[]): string => win32.resolve(cwd, ...paths);
  // A UNC selection is already absolute. Return it verbatim instead of
  // re-rooting it against the process drive through win32.resolve(cwd, ...).
  if (isUncPath(executable)) return executable;
  if (
    win32.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    win32.parse(executable).root !== ""
  )
    return absolute(executable);

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (pathValue === undefined) return executable;
  const pathEntries = splitWindowsPath(pathValue);
  const explicitExtension = win32.extname(executable).toLowerCase();
  if (explicitExtension !== "" && ![".com", ".exe"].includes(explicitExtension))
    return executable;
  const extensions =
    explicitExtension !== ""
      ? [""]
      : (environment.PATHEXT ?? environment.PathExt ?? ".COM;.EXE")
          .split(";")
          .filter((extension) =>
            [".com", ".exe"].includes(extension.toLowerCase()),
          );

  const isFile = lookup.isFile ?? isRegularFile;
  let entryCount = 0;
  let probeCount = 0;
  for (const entry of pathEntries) {
    if (entry.length === 0) continue;
    if (entryCount >= WINDOWS_PATH_ENTRY_LIMIT) break;
    entryCount += 1;
    for (const extension of extensions) {
      if (probeCount >= WINDOWS_PATH_PROBE_LIMIT) return executable;
      probeCount += 1;
      // A UNC PATH entry owns its root, so join without the process drive CWD.
      const candidate = isUncPath(entry)
        ? win32.join(entry, `${executable}${extension}`)
        : absolute(entry, `${executable}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return executable;
};
