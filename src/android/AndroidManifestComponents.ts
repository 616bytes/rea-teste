import type { Element, Node } from "@xmldom/xmldom";

import { parseXmlDocument } from "../domain/xmlDocument.js";

/** Component kinds a decoded AndroidManifest can declare under <application>. */
export const ANDROID_COMPONENT_KINDS = [
  "activity",
  "activity-alias",
  "service",
  "receiver",
  "provider",
] as const;
export type AndroidComponentKind = (typeof ANDROID_COMPONENT_KINDS)[number];

/** Bounds keep a hostile manifest from exhausting the inspection. */
export const ANDROID_MANIFEST_LIMITS = {
  components: 512,
  intentFilters: 32,
  intentValues: 64,
} as const;

export interface AndroidManifestComponent {
  readonly kind: AndroidComponentKind;
  /** Class name as written in the manifest. */
  readonly declared_name: string;
  /** Fully qualified name with the manifest package applied. */
  readonly name: string;
  /** Declared android:exported, or null when the attribute is absent. */
  readonly exported: boolean | null;
  /**
   * Android's default for an absent android:exported: true when the component
   * declares at least one intent filter, false otherwise.
   */
  readonly exported_by_intent_filter: boolean;
  readonly permission: string | null;
  readonly intent_filter_count: number;
  readonly actions: readonly string[];
  readonly categories: readonly string[];
  /** Declared android:foregroundServiceType on services; null otherwise. */
  readonly foreground_service_type: string | null;
  /** Declared android:authorities on providers, split on ";". */
  readonly authorities: readonly string[] | null;
  /** Declared android:targetActivity on activity-alias. */
  readonly target_activity: string | null;
}

export interface AndroidManifestComponentInventory {
  readonly status: "complete" | "partial" | "unavailable";
  readonly items: readonly AndroidManifestComponent[];
  readonly limitations: readonly string[];
}

const PARTIAL_LIMITATION =
  "The decoded manifest text is truncated, so its component inventory is not established; the retained manifest is partial.";

const unavailable = (
  limitation: string,
): AndroidManifestComponentInventory => ({
  status: "unavailable",
  items: [],
  limitations: [limitation],
});

const childNodes = (element: Element): readonly Node[] =>
  Array.from(element.childNodes);

/** Read an attribute by local name, ignoring its namespace prefix. */
const attribute = (element: Element, localName: string): string | null => {
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const node = attributes.item(index);
    if (node === null) continue;
    const name = node.nodeName.split(":").at(-1);
    if (name === localName) return node.nodeValue;
  }
  return null;
};

const booleanAttribute = (element: Element, name: string): boolean | null => {
  const value = attribute(element, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

const trimmed = (element: Element, name: string): string | null => {
  const value = attribute(element, name)?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

/**
 * Android resolves a component name against the manifest package: a leading
 * dot or a name without any dot is relative to the package, while a dotted
 * name is already fully qualified.
 */
export const resolveAndroidComponentName = (
  packageName: string | null,
  declared: string,
): string => {
  if (declared.startsWith(".")) return `${packageName ?? ""}${declared}`;
  if (!declared.includes(".") && packageName !== null)
    return `${packageName}.${declared}`;
  return declared;
};

const isComponentKind = (tag: string): tag is AndroidComponentKind =>
  (ANDROID_COMPONENT_KINDS as readonly string[]).includes(tag);

/** Collect unique intent-filter actions and categories within the bound. */
const intentValues = (
  filters: readonly Element[],
): { actions: string[]; categories: string[]; truncated: boolean } => {
  const actions: string[] = [];
  const categories: string[] = [];
  let truncated = filters.length > ANDROID_MANIFEST_LIMITS.intentFilters;
  for (const filter of filters.slice(0, ANDROID_MANIFEST_LIMITS.intentFilters))
    for (const member of childNodes(filter)) {
      if (member.nodeType !== 1) continue;
      const element = member as Element;
      if (element.nodeName !== "action" && element.nodeName !== "category")
        continue;
      const value = trimmed(element, "name");
      if (value === null) continue;
      const target = element.nodeName === "action" ? actions : categories;
      if (target.includes(value)) continue;
      if (target.length >= ANDROID_MANIFEST_LIMITS.intentValues) {
        truncated = true;
        continue;
      }
      target.push(value);
    }
  return { actions, categories, truncated };
};

/**
 * Parse the decoded AndroidManifest XML text into a bounded, deterministic
 * component inventory. The projection is static: it reports declarations and
 * Android's documented export default, never merged-manifest or runtime state.
 */
export const parseAndroidManifestComponents = (
  manifestText: string,
  coverage: "complete" | "partial",
): AndroidManifestComponentInventory => {
  if (coverage === "partial")
    return {
      status: "partial",
      items: [],
      limitations: [PARTIAL_LIMITATION],
    };
  const parsed = parseXmlDocument(manifestText, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    return unavailable(
      `The decoded manifest is not well-formed XML (${parsed.error.reason}), so its component inventory is unavailable.`,
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "manifest")
    return unavailable(
      "The decoded manifest root is not <manifest>, so its component inventory is unavailable.",
    );
  const packageName = trimmed(root, "package");
  const limitations: string[] = [];
  const items: AndroidManifestComponent[] = [];
  let truncated = false;
  let applicationSeen = false;
  for (const node of childNodes(root)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.nodeName !== "application") continue;
    applicationSeen = true;
    for (const child of childNodes(element)) {
      if (child.nodeType !== 1) continue;
      const component = child as Element;
      if (!isComponentKind(component.nodeName)) continue;
      if (items.length >= ANDROID_MANIFEST_LIMITS.components) {
        truncated = true;
        break;
      }
      const declared = trimmed(component, "name");
      if (declared === null) {
        limitations.push(
          `A <${component.nodeName}> without android:name is omitted from the inventory.`,
        );
        continue;
      }
      const filters = childNodes(component).filter(
        (entry): entry is Element =>
          entry.nodeType === 1 && entry.nodeName === "intent-filter",
      );
      const collected = intentValues(filters);
      if (collected.truncated) truncated = true;
      const authorities = trimmed(component, "authorities");
      items.push({
        kind: component.nodeName,
        declared_name: declared,
        name: resolveAndroidComponentName(packageName, declared),
        exported: booleanAttribute(component, "exported"),
        exported_by_intent_filter: filters.length > 0,
        permission: trimmed(component, "permission"),
        intent_filter_count: filters.length,
        actions: collected.actions,
        categories: collected.categories,
        foreground_service_type:
          component.nodeName === "service"
            ? trimmed(component, "foregroundServiceType")
            : null,
        authorities:
          component.nodeName === "provider" && authorities !== null
            ? authorities
                .split(";")
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
            : null,
        target_activity:
          component.nodeName === "activity-alias"
            ? trimmed(component, "targetActivity")
            : null,
      });
    }
  }
  if (!applicationSeen)
    limitations.push(
      "The manifest declares no <application> element, so no components were projected.",
    );
  if (truncated)
    limitations.push(
      `The component inventory stops at ${ANDROID_MANIFEST_LIMITS.components} components, ${ANDROID_MANIFEST_LIMITS.intentFilters} intent filters per component, or ${ANDROID_MANIFEST_LIMITS.intentValues} values per component.`,
    );
  return {
    status: truncated ? "partial" : "complete",
    items,
    limitations,
  };
};
