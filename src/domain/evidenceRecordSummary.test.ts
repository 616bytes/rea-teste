import { expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import { summarizeEvidenceBundle } from "./evidenceRecordSummary.js";

it("preserves native identity independently of missing or incompatible value-flow metadata", () => {
  const records = [
    undefined,
    { available: true, truncated: true },
    { unexpected: "legacy" },
    { available: false, reason: "Decompiler unavailable" },
  ].map((flow) =>
    createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "provider", name: "Provider", version: "1" },
      {
        operation: "analyze_function",
        parameters: {},
        result: {
          procedure: { address: "space:0x10", name: "entry" },
          ...(flow === undefined ? {} : { native_value_flow: flow }),
        },
      },
    ),
  );
  const summary = summarizeEvidenceBundle(createEvidenceBundle(records), {
    procedure_address: "space:0x10",
  });
  expect(summary.matching_records).toBe(4);
  const native = summary.records.map((r) => r.native_dossier);
  expect(
    native.every((r) => r.available && r.procedure_address === "space:0x10"),
  ).toBe(true);
  expect(native).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value_flow: { status: "not-recorded" } }),
      expect.objectContaining({
        value_flow: {
          status: "observed",
          truncated: true,
          omitted_operations_lower_bound: null,
          known_omitted_inputs: null,
          known_omitted_edges: null,
        },
      }),
      expect.objectContaining({
        value_flow: { status: "unknown", reason: expect.any(String) },
      }),
      expect.objectContaining({
        value_flow: { status: "unavailable", reason: "Decompiler unavailable" },
      }),
    ]),
  );
});

it("selects records containing every query term literally and reports a snippet", () => {
  const record = (strings: string[]) =>
    createEvidence(
      { path: "/fixtures/app.asar", format: "asar", sha256: "b".repeat(64) },
      { id: "provider", name: "Provider", version: "1" },
      { operation: "list_strings", parameters: {}, result: { strings } },
    );
  const bundle = createEvidenceBundle([
    record(["x".repeat(40) + "LOWER(title) LIKE :t0 ESCAPE", "100%_done"]),
    record(["LOWER(title) only"]),
  ]);
  const summary = summarizeEvidenceBundle(bundle, { query: "  like  lower " });
  expect(summary.matching_records).toBe(1);
  const match = summary.records[0]!.query_match!;
  expect(match.path).toBe("/normalized_result/strings/0");
  expect(
    match.snippet.slice(
      match.match_start,
      match.match_start + match.match_length,
    ),
  ).toBe("LIKE");
  expect(match.snippet.startsWith("…")).toBe(true);
  // Wildcard characters are literal text, not patterns.
  expect(
    summarizeEvidenceBundle(bundle, { query: "%_" }).matching_records,
  ).toBe(1);
  expect(
    summarizeEvidenceBundle(bundle, { query: "x_x" }).matching_records,
  ).toBe(0);
  expect(summarizeEvidenceBundle(bundle).records[0]!.query_match).toBeNull();
});

it("matches terms across result leaves and limitations", () => {
  const evidence = createEvidence(
    { path: "/fixtures/app.asar", format: "asar", sha256: "c".repeat(64) },
    { id: "provider", name: "Provider", version: "1" },
    {
      operation: "list_strings",
      parameters: {},
      result: { strings: ["alpha", "beta"] },
      limitations: ["gamma was truncated"],
    },
  );
  const bundle = createEvidenceBundle([evidence]);
  const summary = summarizeEvidenceBundle(bundle, {
    query: "gamma beta alpha",
  });
  expect(summary.records[0]!.query_match!.path).toBe("/limitations/0");
  expect(
    summarizeEvidenceBundle(bundle, { query: "beta gamma" }).records[0]!
      .query_match!.path,
  ).toBe("/normalized_result/strings/1");
  expect(
    summarizeEvidenceBundle(bundle, { query: "alpha delta" }).matching_records,
  ).toBe(0);
});

it("folds case per code point and excerpts the original text", () => {
  const match = (text: string, query: string) =>
    summarizeEvidenceBundle(
      createEvidenceBundle([
        createEvidence(
          {
            path: "/fixtures/app.asar",
            format: "asar",
            sha256: "d".repeat(64),
          },
          { id: "provider", name: "Provider", version: "1" },
          { operation: "list_strings", parameters: {}, result: [text] },
        ),
      ]),
      { query },
    ).records[0]?.query_match;
  expect(match("ΟΣ", "Σ")).toMatchObject({ snippet: "ΟΣ", match_start: 1 });
  const dotted = match("İ LIKE", "like")!;
  expect(dotted.snippet).toBe("İ LIKE");
  expect(
    dotted.snippet.slice(
      dotted.match_start,
      dotted.match_start + dotted.match_length,
    ),
  ).toBe("LIKE");
  const emoji = match("😀" + "x".repeat(29) + "MATCH", "match")!;
  expect(emoji.snippet.startsWith("😀")).toBe(true);
  expect(emoji.offset_units).toBe("utf16-code-units");
});
