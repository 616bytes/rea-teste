import type {
  PackerIndicators,
  PackerRegion,
} from "../../domain/native/packerIndicators.js";

/** Format-specific facts consumed by the shared indicator derivation. */
export interface ImageFacts {
  readonly format: PackerIndicators["format"];
  readonly machine: number;
  readonly regions: PackerRegion[];
  readonly entryAddress: bigint;
  /** False when the image declares no entry point (zero PE RVA, ELF REL/zero entry). */
  readonly entryApplicable: boolean;
  readonly entryRegion: PackerRegion | undefined;
  readonly entryFileOffset: number | null;
  readonly firstSectionIndex: number | undefined;
  readonly imports: PackerIndicators["imports"];
  readonly mappedEnd: number;
  readonly certificateTable: { offset: number; bytes: number } | null;
  readonly elfWithoutSections: boolean;
  readonly limitations: string[];
  readonly incomplete: boolean;
}

/** Clamp a declared file range to the snapshot and report whether it was cut. */
export const clampRange = (
  length: number,
  offset: number,
  bytes: number,
): { offset: number; bytes: number; truncated: boolean } => {
  if (offset >= length) return { offset, bytes: 0, truncated: bytes > 0 };
  const available = Math.min(bytes, length - offset);
  return { offset, bytes: available, truncated: available < bytes };
};

export const decodeName = (raw: Buffer) => {
  const end = raw.indexOf(0);
  const trimmed = end === -1 ? raw : raw.subarray(0, end);
  return {
    name: trimmed.toString("latin1"),
    name_hex: trimmed.toString("hex"),
  };
};
