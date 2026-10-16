import { canonicalJson } from "./comparisonSemantics.js";

/**
 * Endpoint identity and edge matching for the reference comparison: sort order
 * is not identity, and an unresolved endpoint is a knowledge asymmetry rather
 * than a difference.
 */

/** A projected endpoint; see `referenceEndpoint` for what identifies a target. */
export type ReferenceEndpoint =
  | { readonly address: string; readonly name: string | null }
  | { readonly name: string }
  | null;

export type EndpointComparison = "equal" | "changed" | "asymmetric";

/**
 * Compare two endpoints. An endpoint the other record leaves unresolved is a
 * knowledge asymmetry rather than a difference: no known endpoint differs, and
 * equality cannot be established either. Within one artifact the address
 * identifies the target and a resolved name is supplementary, so a named
 * endpoint and an unnamed one at the same address agree.
 */
export const compareEndpoint = (
  left: ReferenceEndpoint,
  right: ReferenceEndpoint,
): EndpointComparison => {
  if (left === null || right === null) return "asymmetric";
  if ("address" in left && "address" in right)
    return left.address === right.address ? "equal" : "changed";
  if ("address" in left || "address" in right) return "asymmetric";
  return left.name === right.name ? "equal" : "changed";
};

export type ProjectedReference = {
  readonly direction: string;
  readonly source: ReferenceEndpoint;
  readonly target: ReferenceEndpoint;
};

/**
 * Match projected edges across the two records by endpoint identity rather
 * than by canonical sort position: sort order is not identity, and an
 * unresolved endpoint can sit anywhere once sorted. Equal pairs match first;
 * leftover edges pair against each other, where a known mismatch is a
 * difference and an unresolved counterpart is a knowledge asymmetry.
 */
export const matchEndpointLists = (
  left: readonly ProjectedReference[],
  right: readonly ProjectedReference[],
): "equal" | "changed" | "asymmetric" => {
  if (left.length !== right.length) return "changed";
  const unmatchedRight = [...right];
  const unmatchedLeft: ProjectedReference[] = [];
  for (const leftEdge of left) {
    const matchAt = unmatchedRight.findIndex(
      (rightEdge) =>
        rightEdge.direction === leftEdge.direction &&
        compareEndpoint(leftEdge.source, rightEdge.source) === "equal" &&
        compareEndpoint(leftEdge.target, rightEdge.target) === "equal",
    );
    if (matchAt === -1) unmatchedLeft.push(leftEdge);
    else unmatchedRight.splice(matchAt, 1);
  }
  let asymmetric = false;
  for (let index = 0; index < unmatchedLeft.length; index += 1) {
    const leftEdge = unmatchedLeft[index];
    const rightEdge = unmatchedRight[index];
    if (leftEdge === undefined || rightEdge === undefined) return "changed";
    if (leftEdge.direction !== rightEdge.direction) return "changed";
    for (const side of ["source", "target"] as const) {
      const outcome = compareEndpoint(leftEdge[side], rightEdge[side]);
      if (outcome === "changed") return "changed";
      if (outcome === "asymmetric") asymmetric = true;
    }
  }
  return asymmetric ? "asymmetric" : "equal";
};

export type KindReference = {
  readonly direction: string;
  readonly source: ReferenceEndpoint;
  readonly target: ReferenceEndpoint;
  readonly kind: Readonly<Record<string, unknown>>;
};

const kindJson = (row: KindReference): string =>
  canonicalJson(row.kind, "Function comparison");

/**
 * Compare edge-semantics rows that each carry their endpoints. A known kind
 * difference is a change whatever the endpoint identity, so the plain kind
 * multiset decides first; when it agrees, kinds are matched to their endpoints
 * so two edges cannot swap semantics undetected, while an unresolved endpoint
 * stays a knowledge asymmetry rather than kind evidence.
 */
export const compareKindRows = (
  left: readonly unknown[],
  right: readonly unknown[],
): "equal" | "changed" | "asymmetric" => {
  const leftRows = left as readonly KindReference[];
  const rightRows = right as readonly KindReference[];
  if (
    canonicalJson(
      leftRows.map(({ kind }) => kind),
      "Function comparison",
    ) !==
    canonicalJson(
      rightRows.map(({ kind }) => kind),
      "Function comparison",
    )
  )
    return "changed";
  const unmatchedRight = [...rightRows];
  const unmatchedLeft: KindReference[] = [];
  for (const leftRow of leftRows) {
    const matchAt = unmatchedRight.findIndex(
      (rightRow) =>
        rightRow.direction === leftRow.direction &&
        compareEndpoint(leftRow.source, rightRow.source) === "equal" &&
        compareEndpoint(leftRow.target, rightRow.target) === "equal",
    );
    if (matchAt === -1) unmatchedLeft.push(leftRow);
    else if (kindJson(leftRow) !== kindJson(unmatchedRight[matchAt]!))
      return "changed";
    else unmatchedRight.splice(matchAt, 1);
  }
  let asymmetric = false;
  for (let index = 0; index < unmatchedLeft.length; index += 1) {
    const leftRow = unmatchedLeft[index];
    const rightRow = unmatchedRight[index];
    if (leftRow === undefined || rightRow === undefined) return "changed";
    if (leftRow.direction !== rightRow.direction) return "changed";
    if (kindJson(leftRow) !== kindJson(rightRow)) return "changed";
    asymmetric = true;
  }
  return asymmetric ? "asymmetric" : "equal";
};
