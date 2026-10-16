import { describe, expect, it } from "vitest";

import { packerIndicatorsSchema } from "../../domain/native/packerIndicators.js";
import { parsePackerIndicators } from "./PackerIndicatorParser.js";
import { shannonEntropy } from "./packerFacts.js";
import {
  CODE_RX,
  DATA_RW,
  RWX,
  elfImage,
  importSection,
  noise,
  peImage,
  plain,
} from "./PackerIndicators.fixture.js";

const artifact = (bytes: Buffer) => ({
  path: "/fixtures/image",
  sha256: "0".repeat(64),
  bytes: bytes.length,
});
const parse = (bytes: Buffer) => {
  const report = parsePackerIndicators(bytes, artifact(bytes));
  expect(packerIndicatorsSchema.parse(report)).toEqual(report);
  return report;
};
const ids = (report: ReturnType<typeof parse>) =>
  report.indicators.map((item) => item.id);

const ordinaryImports = (rva: number, plus = false) =>
  importSection(
    rva,
    [
      {
        name: "KERNEL32.dll",
        functions: ["CreateFileW", "ReadFile", "WriteFile", "CloseHandle"],
      },
      { name: "USER32.dll", functions: ["MessageBoxW", "GetDC"] },
    ],
    plus,
  );

const ordinaryPe = (plus = false) =>
  peImage({
    plus,
    entryRva: 0x1010,
    importRva: 0x2000,
    sections: [
      {
        name: ".text",
        virtualSize: 0x800,
        rva: 0x1000,
        raw: plain(0x800),
        characteristics: CODE_RX,
      },
      {
        name: ".rdata",
        virtualSize: 0x400,
        rva: 0x2000,
        raw: ordinaryImports(0x2000, plus),
        characteristics: 0x40000040,
      },
      {
        name: ".data",
        virtualSize: 0x200,
        rva: 0x3000,
        raw: Buffer.alloc(0x40),
        characteristics: DATA_RW,
      },
    ],
  });

// Layout shape modeled on a UPX-compressed PE: empty RWX UPX0, compressed
// RWX UPX1 holding the entry, a resource-like section with the stub imports.
const upxShapedPe = () => {
  const header = Buffer.concat([Buffer.from("4.24\0UPX!"), noise(0x2000)]);
  return peImage({
    entryRva: 0x21010,
    importRva: 0x24000,
    sections: [
      {
        name: "UPX0",
        virtualSize: 0x20000,
        rva: 0x1000,
        raw: Buffer.alloc(0),
        characteristics: RWX,
      },
      {
        name: "UPX1",
        virtualSize: 0x3000,
        rva: 0x21000,
        raw: header,
        characteristics: RWX,
      },
      {
        name: ".rsrc",
        virtualSize: 0x1000,
        rva: 0x24000,
        raw: importSection(0x24000, [
          {
            name: "KERNEL32.DLL",
            functions: [
              "LoadLibraryA",
              "GetProcAddress",
              "VirtualProtect",
              "VirtualAlloc",
              "VirtualFree",
              "ExitProcess",
            ],
          },
          { name: "USER32.dll", functions: ["MessageBoxW"] },
        ]),
        characteristics: DATA_RW,
      },
    ],
  });
};

describe("static PE packer indicators", () => {
  it("computes Shannon entropy over file bytes", () => {
    expect(shannonEntropy(Buffer.alloc(0))).toBeNull();
    expect(shannonEntropy(Buffer.alloc(16, 7))).toBe(0);
    expect(shannonEntropy(Buffer.from([0, 1, 0, 1]))).toBe(1);
    expect(
      shannonEntropy(Buffer.from(Array.from({ length: 256 }, (_, i) => i))),
    ).toBe(8);
  });

  it.each([false, true])(
    "reports not_observed for an ordinary PE (plus=%s)",
    (plus) => {
      const report = parse(ordinaryPe(plus));
      expect(report.format).toBe(plus ? "pe32-plus" : "pe32");
      expect(report.regions.map((region) => region.name)).toEqual([
        ".text",
        ".rdata",
        ".data",
      ]);
      expect(report.regions[0]).toMatchObject({
        readable: true,
        writable: false,
        executable: true,
        virtual_address: "0x1000",
      });
      expect(report.entry_point).toMatchObject({
        address: "0x1010",
        region_index: 0,
      });
      expect(report.imports).toMatchObject({
        status: "parsed",
        libraries: ["KERNEL32.dll", "USER32.dll"],
        function_count: 6,
        only_loader_style: false,
      });
      expect(report.overlay).toBeNull();
      expect(report.indicators).toEqual([]);
      expect(report.verdict.status).toBe("not_observed");
      expect(report.limitations.join(" ")).toContain(
        "does not establish that the file is unpacked",
      );
    },
  );

  it("reports UPX-shaped PE indicators with offsets", () => {
    const bytes = upxShapedPe();
    const report = parse(bytes);
    expect(
      report.signatures.section_names.map(({ name, family }) => [name, family]),
    ).toEqual([
      ["UPX0", "upx"],
      ["UPX1", "upx"],
    ]);
    const magic = report.signatures.magic[0];
    expect(magic?.value).toBe("UPX!");
    expect(
      bytes.toString(
        "latin1",
        magic?.location.offset,
        (magic?.location.offset ?? 0) + 4,
      ),
    ).toBe("UPX!");
    expect(report.entry_point.region_index).toBe(1);
    expect(report.regions[0]?.raw.bytes).toBe(0);
    expect(report.regions[1]?.entropy).toBeGreaterThan(7.2);
    expect(report.imports).toMatchObject({
      status: "parsed",
      only_loader_style: true,
      loader_style_functions: [
        "GetProcAddress",
        "LoadLibraryA",
        "VirtualAlloc",
        "VirtualFree",
        "VirtualProtect",
      ],
    });
    expect(new Set(ids(report))).toEqual(
      new Set([
        "packer_section_name",
        "packer_magic",
        "entry_outside_first_section",
        "entry_in_writable_executable_region",
        "high_entropy_executable_region",
        "virtual_only_region",
        "loader_style_imports_only",
      ]),
    );
    expect(report.verdict.status).toBe("likely_packed");
  });

  it("needs two supporting indicators without a known signature", () => {
    const single = parse(
      peImage({
        entryRva: 0x1000,
        sections: [
          {
            name: ".text",
            virtualSize: 0x2000,
            rva: 0x1000,
            raw: noise(0x2000),
            characteristics: CODE_RX,
          },
        ],
      }),
    );
    expect(ids(single)).toEqual(["high_entropy_executable_region"]);
    expect(single.imports.status).toBe("absent");
    expect(single.verdict.status).toBe("unknown");
    const double = parse(
      peImage({
        entryRva: 0x1000,
        sections: [
          {
            name: ".text",
            virtualSize: 0x2000,
            rva: 0x1000,
            raw: noise(0x2000),
            characteristics: RWX,
          },
        ],
      }),
    );
    expect(double.verdict.status).toBe("likely_packed");
  });
});

describe("static PE overlay and import boundaries", () => {
  it("reports overlays and excludes a certificate-only overlay", () => {
    const base = ordinaryPe();
    const withOverlay = parse(Buffer.concat([base, noise(300)]));
    expect(withOverlay.overlay?.location).toEqual({
      offset: base.length,
      bytes: 300,
    });
    expect(ids(withOverlay)).toEqual(["overlay_present"]);
    const signed = parse(
      peImage({
        entryRva: 0x1000,
        sections: [
          {
            name: ".text",
            virtualSize: 0x200,
            rva: 0x1000,
            raw: plain(0x200),
            characteristics: CODE_RX,
          },
        ],
        overlay: Buffer.alloc(64, 1),
        certificate: { offset: 0x400, bytes: 64 },
      }),
    );
    expect(signed.overlay).toMatchObject({
      location: { offset: 0x400, bytes: 64 },
      certificate_table: { offset: 0x400, bytes: 64 },
    });
    expect(signed.indicators).toEqual([]);
  });

  it("reports unreadable imports instead of guessing", () => {
    const report = parse(
      peImage({
        entryRva: 0x1000,
        importRva: 0x9000,
        sections: [
          {
            name: ".text",
            virtualSize: 0x200,
            rva: 0x1000,
            raw: plain(0x200),
            characteristics: CODE_RX,
          },
        ],
      }),
    );
    expect(report.imports).toMatchObject({ status: "unreadable" });
    expect(report.verdict.status).toBe("unknown");
  });
});

describe("static ELF packer indicators and failures", () => {
  it("reports an ordinary ELF64 with sections as not_observed", () => {
    const report = parse(
      elfImage({
        entry: 0x401000n,
        segments: [
          { flags: 5, vaddr: 0x401000n, data: plain(0x400) },
          {
            flags: 6,
            vaddr: 0x402000n,
            data: Buffer.alloc(0x40),
            memsz: 0x100,
          },
        ],
        sections: [
          { name: ".text", flags: 6, segment: 0 },
          { name: ".data", flags: 3, segment: 1 },
        ],
      }),
    );
    expect(report.format).toBe("elf64");
    expect(report.regions.map(({ kind, name }) => [kind, name])).toEqual([
      ["segment", null],
      ["segment", null],
      ["section", ".text"],
      ["section", ".data"],
      ["section", ".shstrtab"],
    ]);
    expect(report.entry_point).toMatchObject({
      address: "0x401000",
      region_index: 0,
    });
    expect(report.imports.status).toBe("not_applicable");
    expect(report.verdict.status).toBe("not_observed");
  });

  it.each([true, false])(
    "reports UPX-shaped ELF indicators (elf64=%s)",
    (elf64) => {
      const payload = Buffer.concat([
        noise(0x1000),
        Buffer.from("UPX!"),
        noise(0x800, 7),
      ]);
      const report = parse(
        elfImage({
          elf64,
          entry: 0x400100n,
          segments: [
            { flags: 7, vaddr: 0x400000n, data: payload, memsz: 0x40000 },
          ],
        }),
      );
      expect(report.format).toBe(elf64 ? "elf64" : "elf32");
      expect(report.signatures.magic).toHaveLength(1);
      expect(new Set(ids(report))).toEqual(
        new Set([
          "packer_magic",
          "entry_in_writable_executable_region",
          "high_entropy_executable_region",
          "virtual_only_region",
          "elf_without_section_headers",
        ]),
      );
      expect(report.verdict.status).toBe("likely_packed");
    },
  );

  it("rejects non-PE/ELF input and truncated headers as format failures", () => {
    for (const bytes of [
      Buffer.from("plain text, not an image"),
      Buffer.concat([Buffer.from("MZ"), Buffer.alloc(10)]),
      Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9]),
        Buffer.alloc(60),
      ]),
    ])
      expect(() => parsePackerIndicators(bytes, artifact(bytes))).toThrow(
        expect.objectContaining({ reason: "format" }),
      );
  });

  it("does not throw on hostile section ranges", () => {
    const bytes = ordinaryPe();
    // Point .data raw bytes past the end of the file.
    const table = 0x80 + 24 + 224;
    bytes.writeUInt32LE(0xfffff000, table + 2 * 40 + 20);
    const report = parse(bytes);
    expect(report.regions[2]?.raw.bytes).toBe(0);
    expect(report.verdict.status).toBe("unknown");
  });
});
