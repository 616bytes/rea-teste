import { isAbsolute, posix, win32 } from "node:path";
import { z } from "zod";

/** Ghidra's project marker suffix (`ProjectLocator.PROJECT_FILE_SUFFIX`). */
export const GHIDRA_PROJECT_FILE_SUFFIX = ".gpr";
const MAX_GHIDRA_PROGRAM_PATH_LENGTH = 4096;

/** Caller-selected, already analyzed Ghidra project opened read-only. */
export interface GhidraPersistentProject {
  /** Absolute path of the project's `.gpr` marker file. */
  readonly projectFile: string;
  /** Absolute project path of the Program inside the project, such as `/app.exe`. */
  readonly program: string;
}

/** analyzeHeadless coordinates for one persistent-project Program. */
export interface GhidraPersistentProjectLocation {
  /** Directory containing the `.gpr` file and its `.rep` directory. */
  readonly projectLocation: string;
  readonly projectName: string;
  /** Project folder holding the Program; `/` for the project root. */
  readonly folderPath: string;
  readonly programName: string;
}

/** Final path component under either separator, as analyzeHeadless reads it. */
const finalComponent = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/**
 * Parse `REA_GHIDRA_PROJECT`: the absolute path of an existing project's
 * `.gpr` file. analyzeHeadless treats `*` and `?` as patterns and rewrites `\`
 * in its project argument to `/`, so project names cannot contain them.
 */
export const ghidraProjectFileSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "REA_GHIDRA_PROJECT must be absolute")
  .refine((value) => {
    const file = finalComponent(value);
    const name = file.slice(0, -GHIDRA_PROJECT_FILE_SUFFIX.length);
    return (
      file.endsWith(GHIDRA_PROJECT_FILE_SUFFIX) &&
      name.length > 0 &&
      !/[*?\0]/u.test(name)
    );
  }, `REA_GHIDRA_PROJECT must name an existing project's ${GHIDRA_PROJECT_FILE_SUFFIX} file`);

/**
 * Parse `REA_GHIDRA_PROGRAM`: the Program's absolute path inside the project,
 * such as `/app.exe` or `/folder/app.exe`. analyzeHeadless treats `*` and `?`
 * in `-process` as a filename pattern and rewrites `\` to `/`, so one exact
 * Program cannot contain them.
 */
export const ghidraProgramPathSchema = z
  .string()
  .max(MAX_GHIDRA_PROGRAM_PATH_LENGTH)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !/[\\*?\0]/u.test(value) &&
      value
        .slice(1)
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== "." &&
            segment !== ".." &&
            segment.trim() === segment,
        ),
    "REA_GHIDRA_PROGRAM must be an absolute project path such as /program.exe, without wildcards, backslashes, or empty, dot, or padded segments",
  );

/** Split the configured project and Program into analyzeHeadless arguments. */
export const ghidraPersistentProjectLocation = (
  project: GhidraPersistentProject,
  platform: NodeJS.Platform = process.platform,
): GhidraPersistentProjectLocation => {
  const path = platform === "win32" ? win32 : posix;
  const segments = project.program.slice(1).split("/");
  const programName = segments.pop();
  if (programName === undefined || programName.length === 0)
    throw new TypeError("Ghidra program path is invalid");
  return {
    projectLocation: path.dirname(project.projectFile),
    projectName: finalComponent(project.projectFile).slice(
      0,
      -GHIDRA_PROJECT_FILE_SUFFIX.length,
    ),
    folderPath: segments.length === 0 ? "/" : `/${segments.join("/")}`,
    programName,
  };
};
