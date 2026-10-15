import { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactNode,
} from "./artifactGraph.js";
import type { InventorySet } from "./artifactInventoryEvidence.js";

/** Total retained graph nodes examined before the member index is withheld. */
export const MAX_EXAMINED_NODES = 250_000;
/**
 * Default serialized JSON budget for the member index, in bytes. The index is
 * reported complete or withheld, so this bounds the whole array rather than a
 * single row; a caller with its own transport budget passes the smaller value.
 */
export const DEFAULT_MEMBER_INDEX_JSON_BYTES = 4 * 1024 * 1024;

/**
 * One member's observation of an indexed graph member. A label is caller text
 * and repeated labels are permitted, so the member's own Evidence id travels
 * with every observation: it keeps the count per member and keeps source
 * identity available in a result that no longer carries family rows.
 */
export const memberObservationSchema = z.strictObject({
  label: z.string(),
  evidence_id: z.string(),
});

export const memberIndexRowSchema = z.strictObject({
  artifact_id: z.string(),
  sha256: z.string(),
  /** Distinct producer formats the members reported for one artifact id. */
  formats: z.array(z.string()),
  observations: z.array(memberObservationSchema),
  member_count: z.number().int().positive(),
});

export type MemberObservation = z.infer<typeof memberObservationSchema>;
export type MemberIndexRow = z.infer<typeof memberIndexRowSchema>;

/** The member facts the index reads: one inventory, labelled by its caller. */
export interface MemberIndexMember {
  readonly label: string;
  readonly evidenceId: string;
  readonly inventory: InventorySet;
}

export interface MemberIndex {
  readonly shared: MemberIndexRow[];
  readonly partiallyShared: MemberIndexRow[];
  readonly unique: MemberIndexRow[];
  readonly nodesExamined: number;
  readonly nodesWithoutByteIdentity: number;
  readonly withheld: boolean;
  readonly withheldBy: "node-count" | "serialized-size" | null;
}

/**
 * Partition every examined member exactly once: shared, partially shared, or
 * unique. Nothing is dropped for falling under the shared threshold, and the
 * rows are reported complete or withheld together.
 */
export const buildMemberIndex = (input: {
  readonly complete: readonly MemberIndexMember[];
  readonly minimum: number;
  readonly scope: ArtifactInventoryCoverage["scope"] | null;
  readonly budgetBytes: number;
}): MemberIndex => {
  const nodesExamined = input.complete.reduce(
    (total, entry) => total + entry.inventory.nodes.length,
    0,
  );
  const nodeBudgetExhausted = nodesExamined > MAX_EXAMINED_NODES;
  const index = new Map<
    string,
    {
      readonly node: ArtifactNode;
      readonly formats: Set<string>;
      readonly observations: MemberObservation[];
    }
  >();
  let nodesWithoutByteIdentity = 0;
  if (!nodeBudgetExhausted && input.scope !== null)
    for (const entry of input.complete)
      for (const node of entry.inventory.nodes) {
        // A directory node's identity covers member names and child identities
        // rather than bytes, and unread entries are not committed, so it cannot
        // support a content-sharing claim. Count it instead of dropping it.
        if (node.format === "directory") {
          nodesWithoutByteIdentity += 1;
          continue;
        }
        const observation = {
          label: entry.label,
          evidence_id: entry.evidenceId,
        };
        const existing = index.get(node.artifact_id);
        if (existing === undefined)
          index.set(node.artifact_id, {
            node,
            formats: new Set([node.format]),
            observations: [observation],
          });
        else {
          // Identity commits only to the digest, so two members can classify one
          // artifact id differently; keep every reported format instead of
          // letting the first member's classification stand.
          existing.formats.add(node.format);
          existing.observations.push(observation);
        }
      }
  const rows: MemberIndexRow[] = [];
  // The array is the retained representation, so account its UTF-8 JSON size
  // while building it: the index is reported complete or withheld, never
  // partial because a budget ran out.
  let serializedBytes = 2;
  let sizeBudgetExhausted = false;
  buildRows: for (const entry of index.values()) {
    const row: MemberIndexRow = {
      artifact_id: entry.node.artifact_id,
      sha256: entry.node.sha256,
      formats: [...entry.formats].sort(compareUnicodeCodePoints),
      // One observation per member, so repeated labels keep distinct members.
      observations: [...entry.observations].sort(
        (left, right) =>
          compareUnicodeCodePoints(left.label, right.label) ||
          compareUnicodeCodePoints(left.evidence_id, right.evidence_id),
      ),
      member_count: entry.observations.length,
    };
    const additionalBytes =
      Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (serializedBytes + additionalBytes > input.budgetBytes) {
      sizeBudgetExhausted = true;
      break buildRows;
    }
    serializedBytes += additionalBytes;
    rows.push(row);
  }
  rows.sort(
    (left, right) =>
      right.member_count - left.member_count ||
      compareUnicodeCodePoints(left.artifact_id, right.artifact_id),
  );
  const withheldBy = nodeBudgetExhausted
    ? "node-count"
    : sizeBudgetExhausted
      ? "serialized-size"
      : null;
  const withheld = withheldBy !== null;
  return {
    nodesExamined,
    nodesWithoutByteIdentity,
    withheld,
    withheldBy,
    shared: withheld
      ? []
      : rows.filter(
          (row) => row.member_count > 1 && row.member_count >= input.minimum,
        ),
    partiallyShared: withheld
      ? []
      : rows.filter(
          (row) => row.member_count > 1 && row.member_count < input.minimum,
        ),
    unique: withheld ? [] : rows.filter((row) => row.member_count === 1),
  };
};
