import { canonicalJson } from "./comparisonSemantics.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import type { FunctionComparisonResult } from "./functionComparisonSchemas.js";

export const identityProjection = (snapshot: FunctionSnapshot) => ({
  name: snapshot.dossier.procedure.name,
  signature: snapshot.dossier.procedure.signature,
  locals: snapshot.dossier.procedure.locals
    .map(({ description }) => description)
    .sort(),
});

export const functionMatch = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): FunctionComparisonResult["function_match"] => {
  const leftName = left.dossier.procedure.name;
  const rightName = right.dossier.procedure.name;
  const stableNames = !isAutoName(leftName) && !isAutoName(rightName);
  if (stableNames && leftName === rightName)
    return {
      status: "matched",
      method: "symbol",
      left_name: leftName,
      right_name: rightName,
    };
  return {
    status: stableNames ? "mismatched" : "ambiguous",
    method: "explicit",
    left_name: leftName,
    right_name: rightName,
  };
};

export const normalizeCfg = (
  blocks: FunctionSnapshot["dossier"]["basic_blocks"],
): readonly unknown[] | null => {
  const parsed: {
    block: (typeof blocks)[number];
    start: bigint;
    end: bigint;
  }[] = [];
  for (const block of blocks) {
    const start = parseAddress(block.start);
    const end = parseAddress(block.end);
    if (start === null || end === null || end <= start) return null;
    parsed.push({ block, start, end });
  }
  const ordered = parsed.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );
  if (new Set(ordered.map(({ start }) => start)).size !== ordered.length)
    return null;
  const indices = new Map(ordered.map(({ start }, index) => [start, index]));
  const graph = [];
  for (const { block, start, end } of ordered) {
    const successors: number[] = [];
    for (const address of block.successors) {
      const parsedAddress = parseAddress(address);
      if (parsedAddress === null) return null;
      const index = indices.get(parsedAddress);
      if (index === undefined) return null;
      successors.push(index);
    }
    graph.push({
      size: String(end - start),
      successors: successors.sort((left, right) => left - right),
    });
  }
  return graph;
};

type ReferenceEdge = FunctionSnapshot["dossier"]["outgoing_references"][number];

/**
 * A named endpoint survives relocation. An unnamed endpoint is identified
 * only by its address, which names one location only within one artifact;
 * across artifacts it stays unknown (null).
 */
const referenceEndpoint = (
  procedure: ReferenceEdge["source_procedure"],
  address: string,
  sameArtifact: boolean,
): string | { readonly address: string } | null =>
  procedure !== null ? procedure.name : sameArtifact ? { address } : null;

export const referenceProjection = (
  snapshot: FunctionSnapshot,
  sameArtifact: boolean,
) =>
  sorted(
    [
      ...snapshot.dossier.incoming_references.map((item) => ({
        direction: "in",
        item,
      })),
      ...snapshot.dossier.outgoing_references.map((item) => ({
        direction: "out",
        item,
      })),
    ].map(({ direction, item }) => ({
      direction,
      source: referenceEndpoint(
        item.source_procedure,
        item.source_address,
        sameArtifact,
      ),
      target: referenceEndpoint(
        item.target_procedure,
        item.target_address,
        sameArtifact,
      ),
    })),
  );

export const referenceKindProjection = (
  snapshot: FunctionSnapshot,
  sameArtifact: boolean,
): readonly unknown[] | null => {
  const edges = [
    ...snapshot.dossier.incoming_references.map((edge) => ({
      direction: "in",
      edge,
    })),
    ...snapshot.dossier.outgoing_references.map((edge) => ({
      direction: "out",
      edge,
    })),
  ];
  if (edges.some(({ edge }) => !edge.kind.available)) return null;
  return sorted(
    edges.map(({ direction, edge }) => {
      if (!edge.kind.available)
        throw new TypeError(
          "Reference-kind availability changed during projection",
        );
      return {
        direction,
        source: referenceEndpoint(
          edge.source_procedure,
          edge.source_address,
          sameArtifact,
        ),
        target: referenceEndpoint(
          edge.target_procedure,
          edge.target_address,
          sameArtifact,
        ),
        type: edge.kind.type,
        flow: edge.kind.flow,
        call: edge.kind.call,
        jump: edge.kind.jump,
        data: edge.kind.data,
        read: edge.kind.read,
        write: edge.kind.write,
        indirect: edge.kind.indirect,
        computed: edge.kind.computed,
        conditional: edge.kind.conditional,
        terminal: edge.kind.terminal,
        primary: edge.kind.primary,
        operand_index: edge.kind.operand_index,
        external: edge.kind.external,
      };
    }),
  );
};

interface ComparableReferenceEdge {
  readonly direction: "in" | "out";
  readonly sourceName: string | null;
  readonly sourceAddress: string | null;
  readonly targetName: string | null;
  readonly targetAddress: string | null;
  readonly kindKey: string | null;
}

const comparableReferenceEdges = (
  snapshot: FunctionSnapshot,
  sameArtifact: boolean,
  includeKinds: boolean,
): readonly ComparableReferenceEdge[] =>
  [
    ...snapshot.dossier.incoming_references.map((edge) => ({
      direction: "in" as const,
      edge,
    })),
    ...snapshot.dossier.outgoing_references.map((edge) => ({
      direction: "out" as const,
      edge,
    })),
  ].map(({ direction, edge }) => ({
    direction,
    sourceName: edge.source_procedure?.name ?? null,
    sourceAddress: sameArtifact ? edge.source_address : null,
    targetName: edge.target_procedure?.name ?? null,
    targetAddress: sameArtifact ? edge.target_address : null,
    kindKey:
      includeKinds && edge.kind.available
        ? canonicalJson(
            {
              type: edge.kind.type,
              flow: edge.kind.flow,
              call: edge.kind.call,
              jump: edge.kind.jump,
              data: edge.kind.data,
              read: edge.kind.read,
              write: edge.kind.write,
              indirect: edge.kind.indirect,
              computed: edge.kind.computed,
              conditional: edge.kind.conditional,
              terminal: edge.kind.terminal,
              primary: edge.kind.primary,
              operand_index: edge.kind.operand_index,
              external: edge.kind.external,
            },
            "Function comparison",
          )
        : null,
  }));

const endpointsCompatible = (
  leftName: string | null,
  leftAddress: string | null,
  rightName: string | null,
  rightAddress: string | null,
  sameArtifact: boolean,
): boolean => {
  if (leftName !== null && rightName !== null) return leftName === rightName;
  return sameArtifact ? leftAddress === rightAddress : true;
};

const edgePairCompatible = (
  left: ComparableReferenceEdge,
  right: ComparableReferenceEdge,
  sameArtifact: boolean,
): boolean =>
  left.direction === right.direction &&
  left.kindKey === right.kindKey &&
  endpointsCompatible(
    left.sourceName,
    left.sourceAddress,
    right.sourceName,
    right.sourceAddress,
    sameArtifact,
  ) &&
  endpointsCompatible(
    left.targetName,
    left.targetAddress,
    right.targetName,
    right.targetAddress,
    sameArtifact,
  );

/**
 * Determine whether two reference inventories can correspond 1-to-1 without
 * contradicting known procedure names, same-artifact addresses, or (when
 * requested) known reference kinds.
 */
export const referenceEdgesCompatible = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  sameArtifact: boolean,
  includeKinds: boolean,
): boolean => {
  const leftEdges = comparableReferenceEdges(left, sameArtifact, includeKinds);
  const rightEdges = comparableReferenceEdges(
    right,
    sameArtifact,
    includeKinds,
  );
  if (leftEdges.length !== rightEdges.length) return false;
  const rightCounts = new Map<string, number[]>();
  rightEdges.forEach((edge, index) => {
    const key = canonicalJson(edge, "Function comparison");
    const bucket = rightCounts.get(key) ?? [];
    bucket.push(index);
    rightCounts.set(key, bucket);
  });
  const unmatchedLeft: ComparableReferenceEdge[] = [];
  const matchedRightIndices = new Set<number>();
  for (const edge of leftEdges) {
    const key = canonicalJson(edge, "Function comparison");
    const bucket = rightCounts.get(key);
    const matchedIndex = bucket?.pop();
    if (matchedIndex !== undefined) matchedRightIndices.add(matchedIndex);
    else unmatchedLeft.push(edge);
  }
  const unmatchedRight = rightEdges.filter(
    (_, index) => !matchedRightIndices.has(index),
  );
  const assignedLeftByRight = new Array<number>(unmatchedRight.length).fill(-1);
  const tryMatch = (leftIndex: number, visitedRight: Set<number>): boolean => {
    const leftEdge = unmatchedLeft[leftIndex];
    if (leftEdge === undefined) return false;
    for (let rightIndex = 0; rightIndex < unmatchedRight.length; rightIndex++) {
      if (visitedRight.has(rightIndex)) continue;
      const rightEdge = unmatchedRight[rightIndex];
      if (
        rightEdge === undefined ||
        !edgePairCompatible(leftEdge, rightEdge, sameArtifact)
      )
        continue;
      visitedRight.add(rightIndex);
      const currentLeft = assignedLeftByRight[rightIndex] ?? -1;
      if (currentLeft === -1 || tryMatch(currentLeft, visitedRight)) {
        assignedLeftByRight[rightIndex] = leftIndex;
        return true;
      }
    }
    return false;
  };
  for (let leftIndex = 0; leftIndex < unmatchedLeft.length; leftIndex++) {
    if (!tryMatch(leftIndex, new Set())) return false;
  }
  return true;
};

export const commentProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const values = snapshot.dossier.comments.map(({ address, kind, text }) => ({
    offset: relativeAddress(address, snapshot.dossier.procedure.address),
    kind,
    text,
  }));
  return values.some(({ offset }) => offset === null) ? null : sorted(values);
};

export const stringAndNameProjection = (
  snapshot: FunctionSnapshot,
  includeSwiftLiterals = true,
): readonly unknown[] | null => {
  const values = [
    ...snapshot.dossier.referenced_strings.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "string",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.dossier.procedure.address,
        ),
        value,
      }),
    ),
    ...snapshot.dossier.referenced_names.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "name",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.dossier.procedure.address,
        ),
        value,
      }),
    ),
    ...(includeSwiftLiterals
      ? (snapshot.dossier.swift_string_literals ?? [])
      : []
    ).map(
      ({
        source_address: sourceAddress,
        value,
        representation,
        registers,
      }) => ({
        kind: "swift_string",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.dossier.procedure.address,
        ),
        value,
        representation,
        registers,
      }),
    ),
  ];
  return values.some(({ source_offset: offset }) => offset === null)
    ? null
    : sorted(values);
};

/**
 * A retained literal proves presence, not that every path through its site was examined.
 * A differing retained fact proves a change only when the opposite dossier is complete
 * and therefore establishes its absence.
 */
export const swiftLiteralSitesConflict = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): boolean => {
  const leftSites = swiftLiteralSites(left);
  const rightSites = swiftLiteralSites(right);
  for (const site of new Set([
    ...leftSites.values.keys(),
    ...rightSites.values.keys(),
  ])) {
    const leftValues =
      leftSites.values.get(site) ?? (leftSites.complete ? [] : undefined);
    const rightValues =
      rightSites.values.get(site) ?? (rightSites.complete ? [] : undefined);
    if (leftValues === undefined || rightValues === undefined) continue;
    const leftFacts = new Set(leftValues);
    const rightFacts = new Set(rightValues);
    if (
      (rightSites.complete &&
        leftValues.some((value) => !rightFacts.has(value))) ||
      (leftSites.complete && rightValues.some((value) => !leftFacts.has(value)))
    )
      return true;
  }
  return false;
};

const swiftLiteralSites = (snapshot: FunctionSnapshot) => {
  const base = snapshot.dossier.procedure.address;
  const omissions = snapshot.dossier.swift_string_literal_omissions ?? [];
  const site = (sourceAddress: string, registers: readonly string[]) => {
    const offset = relativeAddress(sourceAddress, base);
    return offset === null ? null : canonicalJson([offset, registers]);
  };
  // Keep the same literal facts the full strings_names projection compares.
  const values = new Map<string, string[]>();
  for (const literal of snapshot.dossier.swift_string_literals ?? []) {
    const key = site(literal.source_address, literal.registers);
    if (key === null) continue;
    values.set(
      key,
      [
        ...(values.get(key) ?? []),
        canonicalJson([literal.value, literal.representation]),
      ].sort(compareUnicodeCodePoints),
    );
  }
  const complete =
    snapshot.dossier.swift_string_literals !== undefined &&
    omissions.length === 0;
  return { values, complete };
};

export const sorted = (values: readonly unknown[]): readonly unknown[] =>
  values
    .map((value) => ({
      value,
      json: canonicalJson(value, "Function normalization"),
    }))
    .sort((left, right) => compareUnicodeCodePoints(left.json, right.json))
    .map(({ value }) => value);

/** Recognize address-derived procedure names without excluding named FUN_ symbols. */
export const isAutoName = (name: string): boolean =>
  /^(?:sub_[0-9a-f]+|fcn\.[0-9a-f]+|FUN_[0-9a-f]+)$/iu.test(name);

const parseAddress = (value: string): bigint | null =>
  /^0x[0-9a-f]+$/iu.test(value) ? BigInt(value) : null;

const relativeAddress = (value: string, base: string): string | null => {
  const parsed = parseAddress(value);
  const parsedBase = parseAddress(base);
  return parsed === null || parsedBase === null || parsed < parsedBase
    ? null
    : String(parsed - parsedBase);
};
