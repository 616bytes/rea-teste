import { createHash } from "node:crypto";

import { z } from "zod";

import type { analysisStringSchema } from "../domain/hopperValues.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareKunaAddresses } from "./KunaAddress.js";
import { parseKunaJson } from "./KunaJson.js";

import {
  KUNA_STRING_OUTPUT_BYTES,
  KUNA_STRING_MIN_LENGTH,
} from "./KunaLimits.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const address = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u);
const addressKeys = new Set(["address"]);
const header = z.object({
  binary: z.string(),
  encoding: z.literal("all"),
  min_length: z.literal(KUNA_STRING_MIN_LENGTH),
  filter: z.null(),
  section: z.null(),
  termination: z.literal("any"),
  scanned: z.enum(["sections", "segments"]),
  xrefs: z.literal(false),
  count,
  strings: z.array(z.unknown()),
});
const row = z.object({
  address,
  address_hex: address,
  text: z.string(),
  length: count,
  byte_length: count,
  nul_terminated: z.boolean(),
  encoding: z.enum(["ascii", "utf8", "utf16"]),
  section: z.string().nullable(),
  xrefs_count: z.literal(0),
  functions: z.tuple([]),
});

export type KunaStringItem = z.infer<typeof analysisStringSchema>;

export interface KunaStringInventory {
  readonly items: readonly KunaStringItem[];
  readonly sha256: string;
  readonly bytes: number;
  readonly scanned: "sections" | "segments";
}

/** Validate the producer's complete scan before publishing any selected row. */
export const parseKunaStringInventory = (
  text: string,
  input: string,
): Result<KunaStringInventory, string> => {
  try {
    const document = header.parse(
      parseKunaJson(text, KUNA_STRING_OUTPUT_BYTES, addressKeys),
    );
    if (document.binary !== input)
      throw new Error("string inventory names a different input");
    if (document.count !== document.strings.length)
      throw new Error("string inventory count disagrees with examined rows");
    const seen = new Set<string>();
    const items = document.strings.map((value): KunaStringItem => {
      const entry = row.parse(value);
      if (entry.address !== entry.address_hex)
        throw new Error("string address disagrees with its hex field");
      const identity = `${entry.address}:${entry.encoding}`;
      if (seen.has(identity))
        throw new Error("string inventory repeats an identity");
      seen.add(identity);
      return {
        address: entry.address,
        value: entry.text,
        string: {
          encoding: entry.encoding,
          encoding_status: "observed",
          termination: entry.nul_terminated
            ? "present_or_not_required"
            : "missing",
          byte_length: entry.byte_length,
        },
      };
    });
    items.sort(
      (left, right) =>
        compareKunaAddresses(left.address, right.address) ||
        (left.string?.encoding ?? "").localeCompare(
          right.string?.encoding ?? "",
          "en",
        ),
    );
    return ok({
      items,
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
      scanned: document.scanned,
    });
  } catch (cause: unknown) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
};
