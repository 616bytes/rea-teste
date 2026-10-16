import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "parameter-property declarations do not become resolved influence paths through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-parameter-properties-");
    const application = join(root, "application's 参数");
    await mkdir(application);
    const source = [
      'throw new Error("Static analysis must not execute this fixture");',
      "const seed = 7;",
      "class Empty { constructor(public x: number) {} }",
      "class Defaults { constructor(public value = seed) {} }",
      "class Used { constructor(readonly x: number) { console.log(x); } }",
      "class Plain { constructor(x: number) {} }",
    ].join("\n");
    const sourcePath = join(application, "sample.ts");
    await writeFile(sourcePath, source);
    const analyzed = await cli.run({
      arguments: [
        "analyze-javascript-application",
        application,
        "--artifact-format",
        "directory",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(analyzed.exitCode, analyzed.stderr).toBe(0);
    const evidence = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(analyzed.json);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.statistics).toMatchObject({
      parsed_javascript_files: 1,
      parse_failures: 0,
    });
    const graph = result.semantic_graph;
    const parameter = (line: number) => {
      const node = graph.nodes.find(
        (candidate) =>
          candidate.kind === "parameter" &&
          candidate.identity.source_range?.start.line === line,
      );
      if (node === undefined)
        throw new Error(`Missing parameter on line ${line}`);
      return node;
    };
    const readsFrom = (nodeId: string) =>
      graph.relations.filter(
        (relation) =>
          relation.relation === "reads" && relation.source_node_id === nodeId,
      );
    expect(
      [3, 4, 5, 6].map((line) => readsFrom(parameter(line).node_id).length),
    ).toEqual([0, 0, 1, 0]);
    const seed = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "seed",
    );
    if (seed === undefined) throw new Error("Missing initializer seed binding");
    expect(readsFrom(seed.node_id)).toHaveLength(1);
    expect(readsFrom(seed.node_id)[0]).toMatchObject({
      resolution: "resolved",
    });

    const { client, call } = await connectLocalToolsMcp();
    const response = await call("analyze_javascript_application", {
      input_path: application,
      format: "directory",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const retained = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(response.structuredContent);
    expect(retained.evidence_id).toBe(evidence.evidence_id);

    const failed = await call("analyze_javascript_application", {
      input_path: join(root, "missing"),
      format: "directory",
    });
    expect(failed.isError).toBe(true);
    expect(parseMcpToolError(failed).error.code).toBe("invalid_request");
    await client.ping();

    for (const [nodeId, readCount] of [
      [parameter(3).node_id, 0],
      [parameter(5).node_id, 1],
      [seed.node_id, 1],
    ] as const) {
      const query = {
        seed: { kind: "semantic-node", node_id: nodeId },
        direction: "forward-influence",
        allowed_relations: ["reads"],
      };
      const traced = await call("trace_javascript_semantics", {
        application: {
          kind: "retained-evidence",
          evidence_id: retained.evidence_id,
        },
        query,
      });
      expect(traced.isError, JSON.stringify(traced)).not.toBe(true);
      const traceEvidence = toolContract(
        "trace_javascript_semantics",
      ).outputSchema.parse(traced.structuredContent);
      const trace = javaScriptSemanticTraceResultSchema.parse(
        traceEvidence.normalized_result,
      );
      expect(trace.seed_node_ids).toEqual([nodeId]);
      expect(
        trace.relations.filter(({ relation }) => relation === "reads"),
      ).toHaveLength(readCount);
      expect(trace.evidence_links).toEqual([evidence.evidence_id]);
      await client.ping();
      if (readCount === 0) {
        const requestPath = join(root, "trace-request.json");
        await writeFile(
          requestPath,
          JSON.stringify({ application: evidence, query }),
        );
        const cliTrace = await cli.run({
          arguments: ["trace-javascript-semantics", requestPath, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(cliTrace.exitCode, cliTrace.stderr).toBe(0);
        const cliEvidence = toolContract(
          "trace_javascript_semantics",
        ).outputSchema.parse(cliTrace.json);
        expect(cliEvidence.normalized_result).toEqual(
          traceEvidence.normalized_result,
        );
      }
    }
    const session = await call("binary_session", {});
    expect(session.isError, JSON.stringify(session)).not.toBe(true);
    expect(session.structuredContent).toMatchObject({
      result: { open: false },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  },
  30_000,
);
