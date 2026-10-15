import { posix, win32 } from "node:path";

/**
 * Make a caller-selected local path absolute without changing which file it
 * names. POSIX resolves `..` after following the preceding symlink, so lexical
 * normalization of `link/../file` can select a different file; a relative path
 * is only prefixed with the working directory and an absolute path is kept as
 * spelled. Win32 resolves `..` lexically, so normalizing there is exact.
 */
export const absoluteCallerPath = (
  path: string,
  {
    cwd = process.cwd(),
    platform = process.platform,
  }: { readonly cwd?: string; readonly platform?: NodeJS.Platform } = {},
): string => {
  if (platform === "win32") return win32.resolve(cwd, path);
  if (posix.isAbsolute(path)) return path;
  return `${cwd.endsWith("/") ? cwd : `${cwd}/`}${path}`;
};
