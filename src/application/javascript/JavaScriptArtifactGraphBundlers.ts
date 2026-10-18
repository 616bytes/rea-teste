import type { ApplicationNode } from "../../domain/javascript/javascriptApplicationGraphSchemas.js";
import {
  isCandidateBundlerRegistration,
  type JavaScriptBundlerRegistration,
} from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import {
  addAstContainsEdge,
  artifactLocalIdentity,
  chunkLookupKey,
  javascriptAnalysisCoverage,
  moduleLookupKey,
  selfReferenceOmissions,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";

/** Project Webpack/Rspack AST literals and disclose unrepresentable relationships. */
const ESBUILD_HELPER_LIMITATION =
  "The __commonJS/__esm spelling and literal table are visible, but the callee's esbuild helper origin and module execution semantics are unproven.";

const candidateProperties = (registration: JavaScriptBundlerRegistration) =>
  isCandidateBundlerRegistration(registration)
    ? { interpretation: "candidate" }
    : {};

const candidateLimitations = (registration: JavaScriptBundlerRegistration) =>
  isCandidateBundlerRegistration(registration)
    ? [ESBUILD_HELPER_LIMITATION]
    : [];

export const addJavaScriptBundlerNodes = (
  context: JavaScriptArtifactGraphContext,
): readonly string[] => {
  let selfAsyncChunks = 0;
  let hasCandidateRegistration = false;
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    const asset = context.assetNodes.get(file.path);
    if (javascript === null || asset === undefined) continue;
    const coverage = javascriptAnalysisCoverage(javascript);
    const records: BundlerGraphRecord[] = [];
    for (const registration of javascript.bundler_registrations) {
      if (isCandidateBundlerRegistration(registration))
        hasCandidateRegistration = true;
      const input = {
        file,
        registration,
        coverage,
        limitations: javascript.limitations,
      };
      const chunk = createBundlerChunkNode(context, input);
      if (isCandidateBundlerRegistration(registration))
        addCandidateContainsEdge(
          context,
          asset,
          chunk,
          input,
          registration.location,
          {
            bundler: registration.bundler,
          },
        );
      else
        addAstContainsEdge(context, {
          source: asset,
          target: chunk,
          file,
          range: registration.location,
          coverage,
          properties: { bundler: registration.bundler },
        });
      for (const key of registration.chunk_keys)
        context.chunkNodes.set(
          chunkLookupKey(file.path, registration.runtime, key),
          chunk,
        );
      records.push({ file, registration, chunk, coverage });
      addBundlerModuleNodes(context, { ...input, chunk });
    }
    for (const record of records)
      selfAsyncChunks += addBundlerRuntimeEdges(context, record);
  }
  return [
    ...(hasCandidateRegistration ? [ESBUILD_HELPER_LIMITATION] : []),
    ...selfReferenceOmissions(
      selfAsyncChunks,
      ["bundler async-chunk reference", "bundler async-chunk references"],
      "the requesting chunk",
    ),
  ];
};

interface BundlerProjectionInput {
  readonly file: JavaScriptArtifactFile;
  readonly registration: JavaScriptBundlerRegistration;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly limitations: readonly string[];
}

interface BundlerModuleProjectionInput extends BundlerProjectionInput {
  readonly chunk: ApplicationNode;
}

const addCandidateContainsEdge = (
  context: JavaScriptArtifactGraphContext,
  source: ApplicationNode,
  target: ApplicationNode,
  input: BundlerProjectionInput,
  range: JavaScriptBundlerRegistration["location"],
  properties: Readonly<Record<string, unknown>>,
): void => {
  context.accumulator.addEdge({
    source_node_id: source.node_id,
    target_node_id: target.node_id,
    relation: "contains",
    properties: { ...properties, ...candidateProperties(input.registration) },
    evidence: staticInferenceEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range,
      operation: "map-bundler-candidate-structure",
      coverage: input.coverage,
      confidence: "low",
      limitations: candidateLimitations(input.registration),
    }),
  });
};

const createBundlerChunkNode = (
  context: JavaScriptArtifactGraphContext,
  input: BundlerProjectionInput,
): ApplicationNode => {
  const { file, registration, coverage, limitations } = input;
  const chunkKey = `${registration.runtime}:${registration.chunk_keys.join(",")}`;
  return context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(
      file.sha256,
      "bundler-chunk",
      compositeKey([registration.runtime, registration.chunk_keys]),
    ),
    observations: [
      {
        label: chunkKey,
        properties: {
          path: file.path,
          bundler: registration.bundler,
          runtime: registration.runtime,
          ...candidateProperties(registration),
          chunk_keys: registration.chunk_keys,
          unknown_chunk_keys: registration.unknown_chunk_keys,
          runtime_require_name: registration.runtime_require_name,
          runtime_module_cache_status: registration.runtime_module_cache_status,
          entry_module_keys: registration.entry_module_keys,
          unknown_entry_module_keys: registration.unknown_entry_module_keys,
          async_chunk_keys: registration.async_chunk_keys,
          unknown_async_chunk_keys: registration.unknown_async_chunk_keys,
          module_count: registration.modules.length,
        },
        evidence: (isCandidateBundlerRegistration(registration)
          ? staticInferenceEvidence
          : astObservationEvidence)({
          sha256: file.sha256,
          path: file.path,
          range: registration.location,
          operation: "extract-bundler-registration",
          coverage,
          limitations: [...limitations, ...candidateLimitations(registration)],
          ...(isCandidateBundlerRegistration(registration)
            ? { confidence: "low" as const }
            : {}),
        }),
      },
    ],
  });
};

const addBundlerModuleNodes = (
  context: JavaScriptArtifactGraphContext,
  input: BundlerModuleProjectionInput,
): void => {
  const { file, registration, chunk, coverage, limitations } = input;
  for (const moduleValue of registration.modules) {
    const module = context.accumulator.addNode({
      kind: "javascript-module",
      identity: artifactLocalIdentity(
        file.sha256,
        `${registration.runtime}:module`,
        moduleValue.module_key,
      ),
      observations: [
        {
          label: moduleValue.module_key,
          properties: {
            path: file.path,
            bundler: registration.bundler,
            runtime: registration.runtime,
            ...candidateProperties(registration),
            chunk_keys: registration.chunk_keys,
            module_key: moduleValue.module_key,
            factory_require_name: moduleValue.factory_require_name,
            runtime_entry: registration.entry_module_keys.includes(
              moduleValue.module_key,
            ),
            source_sha256: moduleValue.source_sha256,
            structural_fingerprint_sha256:
              moduleValue.structural_fingerprint_sha256,
            structural_fingerprint_algorithm:
              moduleValue.structural_fingerprint_algorithm,
            exports: moduleValue.exports,
          },
          evidence: (isCandidateBundlerRegistration(registration)
            ? staticInferenceEvidence
            : astObservationEvidence)({
            sha256: file.sha256,
            path: file.path,
            range: moduleValue.location,
            operation: "extract-bundler-module",
            coverage,
            limitations: [
              ...limitations,
              ...candidateLimitations(registration),
            ],
            ...(isCandidateBundlerRegistration(registration)
              ? { confidence: "low" as const }
              : {}),
          }),
        },
      ],
    });
    context.moduleNodes.set(
      moduleLookupKey(file.path, registration.runtime, moduleValue.module_key),
      module,
    );
    if (isCandidateBundlerRegistration(registration))
      addCandidateContainsEdge(
        context,
        chunk,
        module,
        input,
        moduleValue.location,
        {
          bundler: registration.bundler,
          runtime: registration.runtime,
          chunk_keys: registration.chunk_keys,
          module_key: moduleValue.module_key,
        },
      );
    else
      addAstContainsEdge(context, {
        source: chunk,
        target: module,
        file,
        range: moduleValue.location,
        coverage,
        properties: {
          bundler: registration.bundler,
          runtime: registration.runtime,
          chunk_keys: registration.chunk_keys,
          module_key: moduleValue.module_key,
        },
      });
  }
};

interface BundlerGraphRecord {
  readonly file: JavaScriptArtifactFile;
  readonly registration: JavaScriptBundlerRegistration;
  readonly chunk: ApplicationNode;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

const addBundlerRuntimeEdges = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
): number => {
  let selfAsyncChunks = 0;
  const { file, registration, chunk, coverage } = record;
  for (const moduleKey of registration.entry_module_keys) {
    const resolved = context.moduleNodes.get(
      moduleLookupKey(file.path, registration.runtime, moduleKey),
    );
    const target =
      resolved ?? unresolvedBundlerModuleNode(context, record, moduleKey);
    context.accumulator.addEdge({
      source_node_id: chunk.node_id,
      target_node_id: target.node_id,
      relation: "loads",
      properties: {
        kind: "bundler-entry-module",
        bundler: registration.bundler,
        runtime: registration.runtime,
        module_key: moduleKey,
        resolution_status: resolved === undefined ? "not-found" : "resolved",
        ...candidateProperties(registration),
      },
      evidence: staticInferenceEvidence({
        sha256: file.sha256,
        path: file.path,
        range: registration.location,
        operation: "resolve-bundler-entry-module",
        coverage,
        confidence:
          isCandidateBundlerRegistration(registration) || resolved === undefined
            ? "low"
            : "high",
        limitations: candidateLimitations(registration),
      }),
    });
  }
  for (const chunkKey of registration.async_chunk_keys) {
    const lookup = chunkLookupKey(file.path, registration.runtime, chunkKey);
    const resolved = context.chunkNodes.get(lookup);
    if (resolved?.node_id === chunk.node_id) {
      selfAsyncChunks++;
      continue;
    }
    const target =
      resolved ?? unresolvedBundlerChunkNode(context, record, chunkKey);
    context.accumulator.addEdge({
      source_node_id: chunk.node_id,
      target_node_id: target.node_id,
      relation: "imports",
      properties: {
        kind: "bundler-async-chunk",
        bundler: registration.bundler,
        runtime: registration.runtime,
        chunk_key: chunkKey,
        resolution_status: resolved === undefined ? "not-found" : "resolved",
        ...candidateProperties(registration),
      },
      evidence: staticInferenceEvidence({
        sha256: file.sha256,
        path: file.path,
        range: registration.location,
        operation: "resolve-bundler-async-chunk",
        coverage,
        confidence:
          isCandidateBundlerRegistration(registration) || resolved === undefined
            ? "low"
            : "high",
        limitations: candidateLimitations(registration),
      }),
    });
  }
  return selfAsyncChunks;
};

const unresolvedBundlerModuleNode = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
  moduleKey: string,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      record.file.sha256,
      `${record.registration.runtime}:unresolved-entry-module`,
      moduleKey,
    ),
    observations: [
      {
        label: moduleKey,
        properties: {
          semantic_role: "bundler-module-reference",
          bundler: record.registration.bundler,
          runtime: record.registration.runtime,
          module_key: moduleKey,
          resolution_status: "not-found",
          ...candidateProperties(record.registration),
        },
        evidence: staticInferenceEvidence({
          sha256: record.file.sha256,
          path: record.file.path,
          range: record.registration.location,
          operation: "retain-unresolved-bundler-entry-module",
          coverage: record.coverage,
          confidence: "low",
          limitations: candidateLimitations(record.registration),
        }),
      },
    ],
  });

const unresolvedBundlerChunkNode = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
  chunkKey: string,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(
      record.file.sha256,
      `${record.registration.runtime}:unresolved-async-chunk`,
      chunkKey,
    ),
    observations: [
      {
        label: chunkKey,
        properties: {
          semantic_role: "bundler-chunk-reference",
          bundler: record.registration.bundler,
          runtime: record.registration.runtime,
          chunk_key: chunkKey,
          resolution_status: "not-found",
          ...candidateProperties(record.registration),
        },
        evidence: staticInferenceEvidence({
          sha256: record.file.sha256,
          path: record.file.path,
          range: record.registration.location,
          operation: "retain-unresolved-bundler-async-chunk",
          coverage: record.coverage,
          confidence: "low",
          limitations: candidateLimitations(record.registration),
        }),
      },
    ],
  });
