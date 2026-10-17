/**
 * Display text for the member names and archive-reader notes the DEX reader
 * writes into `limitations` and refusals. Only prose is shortened, always with
 * an explicit marker; identity values (a member's reported `entry`) are never
 * altered. A stored ZIP name can be ~64 KiB, so without these bounds one
 * crafted archive turns a note into megabytes.
 */
import { DEX_LIMITS } from "./DexFileRelease.js";

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;

/** Unicode code points in `text` (a surrogate pair is one). */
const codePoints = (text: string): number => {
  let count = text.length;
  for (let i = 0; i < text.length - 1; i += 1)
    if (
      isHighSurrogate(text.charCodeAt(i)) &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      count -= 1;
      i += 1;
    }
  return count;
};

/**
 * The start and end of `text` worth `max` UTF-16 code units in all, never
 * splitting a surrogate pair. Both ends are kept because a crafted name hides
 * what distinguishes it (e.g. `classes7.dex`) behind a long prefix.
 */
const ends = (
  text: string,
  max: number,
): { readonly start: string; readonly end: string } => {
  let startLength = Math.ceil(max / 2);
  if (isHighSurrogate(text.charCodeAt(startLength - 1))) startLength -= 1;
  let endFrom = text.length - (max - Math.ceil(max / 2));
  if (isHighSurrogate(text.charCodeAt(endFrom - 1))) endFrom += 1;
  return { start: text.slice(0, startLength), end: text.slice(endFrom) };
};

const shortened = (
  text: string,
  max: number,
  kind: "name" | "note",
  quote: (part: string) => string,
): string => {
  if (text.length <= max) return quote(text);
  const { start, end } = ends(text, max);
  // The bound is in UTF-16 code units; the marker counts characters (code
  // points), as a reader of the text would.
  return `${quote(start)}…${quote(end)} (${kind} shortened: ${String(codePoints(start) + codePoints(end))} of ${String(codePoints(text))} characters shown)`;
};

/**
 * A member name as prose shows it, JSON-quoted when `quoted`; past the display
 * bound its start and end are shown, each quoted, with a marker.
 */
export const displayName = (name: string, quoted = false): string =>
  shortened(name, DEX_LIMITS.nameDisplayChars, "name", (part) =>
    quoted ? JSON.stringify(part) : part,
  );

/** An archive-reader note as carried into `limitations`, shortened past the display bound. */
export const displayNote = (note: string): string =>
  shortened(note, DEX_LIMITS.noteDisplayChars, "note", (part) => part);

/** How a stored member is held, as far as `entry` would refuse it. */
export interface MemberStorage {
  /** Stored with a symbolic-link mode, which REA does not read. */
  readonly symlink?: boolean;
  /** Encrypted, which REA does not read. */
  readonly encrypted?: boolean;
}

interface Named {
  /** Occurrences under this name; every one is counted while it is kept. */
  occurrences: number;
  /** Whether a member stored under this name has a symbolic-link mode. */
  symlink: boolean;
  /** Whether a member stored under this name is encrypted. */
  encrypted: boolean;
}

/**
 * Why `entry` refuses a named member, shown beside its name so a note never
 * advises selecting it. A name stored more than once is refused as ambiguous
 * before its storage is considered.
 */
const refusalMark = ({ occurrences, symlink, encrypted }: Named): string =>
  occurrences > 1
    ? ` (stored ${String(occurrences)} times; ambiguous)`
    : symlink
      ? " (symbolic-link mode; REA does not read it)"
      : encrypted
        ? " (encrypted; REA does not read it)"
        : "";

/**
 * Distinct names remembered for display, bounded by count and by the UTF-8
 * bytes of their display text (a refusal mark included); every name not kept
 * is counted, so a note can say how many members it did not name. Names are
 * admitted only until one is left out, so every occurrence of a kept name is
 * counted against it and its mark is never shown short. A later occurrence
 * that grows a kept name's mark past the budget drops the name, counting all
 * its occurrences, rather than show it unmarked.
 */
export class NamedMembers {
  readonly #names = new Map<string, Named>();
  readonly #quoted: boolean;
  #bytes = 0;
  #unnamed = 0;
  /** Set once a name is left out; no name is admitted after it. */
  #closed = false;

  constructor(quoted: boolean) {
    this.#quoted = quoted;
  }

  /** Display bytes of a name plus the ", " separator. */
  #cost(name: string): number {
    return utf8Bytes(displayName(name, this.#quoted)) + 2;
  }

  add(
    name: string,
    { symlink = false, encrypted = false }: MemberStorage = {},
  ): void {
    const kept = this.#names.get(name);
    if (kept === undefined) {
      const named = { occurrences: 1, symlink, encrypted };
      const cost = this.#cost(name) + utf8Bytes(refusalMark(named));
      if (
        !this.#closed &&
        this.#names.size < DEX_LIMITS.maxNamedCanonicalMembers &&
        this.#bytes + cost <= DEX_LIMITS.namedMembersBytes
      ) {
        this.#names.set(name, named);
        this.#bytes += cost;
      } else {
        this.#closed = true;
        this.#unnamed += 1;
      }
      return;
    }
    const before = utf8Bytes(refusalMark(kept));
    kept.occurrences += 1;
    kept.symlink ||= symlink;
    kept.encrypted ||= encrypted;
    const grown = utf8Bytes(refusalMark(kept)) - before;
    if (this.#bytes + grown <= DEX_LIMITS.namedMembersBytes) {
      this.#bytes += grown;
      return;
    }
    this.#names.delete(name);
    this.#bytes -= this.#cost(name) + before;
    this.#unnamed += kept.occurrences;
    this.#closed = true;
  }

  /** The kept names, in first-seen order. */
  get names(): readonly string[] {
    return [...this.#names.keys()];
  }

  /** Members whose name was not kept (each occurrence counts once). */
  get unnamed(): number {
    return this.#unnamed;
  }

  /**
   * Whether `entry` could select the one member under a kept name: stored
   * once, as a file REA reads.
   */
  isSelectable(name: string): boolean {
    const named = this.#names.get(name);
    return named !== undefined && refusalMark(named) === "";
  }

  /** A kept name as prose shows it, marked when `entry` would refuse it. */
  display(name: string): string {
    const named = this.#names.get(name);
    return `${displayName(name, this.#quoted)}${named === undefined ? "" : refusalMark(named)}`;
  }
}
