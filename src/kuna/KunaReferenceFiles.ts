import { createHash } from "node:crypto";

import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareKunaAddresses } from "./KunaAddress.js";
import { parseKunaJson } from "./KunaJson.js";
import { KunaJsonDocumentReader, parseKunaRow } from "./KunaJsonStream.js";

/** The raw xref budget also bounds its materialized rows. */
export const KUNA_XREF_OUTPUT_BYTES = 16 * 1024 * 1024;

const addressKeys = new Set(["address", "from_address", "to_address"]);
const address = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const kind = z.enum(["call", "jump", "data", "read", "write"]);

const graphHeader = z.object({
  schemaVersion: z.literal(4),
  binary: z.object({
    sourcePath: z.string(),
    functionCount: count,
    edgeCount: count,
  }),
});
const graphNode = z.object({
  address,
  name: z.string().min(1),
  kind: z.string().min(1),
  hasIndirectCalls: z.boolean(),
  forwardsTo: address.nullable(),
  codeC: z.null(),
  assembly: z.null(),
  error: z.null(),
});
const graphEdge = z.object({
  callerAddress: address,
  calleeAddress: address,
  kind,
  calleeOrder: count,
});

export type KunaGraphNode = z.infer<typeof graphNode>;
export interface KunaCallGraph {
  readonly sha256: string;
  readonly bytes: number;
  readonly edgeCount: number;
  readonly hasIndirectCalls: boolean;
  readonly nodes: ReadonlyMap<string, KunaGraphNode>;
  readonly callers: ReadonlyMap<string, readonly string[]>;
  readonly callees: ReadonlyMap<string, readonly string[]>;
}

const fieldsOf = (schema: z.ZodObject, excluded: readonly string[]) =>
  new Set(Object.keys(schema.shape).filter((key) => !excluded.includes(key)));

const GRAPH_DOCUMENT = {
  header: new Set(["schemaVersion"]),
  sections: new Map([
    ["binary", new Set(Object.keys(graphHeader.shape.binary.shape))],
  ]),
  rows: new Map([
    [
      "functions",
      {
        fields: fieldsOf(graphNode, [
          "address",
          "forwardsTo",
          "codeC",
          "assembly",
          "error",
        ]),
        addresses: new Set(["address", "forwardsTo"]),
        empty: new Set<string>(),
        // `--functions ''` requests no bodies; one is refused unassembled.
        nulls: new Set(["codeC", "assembly", "error"]),
      },
    ],
    [
      "edges",
      {
        fields: fieldsOf(graphEdge, ["callerAddress", "calleeAddress"]),
        addresses: new Set(["callerAddress", "calleeAddress"]),
        empty: new Set<string>(),
        nulls: new Set<string>(),
      },
    ],
  ]),
};

/**
 * Validates `kuna decompile-graph --functions ''` as Kuna writes it and
 * retains only the facts call queries use.
 */
export class KunaCallGraphReader extends KunaJsonDocumentReader<KunaCallGraph> {
  readonly #nodes = new Map<string, KunaGraphNode>();
  #edges: z.infer<typeof graphEdge>[] = [];
  #hasIndirectCalls = false;

  constructor() {
    super("kuna:call-graph", "Kuna's call graph", GRAPH_DOCUMENT);
  }

  override finish(input: string): Result<KunaCallGraph, AnalysisError> {
    const completed = this.complete();
    if (!completed.ok) return completed;
    const header = graphHeader.safeParse(completed.value.header);
    if (!header.success)
      return err(this.unusable("the graph header is not Kuna's schema 4"));
    if (header.data.binary.sourcePath !== input)
      return err(this.unusable("graph names a different input"));
    if (
      header.data.binary.functionCount !== this.#nodes.size ||
      header.data.binary.edgeCount !== this.#edges.length
    )
      return err(this.unusable("graph counts disagree with examined rows"));
    const edges = this.#edges;
    this.#edges = [];
    try {
      const { callers, callees } = this.#index(edges);
      return ok({
        nodes: this.#nodes,
        callers,
        callees,
        edgeCount: edges.length,
        hasIndirectCalls: this.#hasIndirectCalls,
        bytes: completed.value.bytes,
        sha256: completed.value.sha256,
      });
    } catch (cause: unknown) {
      return err(
        this.unusable(cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  protected override acceptRow(
    member: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    if (member === "edges") {
      // Endpoints are checked once every node is known.
      this.#edges.push(parseKunaRow(graphEdge, "graph edge", fields));
      return;
    }
    const node = parseKunaRow(graphNode, "graph function", fields);
    if (this.#nodes.has(node.address))
      throw new Error("graph repeats a function address");
    this.#nodes.set(node.address, node);
    this.#hasIndirectCalls ||= node.hasIndirectCalls;
  }

  protected override discardRows(): void {
    this.#nodes.clear();
    this.#edges = [];
  }

  /** Check every edge against the nodes and index the call edges. */
  #index(edges: readonly z.infer<typeof graphEdge>[]) {
    const nodes = this.#nodes;
    const callers = new Map<string, string[]>();
    const callees = new Map<string, string[]>();
    const pairs = new Set<string>();
    const orders = new Map<string, Set<number>>();
    for (const edge of edges) {
      if (!nodes.has(edge.callerAddress) || !nodes.has(edge.calleeAddress))
        throw new Error("graph edge has an unknown endpoint");
      const pair = `${edge.callerAddress}:${edge.calleeAddress}`;
      if (pairs.has(pair)) throw new Error("graph repeats an edge");
      pairs.add(pair);
      const order = orders.get(edge.callerAddress) ?? new Set<number>();
      if (order.has(edge.calleeOrder))
        throw new Error("graph repeats a callee order");
      order.add(edge.calleeOrder);
      orders.set(edge.callerAddress, order);
      if (edge.kind !== "call") continue;
      const incoming = callers.get(edge.calleeAddress) ?? [];
      incoming.push(edge.callerAddress);
      callers.set(edge.calleeAddress, incoming);
      const outgoing = callees.get(edge.callerAddress) ?? [];
      outgoing.push(edge.calleeAddress);
      callees.set(edge.callerAddress, outgoing);
    }
    for (const order of orders.values())
      for (let index = 0; index < order.size; index += 1)
        if (!order.has(index))
          throw new Error("graph callee orders are incomplete");
    for (const list of [...callers.values(), ...callees.values()])
      list.sort(compareKunaAddresses);
    return { callers, callees };
  }
}

const xrefFunction = z.object({
  name: z.string().min(1),
  address,
  address_hex: address,
});
const xrefRow = z.object({
  address,
  address_hex: address,
  kind,
  from_address: address,
  from_address_hex: address,
  to_address: address,
  to_address_hex: address,
  from_function: xrefFunction.nullable(),
  to_function: xrefFunction.nullable(),
  instruction: z.string(),
});
const xrefsDocument = z.object({
  binary: z.string(),
  direction: z.literal("to"),
  count,
  target: z.object({
    address,
    address_hex: address,
    name: z.string().nullable(),
    aliases: z.array(xrefFunction),
  }),
  xrefs: z.array(z.unknown()),
});

export interface KunaIncomingReferences {
  readonly addresses: readonly string[];
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly excludedAliasRows: number;
}

/** Native --to unifies forwarding aliases; REA xrefs asks for the exact address. */
export const parseKunaIncomingReferences = (
  text: string,
  input: string,
  target: string,
): Result<KunaIncomingReferences, string> => {
  try {
    const document = xrefsDocument.parse(
      parseKunaJson(text, KUNA_XREF_OUTPUT_BYTES, addressKeys),
    );
    if (
      document.binary !== input ||
      document.target.address !== target ||
      document.target.address_hex !== target
    )
      throw new Error("xref document names a different input or target");
    if (document.count !== document.xrefs.length)
      throw new Error("xref count disagrees with examined rows");
    const aliases = new Set([target]);
    for (const alias of document.target.aliases) {
      if (alias.address !== alias.address_hex)
        throw new Error("xref alias address disagrees with its hex field");
      aliases.add(alias.address);
    }
    const addresses = new Set<string>();
    let excludedAliasRows = 0;
    for (const raw of document.xrefs) {
      const row = xrefRow.parse(raw);
      if (
        row.address !== row.address_hex ||
        row.address !== row.from_address ||
        row.from_address !== row.from_address_hex ||
        row.to_address !== row.to_address_hex
      )
        throw new Error(
          "xref endpoints disagree with numeric or directional fields",
        );
      for (const fn of [row.from_function, row.to_function])
        if (fn !== null && fn.address !== fn.address_hex)
          throw new Error("xref function address disagrees with its hex field");
      if (!aliases.has(row.to_address))
        throw new Error(
          "xref row targets neither the requested address nor an advertised alias",
        );
      if (row.to_address === target) addresses.add(row.from_address);
      else excludedAliasRows += 1;
    }
    return ok({
      addresses: [...addresses].sort(compareKunaAddresses),
      rows: document.xrefs.length,
      excludedAliasRows,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  } catch (cause: unknown) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
};
