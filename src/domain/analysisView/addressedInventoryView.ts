import { AnalysisInputError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";

const isAddressedInventoryItem = (value: unknown): value is JsonValue =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "address" in value &&
  typeof value.address === "string" &&
  "value" in value &&
  typeof value.value === "string";

const validatedInventoryResults = new WeakMap<object, boolean>();

const getAddressedInventoryRows = (
  parent: AnalysisViewParent,
): JsonValue[] | undefined => {
  const rows = parent.normalizedResult;
  if (!Array.isArray(rows)) return undefined;

  if (parent.sealedResult) {
    const cachedResult = validatedInventoryResults.get(rows);
    if (cachedResult !== undefined)
      return cachedResult ? (rows as JsonValue[]) : undefined;

    const isValid = rows.every(isAddressedInventoryItem);
    validatedInventoryResults.set(rows, isValid);
    return isValid ? (rows as JsonValue[]) : undefined;
  }

  return rows.every(isAddressedInventoryItem) ? rows : undefined;
};

const invalidView = (message: string): AnalysisError =>
  new AnalysisInputError("inspect_analysis_view", undefined, [
    {
      path: ["view"],
      reason: "invalid_value",
      message,
    },
  ]);

/** Page exact address/value rows retained by a native inventory Evidence. */
export const projectAddressedInventoryView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
  inventory: {
    readonly operation: "list_procedures" | "list_strings";
    readonly collection: "procedures" | "strings";
  },
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "page" || view.collection !== inventory.collection)
    return err(
      invalidView(
        `${inventory.operation} Evidence supports stable pages of the ${inventory.collection} collection.`,
      ),
    );

  const rows = getAddressedInventoryRows(parent);
  if (rows === undefined)
    return err(
      invalidView(
        `Parent Evidence result does not match the ${inventory.operation} address/value inventory.`,
      ),
    );

  if (parent.artifact === undefined || parent.artifact === null)
    return err(
      invalidView(
        `Parent ${inventory.operation} Evidence has no authenticated artifact identity.`,
      ),
    );

  const items = rows.slice(view.offset, view.offset + view.limit);
  const projection: UnsignedAnalysisView = {
    kind: "page",
    view,
    items,
    parent_evidence_id: parent.evidenceId,
    parent_operation: inventory.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: parent.artifact.path,
      sha256: parent.artifact.sha256,
    },
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
    limitations: [...parent.limitations],
    unknowns: [],
  };
  return ok(projection);
};
