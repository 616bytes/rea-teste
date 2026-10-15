import { expect, test } from "vitest";

import {
  AdbUiHierarchyFormatError,
  extractUiHierarchyDocument,
  isMeaningfulUiNode,
  parseUiBounds,
  parseUiHierarchyXml,
  projectUiNode,
  selectUiNodes,
} from "./AdbUiHierarchy.js";

const node = (attributes: string, children = "") =>
  `<node index="0" ${attributes} checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false">${children}</node>`;

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node(
  'text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" bounds="[0,0][1080,2340]"',
  node(
    'text="Sign in" resource-id="com.example.app:id/login" class="android.widget.Button" package="com.example.app" content-desc="" bounds="[100,200][300,260]"',
  ).replace('clickable="false"', 'clickable="true"') +
    node(
      'text="" resource-id="" class="android.widget.ImageView" package="com.example.app" content-desc="Profile &amp; settings" bounds="[0,0][-1,5]"',
    ),
)}</hierarchy>`;

test("parses uiautomator nodes with parentage, bounds, and centers", () => {
  const hierarchy = parseUiHierarchyXml(DUMP, 100);
  expect(hierarchy).toMatchObject({
    rotation: 0,
    node_count: 3,
    truncated: false,
  });
  const [root, button, image] = hierarchy.nodes;
  expect(root).toMatchObject({
    ordinal: 0,
    depth: 0,
    parent: null,
    text: null,
  });
  expect(button).toMatchObject({
    ordinal: 1,
    depth: 1,
    parent: 0,
    resource_id: "com.example.app:id/login",
    text: "Sign in",
    bounds: { left: 100, top: 200, right: 300, bottom: 260 },
    center: { x: 200, y: 230 },
    clickable: true,
  });
  // Inverted bounds stay unparsed with their source retained.
  expect(image).toMatchObject({
    content_desc: "Profile & settings",
    bounds: null,
    center: null,
    bounds_source: "[0,0][-1,5]",
  });
});

test("counts nodes past the cap without materializing them", () => {
  const hierarchy = parseUiHierarchyXml(DUMP, 2);
  expect(hierarchy.nodes).toHaveLength(2);
  expect(hierarchy).toMatchObject({ node_count: 3, truncated: true });
});

test("rejects malformed or rootless documents", () => {
  expect(() => parseUiHierarchyXml("<hierarchy><node>", 10)).toThrow(
    AdbUiHierarchyFormatError,
  );
  expect(() => parseUiHierarchyXml("<other/>", 10)).toThrow(
    "no <hierarchy> root",
  );
});

test("extracts the document from output with a trailing status line", () => {
  expect(
    extractUiHierarchyDocument(`${DUMP}UI hierchary dumped to: /dev/tty\n`),
  ).toBe(DUMP);
  expect(extractUiHierarchyDocument("ERROR: could not get idle state.")).toBe(
    null,
  );
});

test("selects exact matches and projects compact flags", () => {
  const { nodes } = parseUiHierarchyXml(DUMP, 100);
  const matches = selectUiNodes(nodes, {
    resource_id: "com.example.app:id/login",
  });
  expect(matches.map(({ ordinal }) => ordinal)).toEqual([1]);
  expect(selectUiNodes(nodes, { text: "sign in" })).toEqual([]);
  expect(
    nodes.filter(isMeaningfulUiNode).map(({ ordinal }) => ordinal),
  ).toEqual([1, 2]);
  expect(projectUiNode(matches[0]!)).toMatchObject({
    flags: ["clickable", "enabled"],
    unreported_flags: [],
    bounds_source: null,
  });
});

test("parses bounds strictly", () => {
  expect(parseUiBounds("[0,0][10,20]")).toEqual({
    left: 0,
    top: 0,
    right: 10,
    bottom: 20,
  });
  expect(parseUiBounds("[0,0][10]")).toBe(null);
});
