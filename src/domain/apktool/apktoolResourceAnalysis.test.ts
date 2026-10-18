import { expect, it } from "vitest";
import {
  androidLocaleDirectorySuffix,
  androidLocaleQualifierSchema,
  apktoolRequestSchema,
  classifyAndroidStringsTable,
} from "./apktoolResourceAnalysis.js";

it.each([
  "de",
  "pt-rBR",
  "b+es+419",
  "b+sr+Latn",
  "b+zh+Hans+CN",
  "b+sr+Latn+RS+REVISED",
  "b+fil+Latn+419+ABCDEFGH",
])("recognizes the exact selectable strings table values-%s", (suffix) => {
  expect(classifyAndroidStringsTable(suffix)).toEqual({
    kind: "locale",
    locale: suffix,
  });
});

it.each([
  "en-rUS-v21",
  "b+zh+Hans+CN-night",
  "pt-rBR-sw600dp",
  "mcc310-fr",
  "mcc310-mnc004-en-rUS-v21",
  "car",
  "night",
  "v21",
  "pt-BR",
  "en-419",
  "en-r419",
  "unknown_CONFIGURATION",
  "",
])(
  "preserves a non-selectable configuration suffix without inferring its locale: %s",
  (suffix) => {
    expect(classifyAndroidStringsTable(suffix)).toEqual({
      kind: "other",
      suffix,
    });
  },
);

it.each([
  ["pt-BR", "pt-rBR"],
  ["es-419", "b+es+419"],
  ["en-419", "b+en+419"],
  ["fil-419", "b+fil+419"],
  ["pt-rBR", "pt-rBR"],
  ["b+zh+Hans+CN", "b+zh+Hans+CN"],
])(
  "normalizes the request alias %s at the selection owner",
  (locale, suffix) => {
    expect(androidLocaleDirectorySuffix(locale)).toBe(suffix);
  },
);

it.each([
  "es-r419",
  "en-r419",
  "b+fil+Latn+419+ABCDEFGH+US",
  "b+sr+Latn+RS+REVISED-v21",
  "../values-fr",
  "car",
  "night",
])(
  "refuses suffixes outside the bounded locale selection contract: %s",
  (suffix) => {
    expect(androidLocaleQualifierSchema.safeParse(suffix).success).toBe(false);
    expect(classifyAndroidStringsTable(suffix)).toEqual({
      kind: "other",
      suffix,
    });
  },
);

it.each(["es-419", "b+es+419"])(
  "preserves the admitted numeric-region request spelling %s",
  (locale) => {
    const request = {
      operation: "decode_android_resources",
      input: {
        path: "/targets/app.apk",
        include_strings: true,
        locale,
        locales: [locale],
      },
    };
    expect(apktoolRequestSchema.parse(request)).toEqual(request);
  },
);

it.each([{ locale: "es-r419" }, { locales: ["es-r419"] }])(
  "rejects an invalid numeric-region request at the owning boundary: %j",
  (selection) => {
    expect(
      apktoolRequestSchema.safeParse({
        operation: "decode_android_resources",
        input: { path: "/targets/app.apk", ...selection },
      }).success,
    ).toBe(false);
  },
);
