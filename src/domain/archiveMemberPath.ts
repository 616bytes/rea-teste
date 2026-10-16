/**
 * Canonicalize a caller-supplied archive member path to the logical form the
 * ZIP reader gives its members: forward slashes, no leading `/`, and no
 * leading `./` segments, so an archive's literal `./Foo.class` is selectable.
 * A member is identified by exactly this string, so normalization happens once,
 * here, before any match or comparison.
 */
export const normalizeArchiveMemberPath = (entry: string): string =>
  entry
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/u, "");
