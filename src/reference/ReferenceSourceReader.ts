import { posix } from "node:path";

import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { createReferenceSourcePathLookup } from "../domain/referenceSourcePathIdentity.js";
import { err, ok } from "../domain/result.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { traverseDirectory } from "./ReferenceSourceReaderEntries.js";
import type {
  ReferenceSourceReaderOptions,
  ReferenceSourceRead,
  ReferenceSourceEntry,
  ReferenceSourceResult,
  TraversalState,
} from "./ReferenceSourceReaderTypes.js";
import {
  isAborted,
  noFollowOpenSupported,
  prepareRoot,
} from "./ReferenceSourceReaderValidate.js";

const PATH_RACE_LIMITATION =
  "Path identity is revalidated around operations; Node lacks portable descriptor-relative openat traversal, so a syscall-boundary pathname race remains.";

/** Read a source tree without intentionally following symbolic links. */
export const readReferenceSource = async (
  root: string,
  resources: ArtifactResourceScope,
  options: ReferenceSourceReaderOptions = {},
): Promise<ReferenceSourceResult<ReferenceSourceRead>> => {
  try {
    return await resources.run(() => readSource(root, resources, options));
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    return err({
      tag: "reference-source-reader",
      code: cause.reason === "cancelled" ? "cancelled" : "io",
      message: cause.message,
      ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
      cause,
    });
  }
};

const readSource = async (
  root: string,
  resources: ArtifactResourceScope,
  options: ReferenceSourceReaderOptions,
): Promise<ReferenceSourceResult<ReferenceSourceRead>> => {
  if (!noFollowOpenSupported())
    return err({
      tag: "reference-source-reader",
      code: "unsupported",
      message: "Safe no-follow file opens are unavailable",
    });
  const prepared = await prepareRoot(root, options.signal);
  if (!prepared.ok) return prepared;
  const { canonicalRoot, rootIdentity } = prepared.value;
  const state: TraversalState = {
    resources,
    root: canonicalRoot,
    rootIdentity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.shouldExclude === undefined
      ? {}
      : { shouldExclude: options.shouldExclude }),
    entries: [],
    exclusions: [],
    pending: [{ path: canonicalRoot }],
    bytesRead: 0,
  };
  const traversal = await traverse(state);
  if (!isAborted(state.signal))
    reconcileSymlinksBelowUnreadableDirectories(
      state.entries,
      state.exclusions,
      state.signal,
    );
  state.entries.sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
  const read: ReferenceSourceRead = {
    root: canonicalRoot,
    entries: state.entries,
    bytesRead: state.bytesRead,
    limitations: [PATH_RACE_LIMITATION],
  };
  return traversal.ok ? ok(read) : err({ ...traversal.error, partial: read });
};

/**
 * A target can be physically resolved through a searchable directory even
 * when that directory cannot be enumerated.  In that case the reader has not
 * established the target's inventory identity, so retain the link as an
 * unreadable observation rather than publishing an unverified internal target.
 */
export const reconcileSymlinksBelowUnreadableDirectories = (
  entries: ReferenceSourceEntry[],
  exclusions: TraversalState["exclusions"] = [],
  signal?: AbortSignal,
): void => {
  const failedDirectories = new Map(
    entries.flatMap((entry) =>
      entry.status === "failed" && entry.kind === "directory"
        ? [[entry.path, entry] as const]
        : [],
    ),
  );
  if (failedDirectories.size === 0 || isAborted(signal)) return;
  const observedPaths = createReferenceSourcePathLookup(
    entries.map(({ path }) => path),
  );
  const excludedPaths = createReferenceSourcePathLookup(
    exclusions.map(({ path }) => path),
  );
  const excludedDirectories = createReferenceSourcePathLookup(
    exclusions.flatMap(({ path, kind }) =>
      kind === "directory" ? [path] : [],
    ),
  );

  for (const [index, entry] of entries.entries()) {
    if (isAborted(signal)) return;
    if (
      entry.status !== "read" ||
      entry.kind !== "symlink" ||
      entry.targetState !== "internal" ||
      observedPaths.resolve(entry.target) !== undefined ||
      excludedPaths.resolve(entry.target) !== undefined ||
      hasAncestor(entry.target, excludedDirectories, signal)
    )
      continue;
    const ancestor = findFailedAncestor(
      entry.target,
      failedDirectories,
      signal,
    );
    if (ancestor === undefined) continue;
    entries[index] = {
      status: "failed",
      kind: "symlink",
      path: entry.path,
      code: ancestor.code,
      message: `Symbolic link target is inside a directory that could not be enumerated: ${ancestor.message}`,
    };
  }
};

const findFailedAncestor = (
  target: string,
  directories: ReadonlyMap<
    string,
    Extract<ReferenceSourceEntry, { status: "failed" }>
  >,
  signal: AbortSignal | undefined,
): Extract<ReferenceSourceEntry, { status: "failed" }> | undefined => {
  for (
    let candidate = posix.dirname(target);
    candidate !== "." && candidate !== "/";
    candidate = posix.dirname(candidate)
  ) {
    if (isAborted(signal)) return undefined;
    const failure = directories.get(candidate);
    if (failure !== undefined) return failure;
  }
  return undefined;
};

const hasAncestor = (
  target: string,
  paths: ReturnType<typeof createReferenceSourcePathLookup>,
  signal: AbortSignal | undefined,
): boolean => {
  for (
    let candidate = posix.dirname(target);
    candidate !== "." && candidate !== "/";
    candidate = posix.dirname(candidate)
  ) {
    if (isAborted(signal)) return false;
    if (paths.resolve(candidate) !== undefined) return true;
  }
  return false;
};

const traverse = async (
  state: TraversalState,
): Promise<ReferenceSourceResult<undefined>> => {
  while (state.pending.length > 0) {
    if (isAborted(state.signal))
      return err({
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      });
    const current = state.pending.pop();
    if (current === undefined) break;
    const result = await traverseDirectory(state, current);
    if (!result.ok) return result;
  }
  return ok(undefined);
};
