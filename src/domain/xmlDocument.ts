import {
  DOMParser,
  normalizeLineEndings,
  onErrorStopParsing,
  type Document,
} from "@xmldom/xmldom";
import { SaxesParser } from "saxes";
import { err, ok, type Result } from "./result.js";

const rawDataContents = new WeakMap<Document, readonly string[]>();

export class XmlDocumentParseError extends Error {
  readonly _tag = "XmlDocumentParseError";
  constructor(
    readonly reason: "malformed" | "doctype",
    cause?: unknown,
  ) {
    super(
      reason === "doctype"
        ? "XML document types are unsupported"
        : `XML is not well-formed${cause instanceof Error ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
}

/** One boundary owns strict XML syntax and the source-located DOM projection. */
export const parseXmlDocument = (
  source: string,
  policy: {
    readonly doctype: "allow" | "reject";
    readonly lineEndings: "preserve" | "normalize";
  },
): Result<Document, XmlDocumentParseError> => {
  try {
    const syntax = new SaxesParser({
      defaultXMLVersion: "1.0",
      forceXMLVersion: true,
      trackPosition: true,
    });
    const dataStarts: number[] = [];
    const dataContents: string[] = [];
    syntax.on("opentag", (tag) => {
      if (tag.name === "data" && !tag.isSelfClosing)
        dataStarts.push(syntax.position);
    });
    syntax.on("closetag", (tag) => {
      if (tag.name !== "data" || dataStarts.length === 0) return;
      const start = dataStarts.pop()!;
      const closeStart = source.lastIndexOf("</data>", syntax.position);
      if (closeStart >= start)
        dataContents.unshift(source.slice(start, closeStart));
    });
    syntax.on("doctype", () => {
      if (policy.doctype === "reject")
        throw new XmlDocumentParseError("doctype");
    });
    syntax.write(source).close();
    // Saxes owns well-formedness outside DTDs. The DOM parser additionally
    // checks DTD syntax and builds source-located nodes; its advisory warnings
    // (including literal U+FFFD) are not byte-decoding or syntax failures.
    const document = new DOMParser({
      normalizeLineEndings:
        policy.lineEndings === "preserve"
          ? (text) => text
          : normalizeLineEndings,
      onError: onErrorStopParsing,
    }).parseFromString(source, "application/xml");
    rawDataContents.set(document, dataContents);
    return ok(document);
  } catch (cause: unknown) {
    return err(
      cause instanceof XmlDocumentParseError
        ? cause
        : new XmlDocumentParseError("malformed", cause),
    );
  }
};

/** Raw XML interiors for valid `<data>` elements, in document order. */
export const getRawXmlDataContents = (document: Document): readonly string[] =>
  rawDataContents.get(document) ?? [];
