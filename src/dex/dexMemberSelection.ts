/**
 * Choose which DEX members of an APK/ZIP one inspection reads: the member the
 * caller selected with `entry`, or the multidex sequence Android auto-loads.
 * Both match the raw stored central-directory name, as ART's libziparchive
 * does (a leading `./` is optional in `entry`); the Info-ZIP Unicode Path name
 * is never consulted. Canonical members Android would not load are named
 * (never silently dropped) on the summary and on every selection refusal.
 */
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import type { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import { normalizeArchiveMemberPath } from "../domain/archiveMemberPath.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  autoLoadedDexMembers,
  multidexIndex,
  multidexName,
} from "./dexEntry.js";
import { DEX_LIMITS } from "./DexFileRelease.js";

const OPERATION = "inspect_dex_debug_metadata";

interface Candidate {
  /** The member's raw stored name, which ART also uses (never a Unicode Path name). */
  readonly entry: string;
  readonly member: ArtifactEntry;
}

/** The members to analyse and, when any, the note naming members Android skips. */
export interface DexMemberSelection {
  readonly members: readonly Candidate[];
  readonly skippedNote?: string;
}

/** What one enumeration of the archive kept. */
interface ArchiveListing {
  /** Openable members: the requested name, or canonical names within the cap. */
  readonly candidates: readonly Candidate[];
  /** Occurrences by the requested name, or by exact stored canonical name. */
  readonly occurrences: ReadonlyMap<string, number>;
  /** Canonical names by stored spelling (bounded), and how many were not kept. */
  readonly canonical: ReadonlySet<string>;
  readonly unnamedCanonical: number;
  /**
   * Length of the contiguous run of exactly stored canonical names from
   * `classes.dex`: the members Android auto-loads, counted over the whole
   * listing (by name only), so it can exceed the retained candidates.
   */
  readonly autoLoaded: number;
}

/**
 * Canonical names an archive can hold: each central-directory record is 46
 * bytes plus a name of at least `classes.dex`, inside the metadata read. A
 * load position at or past this cannot belong to the auto-loaded run.
 */
const MAX_CANONICAL_RECORDS = Math.ceil(
  DEX_LIMITS.archiveMetadataBytes / (46 + "classes.dex".length),
);

const entryError = (message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: ["entry"], reason: "invalid_value", message },
  ]);

/**
 * Enumerate once, keeping only members this call may open (the reader retains
 * ~8 KB of decoded metadata per kept entry): the requested name, or the
 * canonical names up to one past the member cap (enough to detect "over the
 * cap"). Two occurrences of a name already prove it ambiguous, so no more are
 * kept. Canonical names past the cap are remembered by name only, bounded.
 */
const listArchive = async (
  reader: ZipArtifactReader,
  requested: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ArchiveListing> => {
  const candidates: Candidate[] = [];
  const occurrences = new Map<string, number>();
  const canonical = new Set<string>();
  let unnamedCanonical = 0;
  // Load positions of exactly stored canonical names, one bit each (~36 KiB).
  const exactPositions = new Uint8Array(Math.ceil(MAX_CANONICAL_RECORDS / 8));
  // ART (libziparchive) finds members by their raw central-directory name and
  // ignores the Info-ZIP Unicode Path field, so the stored name, not the
  // logical path, decides eligibility and is the member's reported identity.
  const wanted = (stored: string): boolean => {
    if (requested !== undefined)
      return normalizeArchiveMemberPath(stored) === requested;
    const index = multidexIndex(normalizeArchiveMemberPath(stored));
    if (index === null) return false;
    if (canonical.has(stored)) {
      // A repeat of a named member costs nothing more to remember.
    } else if (canonical.size < DEX_LIMITS.maxNamedCanonicalMembers)
      canonical.add(stored);
    else unnamedCanonical += 1;
    // Only an exactly stored canonical name is auto-loaded, so a member
    // stored as `./classes.dex` is not (it stays selectable).
    if (multidexIndex(stored) === null) return false;
    if (index < MAX_CANONICAL_RECORDS)
      exactPositions[index >>> 3]! |= 1 << (index & 7);
    return index <= DEX_LIMITS.maxDexMembers;
  };
  const keep = (member: ArtifactEntry): boolean => {
    const stored = member.storedPath ?? member.path;
    if (member.kind !== "file" || !wanted(stored)) return false;
    // Every occurrence is counted for the report; two are enough to keep.
    const key = requested ?? stored;
    const seen = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, seen);
    if (seen > 2) return false;
    candidates.push({ entry: stored, member });
    return true;
  };
  for await (const member of reader.entries(signal, { retain: keep }))
    void member;
  let autoLoaded = 0;
  while (
    autoLoaded < MAX_CANONICAL_RECORDS &&
    (exactPositions[autoLoaded >>> 3]! & (1 << (autoLoaded & 7))) !== 0
  )
    autoLoaded += 1;
  return { candidates, occurrences, canonical, unnamedCanonical, autoLoaded };
};

/** Whether a stored spelling is one of the members Android auto-loads. */
const isAutoLoaded = (stored: string, listing: ArchiveListing): boolean => {
  const index = multidexIndex(stored);
  return index !== null && index < listing.autoLoaded;
};

/**
 * Name the canonical members Android does not auto-load, if any: those after
 * a gap in the sequence and those not stored under their exact name.
 */
const skippedMembersNote = (
  path: string,
  listing: ArchiveListing,
): string | undefined => {
  const skipped = [...listing.canonical]
    .filter((name) => !isAutoLoaded(name, listing))
    .sort(
      (a, b) =>
        (multidexIndex(normalizeArchiveMemberPath(a)) ?? 0) -
        (multidexIndex(normalizeArchiveMemberPath(b)) ?? 0),
    );
  // Every auto-loaded position has an exactly stored entry; those not named
  // were counted among the unnamed ones.
  const namedLoaded = listing.canonical.size - skipped.length;
  const more = Math.max(
    0,
    listing.unnamedCanonical - (listing.autoLoaded - namedLoaded),
  );
  if (skipped.length === 0 && more === 0) return undefined;
  const names = [
    ...skipped,
    ...(more === 0 ? [] : [`${String(more)} more canonical DEX member(s)`]),
  ].join(", ");
  return `${path} also holds ${names}, which Android does not auto-load: it loads classes.dex, classes2.dex, ... only while each is present under its exact stored name. Select ${skipped.length + more === 1 ? "it" : "one"} with entry.`;
};

/** The auto-loaded sequence, refused when it cannot be read as promised. */
const resolveAutoLoaded = (
  path: string,
  listing: ArchiveListing,
): Result<DexMemberSelection, AnalysisError> => {
  // Only the contiguous sequence Android loads is promised; a member after a
  // gap is never loaded, so it can neither fail nor shadow the inspection.
  const sequence = autoLoadedDexMembers(
    listing.candidates.map(({ entry }) => entry),
  );
  const loadOrder = new Map(sequence.map((name, index) => [name, index]));
  const matches = listing.candidates.filter(({ entry }) =>
    loadOrder.has(entry),
  );
  // Absence from the summary must not be mistaken for absence from the archive.
  const skippedNote = skippedMembersNote(path, listing);
  const withSkipped = (message: string): string =>
    skippedNote === undefined ? message : `${message} ${skippedNote}`;
  // Every root member is promised, so one that cannot be read is refused,
  // never silently skipped (that would turn unknown into absent).
  const encrypted = matches.filter((m) => m.member.encrypted);
  if (encrypted.length > 0)
    return err(
      new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        withSkipped(
          `${path} has encrypted root DEX member(s) (${encrypted.map((m) => m.entry).join(", ")}); their debug metadata is unavailable, not absent.`,
        ),
        {
          remediationAction:
            "Select a readable member with entry to inspect it alone.",
        },
      ),
    );
  // A reported entry must identify exactly one member.
  const ambiguous = sequence.find(
    (name) => (listing.occurrences.get(name) ?? 0) > 1,
  );
  if (ambiguous !== undefined)
    return err(
      entryError(
        withSkipped(
          `${path} holds ${String(listing.occurrences.get(ambiguous))} members named ${ambiguous}; the identity is ambiguous.`,
        ),
      ),
    );
  if (matches.length === 0)
    return err(
      entryError(
        withSkipped(
          `${path} holds no classes.dex under that exact stored name for Android to load; select a .dex with entry.`,
        ),
      ),
    );
  if (matches.length > DEX_LIMITS.maxDexMembers)
    return err(
      new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        withSkipped(
          `${path} auto-loads ${String(listing.autoLoaded)} DEX members (classes.dex … ${multidexName(listing.autoLoaded - 1)}), more than the ${String(DEX_LIMITS.maxDexMembers)}-member limit, so none was read; select one with entry.`,
        ),
        { maximum_dex_members: DEX_LIMITS.maxDexMembers },
        {
          remediationAction:
            "Select one member with entry; members are inspected one at a time.",
        },
      ),
    );
  matches.sort(
    (a, b) => (loadOrder.get(a.entry) ?? 0) - (loadOrder.get(b.entry) ?? 0),
  );
  return ok({
    members: matches,
    ...(skippedNote === undefined ? {} : { skippedNote }),
  });
};

/** The one member the caller selected with `entry`. */
const resolveRequested = (
  path: string,
  requested: string,
  listing: ArchiveListing,
): Result<DexMemberSelection, AnalysisError> => {
  const matches = listing.candidates;
  if (matches.length === 0)
    return err(entryError(`No member ${requested} exists in ${path}.`));
  if (matches.length > 1)
    return err(
      entryError(
        `${path} holds ${String(listing.occurrences.get(requested) ?? 0)} members named ${requested}; the identity is ambiguous.`,
      ),
    );
  const only = matches[0]!;
  if (only.member.encrypted)
    return err(
      new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        `The selected member ${requested} is encrypted and cannot be read without a key; unavailable, not absent.`,
      ),
    );
  return ok({ members: [only] });
};

/** Choose the archive's DEX members: the explicit entry, or the auto-loaded multidex sequence. */
export const selectDexMembers = async (
  reader: ZipArtifactReader,
  entry: string | undefined,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<DexMemberSelection, AnalysisError>> => {
  const requested =
    entry === undefined ? undefined : normalizeArchiveMemberPath(entry);
  const listing = await listArchive(reader, requested, signal);
  return requested === undefined
    ? resolveAutoLoaded(path, listing)
    : resolveRequested(path, requested, listing);
};
