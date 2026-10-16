/**
 * Multi-release JAR member selection (JAR File Specification, Multi-Release
 * JARs). A class entry `E` may exist as the base `E` and as versioned overrides
 * `META-INF/versions/<N>/E`. Selection is explicit and never silently combines
 * metadata across versions: an omitted release uses the base, and a requested
 * release must match a present versioned entry or the selection is refused with
 * the available alternatives.
 */

/** `release: null` denotes the base (unversioned) entry. */
export interface JarEntryCandidate {
  readonly release: number | null;
  readonly path: string;
}

export type JarSelection =
  | {
      readonly ok: true;
      readonly path: string;
      readonly release: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "release-absent";
      readonly available: readonly number[];
    };

const VERSIONS_PREFIX = "META-INF/versions/";

/**
 * Normalize a caller-supplied entry once, before any match: backslashes become
 * `/`, then leading `/` characters and leading `./` segments are removed.
 * Interior segments (`a/./b`, `..`) are left unchanged. ZIP member paths come
 * from the reader, which strips only leading `./`; this request-side rule
 * additionally accepts Windows separators and a leading `/`, so a member stored
 * as `./Foo.class` is selectable as either `Foo.class` or `./Foo.class`.
 */
export const normalizeJarEntryPath = (entry: string): string =>
  entry
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/u, "");

/**
 * Split a `META-INF/versions/<N>/<entry>` path into its release and entry. The
 * JAR spec only honors versioned directories named by an integer >= 9, with no
 * leading zeros; any other path (including lower or non-canonical numbers,
 * which are inert resources) is `undefined`.
 */
export const parseVersionedJarEntry = (
  path: string,
): { readonly release: number; readonly entry: string } | undefined => {
  if (!path.startsWith(VERSIONS_PREFIX)) return undefined;
  const rest = path.slice(VERSIONS_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const version = rest.slice(0, slash);
  if (!/^[1-9][0-9]*$/.test(version) || Number(version) < 9) return undefined;
  const entry = rest.slice(slash + 1);
  return entry === "" ? undefined : { release: Number(version), entry };
};

/**
 * Classify an archive member path for the requested class entry: the base entry,
 * a versioned override, or unrelated (`undefined`).
 */
export const classifyJarEntry = (
  memberPath: string,
  entry: string,
): JarEntryCandidate | undefined => {
  if (memberPath === entry) return { release: null, path: memberPath };
  const versioned = parseVersionedJarEntry(memberPath);
  return versioned?.entry === entry
    ? { release: versioned.release, path: memberPath }
    : undefined;
};

/** Resolve which candidate to read for the requested release, or refuse explicitly. */
export const resolveJarSelection = (
  candidates: readonly JarEntryCandidate[],
  requestedRelease: number | undefined,
): JarSelection => {
  if (candidates.length === 0)
    return { ok: false, reason: "not-found", available: [] };
  const available = candidates
    .flatMap((c) => (c.release === null ? [] : [c.release]))
    .sort((a, b) => a - b);
  const base = candidates.find((c) => c.release === null);
  if (requestedRelease === undefined) {
    if (base !== undefined) return { ok: true, path: base.path, release: null };
    // Only versioned entries exist; require an explicit release rather than
    // guessing a version.
    return { ok: false, reason: "release-absent", available };
  }
  const match = candidates.find((c) => c.release === requestedRelease);
  if (match !== undefined)
    return { ok: true, path: match.path, release: requestedRelease };
  // The caller named a release that is not present; never silently fall back.
  return { ok: false, reason: "release-absent", available };
};

/**
 * A JAR is multi-release only when its main manifest section carries
 * `Multi-Release: true` (JAR File Specification). Otherwise META-INF/versions
 * entries are inert resources the runtime never loads. Parses only the main
 * section (up to the first blank line), honoring line continuations.
 */
export const isMultiReleaseManifest = (bytes: Uint8Array): boolean => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  const logical: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") break; // end of the main section
    if (line.startsWith(" ") && logical.length > 0)
      logical[logical.length - 1] += line.slice(1); // value continuation
    else logical.push(line);
  }
  for (const attribute of logical) {
    const colon = attribute.indexOf(":");
    if (colon < 0) continue;
    if (attribute.slice(0, colon).trim().toLowerCase() === "multi-release")
      return (
        attribute
          .slice(colon + 1)
          .trim()
          .toLowerCase() === "true"
      );
  }
  return false;
};
