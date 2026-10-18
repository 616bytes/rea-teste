import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import { addJavaScriptBundlerNodes } from "./JavaScriptArtifactGraphBundlers.js";
import {
  artifactLocalIdentity,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import { artifactObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import { completeApplicationCoverage } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";

const sha256 = "a".repeat(64);

const project = (
  source: string,
  includeEntryRelationship = false,
  legacy = false,
) => {
  const javascript = analyzeJavaScriptStaticSource(source);
  const projectedJavaScript = {
    ...javascript,
    bundler_registrations: javascript.bundler_registrations.map(
      (registration) => {
        const { interpretation: _interpretation, ...oldRecord } = registration;
        return {
          ...(legacy ? oldRecord : registration),
          ...(includeEntryRelationship
            ? {
                ...registration,
                entry_module_keys: registration.modules.map(
                  (moduleValue) => moduleValue.module_key,
                ),
              }
            : {}),
        };
      },
    ),
  };
  const file: JavaScriptArtifactFile = {
    path: "entry.js",
    container_sha256: sha256,
    sha256,
    bytes: source.length,
    inventory_artifact_id: `art_${sha256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: source },
  };
  const accumulator = new JavaScriptArtifactGraphAccumulator();
  const asset = accumulator.addNode({
    kind: "javascript-asset",
    identity: artifactLocalIdentity(sha256, "asset", file.path),
    observations: [
      {
        label: file.path,
        properties: {},
        evidence: artifactObservationEvidence({
          sha256,
          path: file.path,
          operation: "inventory-entry",
          coverage: completeApplicationCoverage(),
        }),
      },
    ],
  });
  const context = {
    accumulator,
    analysis: {
      files: [{ file, javascript: projectedJavaScript, semantic: null }],
    },
    assetNodes: new Map([[file.path, asset]]),
    chunkNodes: new Map(),
    moduleNodes: new Map(),
  } as unknown as JavaScriptArtifactGraphContext;
  const limitations = addJavaScriptBundlerNodes(context);
  return {
    javascript,
    nodes: accumulator.nodes(),
    edges: accumulator.edges(),
    limitations,
  };
};

it("carries uncertain helper origin through chunk, module and containment evidence", () => {
  const { javascript, nodes, edges } = project(
    'const __commonJS = value => value; __commonJS({ "fake.js"(exports) { exports.x = 1; } });',
  );
  expect(javascript.parse_status).toBe("complete");
  for (const kind of ["javascript-chunk", "javascript-module"] as const) {
    const node = nodes.find((value) => value.kind === kind);
    expect(node).toBeDefined();
    expect(node?.observations[0]?.properties).toMatchObject({
      interpretation: "candidate",
    });
    expect(node?.observations[0]?.evidence).toMatchObject({
      state: "inferred",
      confidence: "low",
      authority: "static-relationship-inference",
    });
    expect(
      node?.observations[0]?.evidence.limitations.some((value) =>
        /helper|origin|candidate/iu.test(value),
      ),
    ).toBe(true);
  }
  const candidateEdges = edges.filter(
    (edge) =>
      nodes.some(
        (node) =>
          node.kind === "javascript-chunk" &&
          edge.target_node_id === node.node_id,
      ) ||
      nodes.some(
        (node) =>
          node.kind === "javascript-module" &&
          edge.target_node_id === node.node_id,
      ),
  );
  expect(candidateEdges.length).toBeGreaterThanOrEqual(2);
  for (const edge of candidateEdges) {
    expect(edge.evidence).toMatchObject({
      state: "inferred",
      confidence: "low",
    });
    expect(
      edge.evidence.limitations.some((value) =>
        /helper|origin|candidate/iu.test(value),
      ),
    ).toBe(true);
  }
  expect(
    nodes.find((value) => value.kind === "javascript-asset")?.observations[0]
      ?.evidence,
  ).toMatchObject({
    state: "observed",
    confidence: "exact",
    authority: "artifact-bytes",
  });
});

it("does not upgrade a candidate's resolved entry relationship to high confidence", () => {
  // Esbuild's direct wrapper has no entry key; supply a consumer-level
  // relationship so this graph branch is tested without claiming the parser inferred it.
  const { edges } = project(
    'const __commonJS = value => value; __commonJS({ "fake.js"() {} });',
    true,
  );
  const entry = edges.find(
    (edge) =>
      edge.relation === "loads" &&
      edge.properties.kind === "bundler-entry-module",
  );
  expect(entry).toBeDefined();
  expect(entry?.properties).toMatchObject({
    interpretation: "candidate",
    resolution_status: "resolved",
  });
  expect(entry?.evidence).toMatchObject({
    authority: "static-relationship-inference",
    state: "inferred",
    confidence: "low",
  });
  expect(
    entry?.evidence.limitations.some((value) =>
      /helper|origin|candidate/iu.test(value),
    ),
  ).toBe(true);
});

it("does not create bundler nodes for an unrelated renamed wrapper", () => {
  const { javascript, nodes, limitations } = project(
    'const wrap = value => value; wrap({ "fake.js"() {} });',
  );
  expect(javascript.parse_status).toBe("complete");
  expect(
    nodes.filter(
      (node) =>
        node.kind === "javascript-chunk" || node.kind === "javascript-module",
    ),
  ).toEqual([]);
  expect(
    limitations.filter((value) => /esbuild helper origin/iu.test(value)),
  ).toEqual([]);
});

it("reports the candidate caveat once for a multi-module registration", () => {
  const { nodes, limitations } = project(
    '__commonJS({ "a.js"() {}, "b.js"() {}, "c.js"() {} });',
  );
  expect(
    nodes.filter((node) => node.kind === "javascript-module"),
  ).toHaveLength(3);
  expect(
    limitations.filter((value) => /esbuild helper origin/iu.test(value)),
  ).toHaveLength(1);
});

it("treats legacy esbuild records without interpretation as uncertain", () => {
  const { nodes, edges, limitations } = project(
    '__commonJS({ "old.js"() {} });',
    false,
    true,
  );
  for (const node of nodes.filter(
    (value) =>
      value.kind === "javascript-chunk" || value.kind === "javascript-module",
  )) {
    expect(node.observations[0]?.properties).toMatchObject({
      interpretation: "candidate",
    });
    expect(node.observations[0]?.evidence).toMatchObject({
      state: "inferred",
      confidence: "low",
    });
  }
  expect(
    edges.filter((edge) => edge.properties.interpretation === "candidate"),
  ).toHaveLength(2);
  expect(
    limitations.filter((value) => /esbuild helper origin/iu.test(value)),
  ).toHaveLength(1);
});
