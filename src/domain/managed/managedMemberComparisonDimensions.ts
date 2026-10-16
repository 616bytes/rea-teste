import canonicalize from "canonicalize";

import type { ManagedMemberInspection } from "./managedArtifact.js";
import type { ManagedMemberComparisonResult } from "./managedMemberComparison.js";
import { signatureIdentity } from "./managedMemberSignatureIdentity.js";

type Method = ManagedMemberInspection["methods"][number];
type MethodItem = ManagedMemberComparisonResult["methods"][number];

/** The token-bearing body facets of a matched method pair. */
interface OperandFacets {
  readonly cil: boolean;
  readonly exceptionShape: boolean;
  /** A facet REA could not decide because an operand has no identity. */
  readonly unknown: boolean;
}

/**
 * Exception clauses with each class as its build-local token, only marked
 * typed, or by its nominal identity.
 */
const exceptionShape = (
  method: Method,
  classes: "token" | "typed" | "named",
): string | undefined =>
  canonicalize(
    method.body.exception_regions.map((region) => [
      region.flags,
      region.try_offset,
      region.try_length,
      region.handler_offset,
      region.handler_length,
      region.class_token === null
        ? null
        : classes === "token"
          ? region.class_token
          : classes === "typed"
            ? "typed"
            : region.class_identity_sha256,
      region.filter_offset,
    ]),
  );

/**
 * Compare build-local bytes as the exact-CIL match does, so equal bytes
 * report no change even for members renamed in place. The decoded
 * fingerprint omits switch targets and is not exact CIL identity, so the raw
 * digest is compared too.
 */
const tokenFacets = (left: Method, right: Method): OperandFacets => ({
  cil:
    left.body.il_sha256 !== right.body.il_sha256 ||
    left.body.normalized_il_sha256 !== right.body.normalized_il_sha256,
  exceptionShape:
    exceptionShape(left, "token") !== exceptionShape(right, "token"),
  unknown: false,
});

const unnamedClass = (method: Method): boolean =>
  method.body.exception_regions.some(
    (region) =>
      region.class_token !== null && region.class_identity_sha256 === null,
  );

/**
 * Bytes that differ only in renumbered tokens are not a change: where the
 * build-local bytes differ, nominal operand identity decides. A body or class
 * REA could not name leaves that facet unknown, since its tokens neither
 * establish nor rule out a change.
 */
const nominalFacets = (left: Method, right: Method): OperandFacets => {
  const tokens = tokenFacets(left, right);
  const cilUnknown =
    tokens.cil &&
    (left.body.nominal_il_sha256 === null ||
      right.body.nominal_il_sha256 === null);
  const clauseChange =
    exceptionShape(left, "typed") !== exceptionShape(right, "typed");
  const classUnknown =
    tokens.exceptionShape &&
    !clauseChange &&
    (unnamedClass(left) || unnamedClass(right));
  return {
    cil:
      tokens.cil &&
      !cilUnknown &&
      left.body.nominal_il_sha256 !== right.body.nominal_il_sha256,
    exceptionShape:
      tokens.exceptionShape &&
      (clauseChange ||
        (!classUnknown &&
          exceptionShape(left, "named") !== exceptionShape(right, "named"))),
    unknown: cilUnknown || classUnknown,
  };
};

export const methodDimensions = (
  left: Method,
  right: Method,
  cilOperandsNamed: boolean,
): {
  readonly dimensions: MethodItem["dimensions"];
  readonly bodyUnknown: boolean;
  readonly operandsUnknown: boolean;
} => {
  const dimensions: MethodItem["dimensions"] = [];
  if (left.flags !== right.flags || left.impl_flags !== right.impl_flags)
    dimensions.push("metadata");
  if (signatureIdentity(left.signature) !== signatureIdentity(right.signature))
    dimensions.push("signature");
  const leftBodyComplete =
    left.body.status === "present" && left.body.truncated_instructions === 0;
  const rightBodyComplete =
    right.body.status === "present" && right.body.truncated_instructions === 0;
  const bothAbsent =
    left.body.status === "absent" && right.body.status === "absent";
  if (
    (left.body.status === "absent" && rightBodyComplete) ||
    (right.body.status === "absent" && leftBodyComplete)
  )
    dimensions.push("availability");
  if (bothAbsent)
    return { dimensions, bodyUnknown: false, operandsUnknown: false };
  if (!leftBodyComplete || !rightBodyComplete)
    return { dimensions, bodyUnknown: true, operandsUnknown: false };
  const operands = cilOperandsNamed
    ? nominalFacets(left, right)
    : tokenFacets(left, right);
  if (operands.cil) dimensions.push("cil");
  if (
    canonicalize(left.body.opcode_counts) !==
    canonicalize(right.body.opcode_counts)
  )
    dimensions.push("opcode-shape");
  if (callShape(left.body.anchors) !== callShape(right.body.anchors))
    dimensions.push("call-shape");
  if (fieldShape(left.body.anchors) !== fieldShape(right.body.anchors))
    dimensions.push("field-shape");
  if (operands.exceptionShape) dimensions.push("exception-shape");
  return { dimensions, bodyUnknown: false, operandsUnknown: operands.unknown };
};

const callShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "method")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );

const fieldShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "field")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );
