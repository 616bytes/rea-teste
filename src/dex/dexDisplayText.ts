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

/** Marks a named member REA does not read, so a note never advises selecting it. */
const SYMLINK_MARK = " (symbolic-link mode; REA does not read it)";
const SYMLINK_MARK_BYTES = utf8Bytes(SYMLINK_MARK);

interface Named {
  /** Whether a member stored under this name has a symbolic-link mode. */
  symlink: boolean;
  /** Occurrences seen while named, counted as unnamed if the name is dropped. */
  occurrences: number;
}

/**
 * Distinct names remembered for display, bounded by count and by the UTF-8
 * bytes of their display text (a symbolic-link mark included); every name not
 * kept is counted, so a note can say how many members it did not name. A name
 * already kept costs nothing, unless a later occurrence adds the mark; one
 * whose mark no longer fits is dropped and counted rather than shown unmarked.
 */
export class NamedMembers {
  readonly #names = new Map<string, Named>();
  readonly #quoted: boolean;
  #bytes = 0;
  #unnamed = 0;

  constructor(quoted: boolean) {
    this.#quoted = quoted;
  }

  /** Display bytes of a name plus the ", " separator. */
  #cost(name: string): number {
    return utf8Bytes(displayName(name, this.#quoted)) + 2;
  }

  add(name: string, symlink = false): void {
    const kept = this.#names.get(name);
    if (kept !== undefined) {
      kept.occurrences += 1;
      if (!symlink || kept.symlink) return;
      if (this.#bytes + SYMLINK_MARK_BYTES <= DEX_LIMITS.namedMembersBytes) {
        kept.symlink = true;
        this.#bytes += SYMLINK_MARK_BYTES;
      } else {
        this.#names.delete(name);
        this.#bytes -= this.#cost(name);
        this.#unnamed += kept.occurrences;
      }
      return;
    }
    const cost = this.#cost(name) + (symlink ? SYMLINK_MARK_BYTES : 0);
    if (
      this.#names.size < DEX_LIMITS.maxNamedCanonicalMembers &&
      this.#bytes + cost <= DEX_LIMITS.namedMembersBytes
    ) {
      this.#names.set(name, { symlink, occurrences: 1 });
      this.#bytes += cost;
    } else this.#unnamed += 1;
  }

  /** The kept names, in first-seen order. */
  get names(): readonly string[] {
    return [...this.#names.keys()];
  }

  /** Members whose name was not kept (each occurrence counts once). */
  get unnamed(): number {
    return this.#unnamed;
  }

  /** Whether a kept name is stored (at least once) with a symbolic-link mode. */
  isSymlink(name: string): boolean {
    return this.#names.get(name)?.symlink === true;
  }

  /** A kept name as prose shows it, marked when REA does not read it. */
  display(name: string): string {
    return `${displayName(name, this.#quoted)}${this.isSymlink(name) ? SYMLINK_MARK : ""}`;
  }
}
