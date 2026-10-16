/**
 * Parse a `tar -tf` listing into its member names.
 *
 * Windows `tar` terminates each listed member with CRLF, so splitting on a
 * bare "\n" leaves a trailing "\r" on every non-final member. Consumers
 * compare member identities exactly (`packedFiles.includes(path)`), so those
 * carriers make members that ship in the package look omitted. Normalize line
 * endings here, once, at the listing owner, and preserve every member string
 * beyond its line ending.
 */
export const parseTarListing = (stdout) =>
  stdout.split(/\r?\n/).filter((member) => member.length > 0);
