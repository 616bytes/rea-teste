import type { PackerIndicators } from "../../domain/native/packerIndicators.js";
import { readElfPackerFacts } from "./ElfPackerReader.js";
import { readPePackerFacts } from "./PePackerReader.js";
import {
  BASE_LIMITATIONS,
  deriveIndicators,
  deriveVerdict,
  findMagic,
  formatFailure,
  hexAddress,
  sectionFamily,
  shannonEntropy,
} from "./packerFacts.js";

/** Read-only packer indicator report for one PE or ELF snapshot. */
export const parsePackerIndicators = (
  bytes: Buffer,
  artifact: PackerIndicators["artifact"],
  signal?: AbortSignal,
): PackerIndicators => {
  signal?.throwIfAborted();
  const facts =
    bytes.length >= 4 && bytes.readUInt32BE(0) === 0x7f454c46
      ? readElfPackerFacts(bytes)
      : bytes.length >= 2 && bytes.readUInt16LE(0) === 0x5a4d
        ? readPePackerFacts(bytes)
        : formatFailure("Expected a PE (MZ) or ELF image.");
  signal?.throwIfAborted();
  const sectionNames = facts.regions.flatMap((region) => {
    const family = sectionFamily(region.name);
    return family === undefined || region.name === null
      ? []
      : [
          {
            region_index: region.index,
            name: region.name,
            family,
            location: { offset: region.raw.offset, bytes: region.raw.bytes },
          },
        ];
  });
  const { magic, total } = findMagic(bytes);
  const signatures = {
    section_names: sectionNames,
    magic,
    magic_matches_total: total,
  };
  const overlay =
    facts.mappedEnd < bytes.length
      ? {
          location: {
            offset: facts.mappedEnd,
            bytes: bytes.length - facts.mappedEnd,
          },
          entropy: shannonEntropy(bytes.subarray(facts.mappedEnd)) ?? 0,
          certificate_table: facts.certificateTable,
        }
      : null;
  const indicators = deriveIndicators({
    regions: facts.regions,
    entryApplicable: facts.entryApplicable,
    entryRegion: facts.entryRegion,
    firstSectionIndex: facts.firstSectionIndex,
    signatures,
    imports: facts.imports,
    overlay,
    elfWithoutSections: facts.elfWithoutSections,
  });
  const importsUnreadable = facts.imports.status === "unreadable";
  const limitations = [...BASE_LIMITATIONS, ...facts.limitations];
  if (importsUnreadable)
    limitations.push(
      "The import directory could not be decoded consistently; the import heuristic was not evaluated.",
    );
  if (total > magic.length)
    limitations.push(
      `Only the first ${String(magic.length)} of ${String(total)} magic matches are reported with offsets.`,
    );
  return {
    artifact,
    format: facts.format,
    machine: facts.machine,
    regions: facts.regions,
    entry_point: {
      address: hexAddress(facts.entryAddress),
      region_index: facts.entryRegion?.index ?? null,
      file_offset: facts.entryFileOffset,
    },
    signatures,
    imports: facts.imports,
    overlay,
    indicators,
    verdict: deriveVerdict(indicators, facts.incomplete || importsUnreadable),
    limitations,
  };
};
