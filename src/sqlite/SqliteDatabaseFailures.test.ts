import { describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";
import { sqliteDatabaseFailure } from "./SqliteDatabaseFailures.js";

const PATH = "/tmp/sample.db";
const PHASE = "artifact-read";

describe("sqliteDatabaseFailure: ArtifactReaderFailure reason projection", () => {
  it("classifies a 'limit' failure as a file-size resource_constraint with the budget in reported_limits (#4127)", () => {
    const cause = new ArtifactReaderFailure(
      "limit",
      `Selected SQLite database and WAL exceed the combined ${String(SQLITE_DATABASE_LIMITS.inputBytes)}-byte snapshot budget: ${PATH}`,
    );

    const result = sqliteDatabaseFailure(cause, PATH, PHASE);

    // Surface the projected error so the test covers both the in-module
    // AnalysisError class and the cross-provider `code`/`category` shape
    // that downstream callers actually observe.
    const projected = projectAnalysisError(result);
    expect(projected.code).toBe("resource_constraint");
    expect(projected.category).toBe("resource_constraint");
    expect(projected.retryable).toBe(false);
    expect(projected.message).toBe(cause.message);

    // Direct class is also correct so the typed error carries the right
    // kind and reported_limits for callers that branch on `_tag`.
    expect(result).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(result).not.toBeInstanceOf(AnalysisInputError);
    const constraint = result as AnalysisResourceConstraintError;
    expect(constraint.resource).toBe("file-size");
    expect(constraint.reportedLimits).toEqual({
      sqlite_snapshot_input_bytes: SQLITE_DATABASE_LIMITS.inputBytes,
    });
    expect(constraint.message).toBe(cause.message);
    expect(constraint.operation).toBe("inspect_sqlite_database");
  });

  it("classifies a 'format' failure as AnalysisInputError with reason 'invalid_format'", () => {
    const cause = new ArtifactReaderFailure(
      "format",
      "Selected SQLite database could not be parsed",
    );

    const result = sqliteDatabaseFailure(cause, PATH, PHASE);
    const input = result as AnalysisInputError;
    expect(result).toBeInstanceOf(AnalysisInputError);
    expect(input.issues[0]?.reason).toBe("invalid_format");
    expect(input.issues[0]?.path).toEqual(["path"]);
    expect(input.issues[0]?.message).toBe(cause.message);
  });

  it("classifies a 'path' failure as AnalysisInputError with reason 'invalid_format' (regression: the 'limit' special case must not steal 'path')", () => {
    const cause = new ArtifactReaderFailure(
      "path",
      "Selected SQLite database is not a regular file",
    );

    const result = sqliteDatabaseFailure(cause, PATH, PHASE);
    expect(result).toBeInstanceOf(AnalysisInputError);
    const input = result as AnalysisInputError;
    expect(input.issues[0]?.reason).toBe("invalid_format");
    expect(input.issues[0]?.path).toEqual(["path"]);
  });

  it("classifies an 'integrity' failure as AnalysisArtifactChangedError", () => {
    const cause = new ArtifactReaderFailure(
      "integrity",
      `SQLite snapshot file set changed during acquisition: ${PATH}`,
    );

    const result = sqliteDatabaseFailure(cause, PATH, PHASE);
    expect(result).toBeInstanceOf(AnalysisArtifactChangedError);
  });

  it("classifies a 'cancelled' failure as AnalysisCancelledError", () => {
    const cause = new ArtifactReaderFailure("cancelled", "aborted");

    const result = sqliteDatabaseFailure(cause, PATH, PHASE);
    expect(result).toBeInstanceOf(AnalysisCancelledError);
  });

  it("does not regress: a 'limit' failure never projects to invalid_request (#4127)", () => {
    // Sanity guard: the previous shape classified every non-cleanup
    // ArtifactReaderFailure as AnalysisInputError. Make sure the 'limit'
    // special case never re-introduces that regression.
    const cause = new ArtifactReaderFailure(
      "limit",
      `Selected SQLite database and WAL exceed the combined ${String(SQLITE_DATABASE_LIMITS.inputBytes)}-byte snapshot budget: ${PATH}`,
    );

    const projected = projectAnalysisError(
      sqliteDatabaseFailure(cause, PATH, PHASE),
    );
    expect(projected.code).not.toBe("invalid_request");
    expect(projected.code).not.toBe("unreadable_output");
  });
});
