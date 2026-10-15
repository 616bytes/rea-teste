import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  PackerIndicator,
  PackerIndicators,
  PackerRegion,
} from "../../domain/native/packerIndicators.js";

export const formatFailure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

/** Shannon entropy in bits per byte; null when no file bytes back the range. */
export const shannonEntropy = (bytes: Uint8Array): number | null => {
  if (bytes.length === 0) return null;
  const counts = new Uint32Array(256);
  for (const value of bytes) counts[value] = (counts[value] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 10000) / 10000;
};

export const hexAddress = (value: bigint | number): string =>
  `0x${value.toString(16)}`;

// Names are recognition hints only: any linker can emit them, and packers can
// rename sections. Matches are compared case-sensitively against the raw name.
const SECTION_FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/^UPX[0-9!]$/u, "upx"],
  [/^\.UPX[0-9]$/u, "upx"],
  [/^\.aspack$|^\.adata$/u, "aspack"],
  [/^\.MPRESS[12]$/u, "mpress"],
  [/^PEC2(?:TO|MO)?$|^pec[12]$|^PECompact2$/u, "pecompact"],
  [/^\.petite$/u, "petite"],
  [/^\.nsp[012]$|^nsp[012]$/u, "nspack"],
  [/^\.RLPack$/u, "rlpack"],
  [/^\.kkrunchy$|^kkrunchy$/u, "kkrunchy"],
  [/^MEW$/u, "mew"],
];

export const sectionFamily = (name: string | null): string | undefined =>
  name === null
    ? undefined
    : SECTION_FAMILIES.find(([pattern]) => pattern.test(name))?.[1];

const MAGIC: readonly { family: string; value: string }[] = [
  { family: "upx", value: "UPX!" },
  { family: "upx", value: "$Info: This file is packed with the UPX" },
];
const MAX_MAGIC_REPORTED = 16;

/** Byte-exact magic offsets across the whole snapshot, bounded in output. */
export const findMagic = (bytes: Buffer) => {
  const found: PackerIndicators["signatures"]["magic"] = [];
  let total = 0;
  for (const { family, value } of MAGIC) {
    const needle = Buffer.from(value, "latin1");
    for (
      let at = bytes.indexOf(needle);
      at !== -1;
      at = bytes.indexOf(needle, at + 1)
    ) {
      total++;
      if (found.length < MAX_MAGIC_REPORTED)
        found.push({
          family,
          value,
          location: { offset: at, bytes: needle.length },
        });
    }
  }
  return { magic: found, total };
};

const HIGH_ENTROPY = 7.2;
const HIGH_ENTROPY_MIN_BYTES = 1024;
const VIRTUAL_ONLY_MIN_BYTES = 0x10000;

interface IndicatorInput {
  readonly regions: readonly PackerRegion[];
  readonly entryApplicable: boolean;
  readonly entryRegion: PackerRegion | undefined;
  readonly firstSectionIndex: number | undefined;
  readonly signatures: PackerIndicators["signatures"];
  readonly imports: PackerIndicators["imports"];
  readonly overlay: PackerIndicators["overlay"];
  readonly elfWithoutSections: boolean;
}

/** Derive named indicators from already-observed facts; no fact is inferred twice. */
export const deriveIndicators = (input: IndicatorInput): PackerIndicator[] => {
  const indicators: PackerIndicator[] = [];
  const add = (
    id: PackerIndicator["id"],
    strength: PackerIndicator["strength"],
    detail: string,
  ) => indicators.push({ id, strength, detail });
  for (const match of input.signatures.section_names)
    add(
      "packer_section_name",
      "strong",
      `Region ${String(match.region_index)} is named ${match.name} (${match.family}).`,
    );
  const magicFamilies = new Set(input.signatures.magic.map((m) => m.family));
  for (const family of magicFamilies)
    add(
      "packer_magic",
      "strong",
      `${family} magic bytes occur ${String(
        input.signatures.magic.filter((m) => m.family === family).length,
      )} time(s) in the reported offsets.`,
    );
  const entry = input.entryRegion;
  if (!input.entryApplicable) {
    // No declared entry point: placement indicators do not apply.
  } else if (entry === undefined)
    add(
      "entry_outside_mapped_regions",
      "supporting",
      "The entry point is not inside any reported region.",
    );
  else {
    if (
      input.firstSectionIndex !== undefined &&
      entry.kind === "section" &&
      entry.index !== input.firstSectionIndex
    )
      add(
        "entry_outside_first_section",
        "supporting",
        `The entry point is in region ${String(entry.index)} rather than the first section.`,
      );
    if (entry.writable && entry.executable)
      add(
        "entry_in_writable_executable_region",
        "supporting",
        `The entry point is in writable and executable region ${String(entry.index)}.`,
      );
  }
  for (const region of input.regions) {
    if (
      region.executable &&
      region.entropy !== null &&
      region.raw.bytes >= HIGH_ENTROPY_MIN_BYTES &&
      region.entropy >= HIGH_ENTROPY
    )
      add(
        "high_entropy_executable_region",
        "supporting",
        `Executable region ${String(region.index)} has entropy ${String(region.entropy)} over ${String(region.raw.bytes)} bytes.`,
      );
    if (
      region.executable &&
      region.virtual_size >= VIRTUAL_ONLY_MIN_BYTES &&
      region.virtual_size >= Math.max(1, region.raw.bytes) * 4
    )
      add(
        "virtual_only_region",
        "supporting",
        `Executable region ${String(region.index)} declares ${String(region.virtual_size)} virtual bytes over ${String(region.raw.bytes)} file bytes.`,
      );
  }
  if (input.imports.status === "parsed" && input.imports.only_loader_style)
    add(
      "loader_style_imports_only",
      "supporting",
      `Imports are limited to loader-style APIs plus at most one other function per library (${String(input.imports.function_count)} functions).`,
    );
  if (input.elfWithoutSections)
    add(
      "elf_without_section_headers",
      "supporting",
      "The ELF executable declares no section headers.",
    );
  const overlay = input.overlay;
  if (
    overlay !== null &&
    !(
      overlay.certificate_table !== null &&
      overlay.certificate_table.offset === overlay.location.offset &&
      overlay.certificate_table.bytes >= overlay.location.bytes
    )
  )
    add(
      "overlay_present",
      "supporting",
      `${String(overlay.location.bytes)} bytes follow the last mapped file range (entropy ${String(overlay.entropy)}).`,
    );
  return indicators;
};

/** Conservative verdict: one supporting fact alone is never enough. */
export const deriveVerdict = (
  indicators: readonly PackerIndicator[],
  incomplete: boolean,
): PackerIndicators["verdict"] => {
  const strong = indicators.filter((item) => item.strength === "strong");
  const supporting = indicators.filter(
    (item) => item.strength === "supporting",
  );
  if (strong.length > 0)
    return {
      status: "likely_packed",
      basis: `Known packer signature observed (${[...new Set(strong.map((item) => item.id))].join(", ")}).`,
    };
  if (supporting.length >= 2)
    return {
      status: "likely_packed",
      basis: `${String(supporting.length)} independent supporting indicators observed.`,
    };
  if (supporting.length === 1 || incomplete)
    return {
      status: "unknown",
      basis:
        supporting.length === 1
          ? `Only one supporting indicator observed (${supporting[0]?.id ?? ""}).`
          : "Part of the image could not be examined; see limitations.",
    };
  return {
    status: "not_observed",
    basis: "No packer indicator was observed in the examined structures.",
  };
};

export const BASE_LIMITATIONS = [
  "Static byte inspection only: the image was not executed, emulated or unpacked.",
  "not_observed does not establish that the file is unpacked; custom, renamed or unknown packers and protectors can avoid every indicator.",
  "Section names and magic strings are recognition hints that any build can emit or remove; they do not prove which tool produced the file.",
  "Entropy is computed over file-backed bytes only; compressed resources or embedded data can raise it without packing.",
];
