import { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactNode,
} from "./artifactGraph.js";
import { evidenceSchema, type Evidence } from "./evidence.js";
import {
  declaresCompleteInventory,
  hasCompleteInventoryCoverage,
  parseArtifactInventoryEvidence,
  type InventorySet,
} from "./artifactInventoryEvidence.js";

/** Caller-selected maximum members; a real allocation bound for retained inventories. */
export const ARTIFACT_FAMILY_MEMBER_LIMIT = 64;
/** A member counts as shared only from two members upward. */
const MINIMUM_SHARED_MEMBERS = 2;
/** Total retained graph nodes examined before the member index is withheld. */
const MAX_EXAMINED_NODES = 250_000;

/**
 * The only family tier that can exist: the inventory graph digest commits to
 * the root node's own content digest, so an identical graph implies identical
 * root bytes. A re-packed container with identical members therefore has no
 * family; its relationship is reported through the shared member index.
 */
const familyTierSchema = z.literal("root-sha256");
const clusterStatusSchema = z.enum(["partitioned", "partial", "unknown"]);
const unknownReasonSchema = z.enum([
  "incomplete-inventory",
  "incomparable-coverage-scope",
  "contradictory-integrity",
]);

/** One labelled inventory observation supplied by the caller. */
export const artifactFamilyMemberSchema = z.strictObject({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Caller label for this member, reported verbatim; it is never parsed as identity.",
    ),
  evidence: evidenceSchema,
});

/** Strict input boundary for deterministic artifact family clustering. */
export const artifactFamilyClusteringInputSchema = z.strictObject({
  members: z
    .array(artifactFamilyMemberSchema)
    .min(2)
    .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
    .describe(
      "Two or more authenticated artifact inventory Evidence records, supplied inline from inspect_artifact.",
    ),
  shared_member_minimum: z
    .number()
    .int()
    .min(MINIMUM_SHARED_MEMBERS)
    .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
    .optional()
    .describe(
      "How many members a graph member must appear in to count as shared; omitted means every member.",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("First family row."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(100)
    .describe(
      "Maximum family rows returned; the member index is never paged away.",
    ),
});

export type ArtifactFamilyClusteringInput = z.infer<
  typeof artifactFamilyClusteringInputSchema
>;

const memberRowSchema = z.strictObject({
  label: z.string(),
  evidence_id: z.string(),
  root_sha256: z.string().nullable(),
  manifest_id: z.string().nullable(),
  coverage_status: z.string(),
  coverage_scope: z.string(),
});

const unknownMemberRowSchema = memberRowSchema.extend({
  reason: unknownReasonSchema,
});

const familySchema = z.strictObject({
  family_id: z.string(),
  tier: familyTierSchema.nullable(),
  basis: z.string(),
  members: z.array(memberRowSchema),
  unknown_members: z.array(unknownMemberRowSchema),
});

const memberIndexRowSchema = z.strictObject({
  artifact_id: z.string(),
  sha256: z.string(),
  format: z.string(),
  observed_in: z.array(z.string()),
  member_count: z.number().int().positive(),
});

/** Deterministic Evidence-backed partition of two or more artifact inventories. */
export const artifactFamilyClusteringResultSchema = z.strictObject({
  status: clusterStatusSchema,
  summary: z.strictObject({
    members_examined: z.number().int().positive(),
    families: z.number().int().nonnegative(),
    families_returned: z.number().int().nonnegative(),
    shared_member_groups: z.number().int().nonnegative(),
    partially_shared_member_groups: z.number().int().nonnegative(),
    unique_members: z.number().int().nonnegative(),
    members_without_family: z.number().int().nonnegative(),
    members_with_complete_inventory: z.number().int().nonnegative(),
    members_with_unknown_inventory: z.number().int().nonnegative(),
  }),
  families: z.array(familySchema),
  shared_members: z.array(memberIndexRowSchema),
  partially_shared_members: z.array(memberIndexRowSchema),
  unique_members: z.array(memberIndexRowSchema),
  coverage: z.strictObject({
    members_examined: z.number().int().positive(),
    members_with_complete_inventory: z.number().int().nonnegative(),
    members_with_unknown_inventory: z.number().int().nonnegative(),
    nodes_examined: z.number().int().nonnegative(),
    shared_member_minimum: z.number().int().positive(),
    member_scope: z.string().nullable(),
    member_index_withheld: z.boolean(),
  }),
  limitations: z.array(z.string()),
});

export type ArtifactFamilyClusteringResult = z.infer<
  typeof artifactFamilyClusteringResultSchema
>;

type UnknownReason = z.infer<typeof unknownReasonSchema>;
type MemberRow = z.infer<typeof memberRowSchema>;
type MemberIndexRow = z.infer<typeof memberIndexRowSchema>;

interface MemberInventory {
  readonly label: string;
  readonly evidenceId: string;
  readonly inventory: InventorySet;
}

interface ComparableScope {
  readonly clustered: readonly (MemberInventory & {
    readonly reason: UnknownReason | null;
  })[];
  readonly scopes: readonly ArtifactInventoryCoverage["scope"][];
  readonly majorityScope: ArtifactInventoryCoverage["scope"] | null;
}

interface MemberIndex {
  readonly shared: MemberIndexRow[];
  readonly partiallyShared: MemberIndexRow[];
  readonly unique: MemberIndexRow[];
  readonly nodesExamined: number;
  readonly withheld: boolean;
}

const orderedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);

const fixedLimitations = [
  "Content identity is measured; authorship, provenance and licensing are not.",
  "Identical content does not establish identical runtime behaviour or shared source.",
  "Members are comparable only through the inspection parameters each Evidence declares.",
  "A member absent from a family is described as unplaced with its reason, never as different.",
  "A re-packed container with identical members has no shared root digest, so it has no family; that relationship appears only in shared_members or partially_shared_members.",
  "A member whose root digest no other member shares has no family; it is counted in members_without_family and is not evidence of difference from any other member.",
] as const;

/**
 * The first declaration that prevents a comparable placement, if any. Both a
 * missing graph member and a producer that declares incomplete child coverage
 * leave the inventory incomparable, so both are reported the same way rather
 * than leaving the member out of every row.
 */
const placementBlocker = (input: {
  readonly inventory: InventorySet;
}): UnknownReason | null => {
  if (input.inventory.integrityContradictions.length > 0)
    return "contradictory-integrity";
  if (!declaresCompleteInventory(input.inventory))
    return "incomplete-inventory";
  return null;
};

const memberRow = (
  member: MemberInventory & { readonly reason?: UnknownReason },
): MemberRow => ({
  label: member.label,
  evidence_id: member.evidenceId,
  root_sha256: member.inventory.manifest.root_sha256,
  manifest_id: member.inventory.manifest.manifest_id,
  coverage_status: member.inventory.coverage.status,
  coverage_scope: member.inventory.coverage.scope,
});

/** Count repeated values, retaining only the values that repeat. */
const repeatedValues = (
  values: readonly string[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** Parse every member once and record what blocks a comparable placement. */
const parseMembers = (
  members: readonly { readonly label: string; readonly evidence: Evidence }[],
): readonly (MemberInventory & { readonly reason: UnknownReason | null })[] =>
  members.map((member) => {
    const { inventory } = parseArtifactInventoryEvidence(member.evidence);
    return {
      label: member.label,
      evidenceId: member.evidence.evidence_id,
      inventory,
      reason: placementBlocker({ inventory }),
    };
  });

/**
 * Settle the one inventory scope a call may cluster over. Only a strict
 * majority defines it: a tie would otherwise let code-point order decide which
 * member is the outlier.
 */
const comparableScope = (
  parsed: readonly (MemberInventory & {
    readonly reason: UnknownReason | null;
  })[],
): ComparableScope => {
  const scopes: readonly ArtifactInventoryCoverage["scope"][] = [
    ...new Set(parsed.map((entry) => entry.inventory.coverage.scope)),
  ].sort(compareUnicodeCodePoints);
  const counts = repeatedValues(
    parsed.map((entry) => entry.inventory.coverage.scope),
  );
  const ranked = [...scopes].sort(
    (left, right) =>
      (counts.get(right) ?? 0) - (counts.get(left) ?? 0) ||
      compareUnicodeCodePoints(left, right),
  );
  const majorityScope =
    scopes.length <= 1
      ? (scopes[0] ?? null)
      : (counts.get(ranked[0]!) ?? 0) > parsed.length / 2
        ? ranked[0]!
        : null;
  return {
    scopes,
    majorityScope,
    clustered: parsed.map((entry) =>
      majorityScope !== null && entry.inventory.coverage.scope === majorityScope
        ? entry
        : {
            ...entry,
            reason: entry.reason ?? ("incomparable-coverage-scope" as const),
          },
    ),
  };
};

/** Build the family rows and the single unplaced row set. */
const buildFamilies = (
  complete: readonly MemberInventory[],
  unplaced: readonly (MemberRow & { readonly reason: UnknownReason })[],
): ArtifactFamilyClusteringResult["families"] => {
  const families: ArtifactFamilyClusteringResult["families"] = [
    ...complete
      .map((entry) => entry.inventory.manifest.root_sha256)
      .reduce((counts, digest) => {
        counts.set(digest, (counts.get(digest) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
      .entries(),
  ]
    .filter(([, count]) => count > 1)
    .map(([digest]) => digest)
    .sort(compareUnicodeCodePoints)
    .map((digest) => ({
      family_id: `root-${digest.slice(0, 16)}`,
      tier: "root-sha256" as const,
      basis:
        "Identical root content digest; these members are byte-identical at the inspected root.",
      members: complete
        .filter((entry) => entry.inventory.manifest.root_sha256 === digest)
        .map(memberRow)
        .sort((left, right) =>
          compareUnicodeCodePoints(left.label, right.label),
        ),
      unknown_members: [] as z.infer<typeof unknownMemberRowSchema>[],
    }));
  if (unplaced.length > 0)
    families.push({
      family_id: "unplaced",
      tier: null,
      basis:
        "Members with no comparable placement; each row carries its own reason and no family claim.",
      members: [],
      unknown_members: [...unplaced].sort((left, right) =>
        compareUnicodeCodePoints(left.label, right.label),
      ),
    });
  return families;
};

/**
 * Partition every examined member exactly once: shared, partially shared, or
 * unique. Nothing is dropped for falling under the shared threshold.
 */
const buildMemberIndex = (input: {
  readonly complete: readonly MemberInventory[];
  readonly minimum: number;
  readonly scope: ArtifactInventoryCoverage["scope"] | null;
}): MemberIndex => {
  const nodesExamined = input.complete.reduce(
    (total, entry) => total + entry.inventory.nodes.length,
    0,
  );
  const withheld = nodesExamined > MAX_EXAMINED_NODES;
  const index = new Map<string, { node: ArtifactNode; labels: Set<string> }>();
  if (!withheld && input.scope !== null)
    for (const entry of input.complete)
      for (const node of entry.inventory.nodes) {
        const existing = index.get(node.artifact_id);
        if (existing === undefined)
          index.set(node.artifact_id, { node, labels: new Set([entry.label]) });
        else existing.labels.add(entry.label);
      }
  const rows: MemberIndexRow[] = [...index.values()]
    .map((entry) => ({
      artifact_id: entry.node.artifact_id,
      sha256: entry.node.sha256,
      format: entry.node.format,
      observed_in: orderedUnique([...entry.labels]),
      member_count: entry.labels.size,
    }))
    .sort(
      (left, right) =>
        right.member_count - left.member_count ||
        compareUnicodeCodePoints(left.artifact_id, right.artifact_id),
    );
  return {
    nodesExamined,
    withheld,
    shared: rows.filter(
      (row) => row.member_count > 1 && row.member_count >= input.minimum,
    ),
    partiallyShared: rows.filter(
      (row) => row.member_count > 1 && row.member_count < input.minimum,
    ),
    unique: rows.filter((row) => row.member_count === 1),
  };
};

const statusFor = (input: {
  readonly compared: number;
  readonly examined: number;
}): z.infer<typeof clusterStatusSchema> =>
  input.compared === 0
    ? "unknown"
    : input.compared === input.examined
      ? "partitioned"
      : "partial";

/** Partition authenticated inventories into families and a shared/unique member index. */
export const clusterArtifactFamilies = (
  members: readonly { readonly label: string; readonly evidence: Evidence }[],
  options: {
    readonly sharedMemberMinimum?: number;
    readonly offset: number;
    readonly limit: number;
  },
): ArtifactFamilyClusteringResult => {
  const minimum = options.sharedMemberMinimum ?? members.length;
  const parsed = parseMembers(members);
  const { clustered, scopes, majorityScope } = comparableScope(parsed);
  const placed = clustered.filter((entry) => entry.reason === null);
  const complete =
    majorityScope === null
      ? []
      : placed.filter((entry) =>
          hasCompleteInventoryCoverage(entry.inventory, majorityScope),
        );
  const unplaced = clustered
    .filter(
      (entry): entry is MemberInventory & { readonly reason: UnknownReason } =>
        entry.reason !== null,
    )
    .map((entry) => ({ ...memberRow(entry), reason: entry.reason }));
  const families = buildFamilies(complete, unplaced);

  const index = buildMemberIndex({
    complete,
    minimum,
    scope: majorityScope,
  });
  const limitations = orderedUnique([
    ...fixedLimitations,
    ...parsed.flatMap((entry) =>
      entry.inventory.limitations.map((item) => `${entry.label}: ${item}`),
    ),
    ...(scopes.length > 1
      ? [
          majorityScope === null
            ? `Members declare different inventory coverage scopes (${scopes.join(", ")}) with no strict majority; nothing was clustered and no member is described as different.`
            : `Members declare different inventory coverage scopes (${scopes.join(", ")}); only ${majorityScope} members were clustered.`,
        ]
      : []),
    ...(index.withheld
      ? [
          `Examined graph nodes exceeded the ${MAX_EXAMINED_NODES} node budget; the shared and unique member index is withheld rather than reported partially.`,
        ]
      : []),
    ...(minimum > members.length
      ? []
      : [
          `A member counts as shared only when it appears in at least ${minimum} of ${members.length} members; members below that threshold are reported separately as partially shared, never dropped.`,
        ]),
    "Exhausting the returned page is not complete capture; every family remains addressable by paging.",
  ]);

  const placedMembers = families.reduce(
    (total, family) => total + family.members.length,
    0,
  );
  const compared = clustered.filter((entry) => entry.reason === null).length;
  const page = families.slice(options.offset, options.offset + options.limit);
  return {
    status: statusFor({ compared, examined: members.length }),
    summary: {
      members_examined: members.length,
      families: families.length,
      families_returned: page.length,
      shared_member_groups: index.shared.length,
      partially_shared_member_groups: index.partiallyShared.length,
      unique_members: index.unique.length,
      members_without_family: compared - placedMembers,
      members_with_complete_inventory: complete.length,
      members_with_unknown_inventory: members.length - complete.length,
    },
    families: page,
    shared_members: index.shared,
    partially_shared_members: index.partiallyShared,
    unique_members: index.unique,
    coverage: {
      members_examined: members.length,
      members_with_complete_inventory: complete.length,
      members_with_unknown_inventory: members.length - complete.length,
      nodes_examined: index.nodesExamined,
      shared_member_minimum: minimum,
      member_scope: majorityScope,
      member_index_withheld: index.withheld,
    },
    limitations,
  };
};
