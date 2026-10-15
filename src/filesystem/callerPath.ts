import { posix, win32 } from "node:path";

/**
 * Make a caller-selected local path absolute without changing which file it
 * names. POSIX resolves `..` after following the preceding symlink, so lexical
 * normalization of `link/../file` can select a different file. On POSIX, only
 * `.` segments and repeated or trailing separators are removed, which never
 * change the named file; every `..` is kept for the filesystem to resolve.
 * Win32 resolves `..` lexically, so normalizing there is exact.
 */
export const absoluteCallerPath = (
  path: string,
  {
    cwd = process.cwd(),
    platform = process.platform,
  }: { readonly cwd?: string; readonly platform?: NodeJS.Platform } = {},
): string => {
  if (platform === "win32") return win32.resolve(cwd, path);
  const absolute = posix.isAbsolute(path) ? path : `${cwd}/${path}`;
  const segments = absolute
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return `/${segments.join("/")}`;
};
