import type { PlistNumberLiterals } from "../../domain/apple/plistNumbers.js";
import { decodeXmlText } from "../../domain/propertyListKeys.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";

const collector = () => {
  const integers = new Map<number, Set<string>>();
  const reals = new Set<number>();
  let unsafeIntegerLiterals = 0;
  let incompleteMetadata = false;
  return {
    integer: (literal: string) => {
      if (!/^[+-]?\d+$/u.test(literal)) {
        incompleteMetadata = true;
        return;
      }
      const exact = BigInt(literal);
      if (
        exact >= BigInt(Number.MIN_SAFE_INTEGER) &&
        exact <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        return;
      unsafeIntegerLiterals += 1;
      const rounded = Number(exact);
      integers.set(
        rounded,
        (integers.get(rounded) ?? new Set()).add(exact.toString()),
      );
    },
    real: (value: number) => {
      reals.add(value);
    },
    markIncomplete: () => {
      incompleteMetadata = true;
    },
    result: (incomplete = false): PlistNumberLiterals => ({
      incomplete: incomplete || incompleteMetadata,
      integers,
      reals,
      unsafeIntegerLiterals,
    }),
  };
};
// Consume quoted tag attributes and opaque comment/CDATA tokens whole.
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
const OPAQUE_ELEMENTS = new Set(["string", "key", "data", "date"]);

/** Observe plist number element types without interpreting strings or class code. */
export const xmlPlistNumberLiterals = (xml: string): PlistNumberLiterals => {
  const output = collector();
  const elements: string[] = [];
  let number:
    | {
        kind: "integer" | "real";
        text: string;
        depth: number;
        plainText: boolean;
      }
    | undefined;
  let cursor = 0;
  for (const match of xml.matchAll(XML_TOKEN)) {
    const index = match.index;
    if (number !== undefined) number.text += xml.slice(cursor, index);
    const token = match[0];
    cursor = index + token.length;
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[")) {
      if (number !== undefined) {
        number.plainText = false;
        output.markIncomplete();
      }
      continue;
    }
    const tag = /^<\s*(\/?)\s*([\w:-]+)/u.exec(token);
    if (tag === null) {
      if (number !== undefined) {
        number.plainText = false;
        output.markIncomplete();
      }
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2];
    if (name === undefined) continue;
    if (closing) {
      if (
        number !== undefined &&
        number.kind === name &&
        number.depth === elements.length
      ) {
        if (number.plainText) {
          const text = decodeXmlText(number.text).trim();
          if (number.kind === "integer") output.integer(text);
          else output.real(Number.parseFloat(text));
        }
        number = undefined;
      }
      elements.pop();
      continue;
    }
    // The pinned decoder reads only the first child for integers and only text
    // nodes for reals. Mixed content cannot establish an exact association.
    if (number !== undefined) {
      number.plainText = false;
      output.markIncomplete();
    }
    if (/\/\s*>$/u.test(token)) continue;
    if (
      number === undefined &&
      (name === "integer" || name === "real") &&
      !elements.some((parent) => OPAQUE_ELEMENTS.has(parent))
    )
      number = {
        kind: name,
        text: "",
        depth: elements.length + 1,
        plainText: true,
      };
    elements.push(name);
  }
  return output.result();
};

export interface BinaryPlistNumberMetadata {
  readonly literals: PlistNumberLiterals;
  /** 16-byte integers the pinned plist decoder cannot decode correctly. */
  readonly wideIntegers: readonly { offset: number; value: bigint }[];
}

/** Observe bounded binary number markers without changing primary decode acceptance. */
export const scanBinaryPlistNumberLiterals = (
  bytes: Buffer,
): BinaryPlistNumberMetadata => {
  const output = collector();
  const wideIntegers: { offset: number; value: bigint }[] = [];
  if (bytes.length < 40 || !hasBinaryPlistSignature(bytes))
    return { literals: output.result(true), wideIntegers };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 0;
  if (![1, 2, 4, 8].includes(offsetWidth))
    return { literals: output.result(true), wideIntegers };
  const countRaw = view.getBigUint64(trailer + 8);
  const tableRaw = view.getBigUint64(trailer + 24);
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (countRaw === 0n || countRaw > safeMaximum || tableRaw > safeMaximum)
    return { literals: output.result(true), wideIntegers };
  if (tableRaw < 8n || tableRaw >= BigInt(trailer))
    return { literals: output.result(true), wideIntegers };
  const offsetTable = Number(tableRaw);
  const capacity = Math.floor((trailer - offsetTable) / offsetWidth);
  if (countRaw > BigInt(capacity))
    return { literals: output.result(true), wideIntegers };
  const count = Number(countRaw);
  const unsigned = (offset: number): number | undefined => {
    if (offset < offsetTable || offset + offsetWidth > trailer)
      return undefined;
    if (offsetWidth === 1) return view.getUint8(offset);
    if (offsetWidth === 2) return view.getUint16(offset);
    if (offsetWidth === 4) return view.getUint32(offset);
    const value = view.getBigUint64(offset);
    return value > safeMaximum ? undefined : Number(value);
  };
  for (let index = 0; index < count; index += 1) {
    const offset = unsigned(offsetTable + index * offsetWidth);
    if (offset === undefined || offset < 8 || offset >= offsetTable)
      return { literals: output.result(true), wideIntegers };
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 1 && type !== 2) continue;
    const width = 2 ** (marker & 0xf);
    if (offset + 1 + width > offsetTable)
      return { literals: output.result(true), wideIntegers };
    if (type === 1 && width === 8)
      output.integer(view.getBigInt64(offset + 1).toString());
    else if (type === 1 && width === 16) {
      const value = BigInt.asIntN(
        128,
        (view.getBigUint64(offset + 1) << 64n) | view.getBigUint64(offset + 9),
      );
      output.integer(value.toString());
      wideIntegers.push({ offset, value });
    } else if (type === 1 && width > 4)
      return { literals: output.result(true), wideIntegers };
    else if (type === 2 && width === 4)
      output.real(view.getFloat32(offset + 1));
    else if (type === 2 && width === 8)
      output.real(view.getFloat64(offset + 1));
    else if (type === 2) return { literals: output.result(true), wideIntegers };
  }
  return { literals: output.result(), wideIntegers };
};

/** Preserve 16-byte integers through plist@5's Number-only parser. */
export const decodeBinaryPlistNumbers = (
  bytes: Buffer,
  metadata: BinaryPlistNumberMetadata,
): Buffer => {
  if (metadata.wideIntegers.length === 0) return bytes;
  const compatible = Buffer.from(bytes);
  for (const { offset, value } of metadata.wideIntegers) {
    // Convert only the decoder's input copy to a double. Exact integer metadata
    // from the original bytes restores decimal text after the structural parse.
    compatible[offset] = 0x23;
    compatible.writeDoubleBE(Number(value), offset + 1);
  }
  return compatible;
};
