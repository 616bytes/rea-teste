import { SaxesParser } from "saxes";

/** Screen rectangle as uiautomator reports it: `[left,top][right,bottom]`. */
export interface AdbUiBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** One `<node>` of a uiautomator window dump, in document order. */
export interface AdbUiNode {
  /** Document-order position; stable within one dump only. */
  readonly ordinal: number;
  readonly depth: number;
  /** Ordinal of the enclosing node, or null for window roots. */
  readonly parent: number | null;
  readonly class_name: string | null;
  readonly package_name: string | null;
  readonly resource_id: string | null;
  readonly text: string | null;
  readonly content_desc: string | null;
  /** Source `bounds` attribute, retained when it does not parse. */
  readonly bounds_source: string | null;
  readonly bounds: AdbUiBounds | null;
  readonly center: { readonly x: number; readonly y: number } | null;
  readonly clickable: boolean | null;
  readonly long_clickable: boolean | null;
  readonly scrollable: boolean | null;
  readonly focusable: boolean | null;
  readonly focused: boolean | null;
  readonly enabled: boolean | null;
  readonly checkable: boolean | null;
  readonly checked: boolean | null;
  readonly selected: boolean | null;
  readonly password: boolean | null;
}

export interface AdbUiHierarchy {
  readonly rotation: number | null;
  readonly nodes: readonly AdbUiNode[];
  /** Total `<node>` elements seen, including those beyond `maxNodes`. */
  readonly node_count: number;
  readonly truncated: boolean;
}

export class AdbUiHierarchyFormatError extends Error {}

const BOUNDS_PATTERN = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u;

/** Parse the `bounds` attribute; malformed values stay null with source kept. */
export const parseUiBounds = (value: string): AdbUiBounds | null => {
  const match = BOUNDS_PATTERN.exec(value);
  if (match === null) return null;
  const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom };
};

const optionalText = (
  attributes: Readonly<Record<string, string>>,
  name: string,
): string | null => {
  const value = attributes[name];
  return value === undefined || value === "" ? null : value;
};

const flag = (
  attributes: Readonly<Record<string, string>>,
  name: string,
): boolean | null => {
  const value = attributes[name];
  return value === "true" ? true : value === "false" ? false : null;
};

/**
 * Parse `uiautomator dump` XML (`<hierarchy rotation=…>` containing nested
 * `<node>` elements). Empty attributes are absent facts, not empty strings.
 * Nodes past `maxNodes` are counted but not materialized.
 */
export const parseUiHierarchyXml = (
  xml: string,
  maxNodes: number,
): AdbUiHierarchy => {
  const parser = new SaxesParser({ xmlns: false });
  const nodes: AdbUiNode[] = [];
  const stack: number[] = [];
  let rotation: number | null = null;
  let sawRoot = false;
  let nodeCount = 0;
  let failure: Error | undefined;
  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.on("opentag", (tag) => {
    const attributes = tag.attributes as Record<string, string>;
    if (tag.name === "hierarchy") {
      sawRoot = true;
      const parsed = Number(attributes.rotation);
      rotation =
        attributes.rotation !== undefined && Number.isInteger(parsed)
          ? parsed
          : null;
      return;
    }
    if (tag.name !== "node") return;
    const ordinal = nodeCount;
    nodeCount += 1;
    const parent = stack.length === 0 ? null : stack[stack.length - 1]!;
    stack.push(ordinal);
    if (nodes.length >= maxNodes) return;
    const boundsSource = optionalText(attributes, "bounds");
    const bounds = boundsSource === null ? null : parseUiBounds(boundsSource);
    nodes.push({
      ordinal,
      depth: stack.length - 1,
      parent,
      class_name: optionalText(attributes, "class"),
      package_name: optionalText(attributes, "package"),
      resource_id: optionalText(attributes, "resource-id"),
      text: optionalText(attributes, "text"),
      content_desc: optionalText(attributes, "content-desc"),
      bounds_source: boundsSource,
      bounds,
      center:
        bounds === null
          ? null
          : {
              x: Math.floor((bounds.left + bounds.right) / 2),
              y: Math.floor((bounds.top + bounds.bottom) / 2),
            },
      clickable: flag(attributes, "clickable"),
      long_clickable: flag(attributes, "long-clickable"),
      scrollable: flag(attributes, "scrollable"),
      focusable: flag(attributes, "focusable"),
      focused: flag(attributes, "focused"),
      enabled: flag(attributes, "enabled"),
      checkable: flag(attributes, "checkable"),
      checked: flag(attributes, "checked"),
      selected: flag(attributes, "selected"),
      password: flag(attributes, "password"),
    });
  });
  parser.on("closetag", (tag) => {
    if (tag.name === "node") stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (cause) {
    failure ??= cause instanceof Error ? cause : new Error(String(cause));
  }
  if (failure !== undefined)
    throw new AdbUiHierarchyFormatError(
      `uiautomator output is not well-formed XML: ${failure.message}`,
      { cause: failure },
    );
  if (!sawRoot)
    throw new AdbUiHierarchyFormatError(
      "uiautomator output has no <hierarchy> root element",
    );
  return {
    rotation,
    nodes,
    node_count: nodeCount,
    truncated: nodeCount > nodes.length,
  };
};

/**
 * `uiautomator dump /dev/tty` and some builds append a status line such as
 * `UI hierchary dumped to: …` after the document. Keep only the XML document.
 */
export const extractUiHierarchyDocument = (stdout: string): string | null => {
  const start = stdout.indexOf("<?xml");
  const rootStart = start === -1 ? stdout.indexOf("<hierarchy") : start;
  const end = stdout.lastIndexOf("</hierarchy>");
  if (rootStart === -1 || end === -1 || end < rootStart) return null;
  return stdout.slice(rootStart, end + "</hierarchy>".length);
};

/** Caller selector over exact node facts; every provided field must match. */
export interface AdbUiSelector {
  readonly resource_id?: string | undefined;
  readonly text?: string | undefined;
  readonly content_desc?: string | undefined;
  readonly class_name?: string | undefined;
}

export const selectUiNodes = (
  nodes: readonly AdbUiNode[],
  selector: AdbUiSelector,
): readonly AdbUiNode[] =>
  nodes.filter(
    (node) =>
      (selector.resource_id === undefined ||
        node.resource_id === selector.resource_id) &&
      (selector.text === undefined || node.text === selector.text) &&
      (selector.content_desc === undefined ||
        node.content_desc === selector.content_desc) &&
      (selector.class_name === undefined ||
        node.class_name === selector.class_name),
  );

const NODE_FLAGS = [
  ["clickable", "clickable"],
  ["long_clickable", "long-clickable"],
  ["scrollable", "scrollable"],
  ["focusable", "focusable"],
  ["focused", "focused"],
  ["enabled", "enabled"],
  ["checkable", "checkable"],
  ["checked", "checked"],
  ["selected", "selected"],
  ["password", "password"],
] as const satisfies readonly (readonly [keyof AdbUiNode, string])[];

/** Nodes an analyst can identify or act on, rather than layout containers. */
export const isMeaningfulUiNode = (node: AdbUiNode): boolean =>
  node.resource_id !== null ||
  node.text !== null ||
  node.content_desc !== null ||
  node.clickable === true ||
  node.long_clickable === true ||
  node.scrollable === true ||
  node.checkable === true;

/** Compact result projection: true flags listed, unreported flags kept apart. */
export const projectUiNode = (node: AdbUiNode) => ({
  ordinal: node.ordinal,
  depth: node.depth,
  parent: node.parent,
  class_name: node.class_name,
  resource_id: node.resource_id,
  text: node.text,
  content_desc: node.content_desc,
  package_name: node.package_name,
  bounds: node.bounds,
  bounds_source:
    node.bounds === null && node.bounds_source !== null
      ? node.bounds_source
      : null,
  center: node.center,
  flags: NODE_FLAGS.filter(([key]) => node[key] === true).map(
    ([, name]) => name,
  ),
  unreported_flags: NODE_FLAGS.filter(([key]) => node[key] === null).map(
    ([, name]) => name,
  ),
});
