import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  "truncated_sections",
  "unavailable_sections",
  "policy_filtered_sections",
  "attach_limited_sections",
  "count_mismatch",
  "complete",
  "role_changed",
  "name_changed",
  "text_unavailable",
  "text_unavailable_role_changed",
  "text_unavailable_truncated",
  "text_unavailable_other_policy",
  "other_dimension_changed",
] as const)(
  "CLI compares accessibility coverage: %s",
  async (kind) => {
    const root = await createTestTempDirectory("rea-accessibility-comparison-");
    const before = passiveNetworkCapture();
    before.accessibility = {
      total_nodes: 2,
      text_capture: {
        status: "included",
        retained_bytes: 6,
        excluded_fields: 0,
      },
      nodes: [
        {
          node_id: "root",
          parent_id: null,
          role: "RootWebArea",
          name: null,
          description: null,
          ignored: false,
          states: [],
        },
        {
          node_id: "button",
          parent_id: "root",
          role: "button",
          name: "Submit",
          description: null,
          ignored: false,
          states: [],
        },
      ],
    };
    const after = structuredClone(before);
    if (kind === "count_mismatch") {
      after.accessibility.total_nodes += 1;
    } else if (
      kind === "truncated_sections" ||
      kind === "unavailable_sections" ||
      kind === "policy_filtered_sections" ||
      kind === "attach_limited_sections" ||
      kind === "other_dimension_changed"
    ) {
      const section =
        kind === "other_dimension_changed" ? "truncated_sections" : kind;
      after.completeness[section].push("accessibility");
      after.accessibility.nodes.pop();
      // Section coverage remains incomplete even when the retained count agrees.
      after.accessibility.total_nodes = after.accessibility.nodes.length;
    }
    if (kind.startsWith("text_unavailable")) {
      after.accessibility.text_capture = {
        status: "not_approved",
        retained_bytes: 0,
        excluded_fields: 1,
      };
      after.accessibility.nodes[1]!.name = null;
      after.completeness.policy_filtered_sections.push("accessibility");
      after.completeness.excluded.push({
        section: "accessibility",
        reason: "not_approved",
        count: 1,
      });
    }
    if (kind === "text_unavailable_truncated")
      after.completeness.truncated_sections.push("accessibility");
    if (kind === "text_unavailable_other_policy")
      after.completeness.excluded.push({
        section: "accessibility",
        reason: "disallowed_origin",
        count: 1,
      });
    if (
      kind === "role_changed" ||
      kind === "text_unavailable_role_changed" ||
      kind === "text_unavailable_truncated" ||
      kind === "text_unavailable_other_policy"
    )
      after.accessibility.nodes[1]!.role = "menuitem";
    if (kind === "name_changed") after.accessibility.nodes[1]!.name = "Send";
    if (kind === "other_dimension_changed")
      after.resources.push({
        resource_key: `res_${"a".repeat(64)}`,
        url: "https://app.example.test/new.css",
        origin: "https://app.example.test",
        type: "Stylesheet",
        mime_type: "text/css",
        content_size: 10,
      });
    const paths = [join(root, "before.json"), join(root, "after.json")];
    await Promise.all(
      [before, after].map((inspection, index) =>
        writeFile(paths[index]!, JSON.stringify({ inspection })),
      ),
    );
    const status =
      kind === "complete"
        ? "unchanged"
        : [
              "role_changed",
              "name_changed",
              "text_unavailable_role_changed",
            ].includes(kind)
          ? "changed"
          : "unknown";
    for (const pair of [paths, [...paths].reverse()]) {
      const result = await runCliJson([
        "compare-web-captures",
        ...pair,
        "--json",
      ]);
      expect(result).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: {
          dimensions: {
            accessibility: {
              status,
              total_changes: status === "changed" ? 1 : 0,
              changes:
                status === "changed"
                  ? [{ identity: "accessibility_tree", change: "modified" }]
                  : [],
            },
            ...(kind === "other_dimension_changed"
              ? { resources: { status: "changed", total_changes: 1 } }
              : {}),
          },
          ...(kind === "other_dimension_changed"
            ? { overall_status: "changed" }
            : {}),
        },
      });
    }
  },
  60_000,
);
