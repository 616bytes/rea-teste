import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MAX_JSON_DEPTH } from "../jsonValue.js";
import { projectKeyedArchive } from "./keyedArchive.js";

const deepValue = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};

describe("projectKeyedArchive input bound", () => {
  it("rejects an over-deep archive value with a validation error instead of crashing", () => {
    let error: unknown;
    try {
      projectKeyedArchive(deepValue(MAX_JSON_DEPTH + 1), {
        offset: 0,
        limit: 1,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(z.ZodError);
    expect(error).not.toBeInstanceOf(RangeError);
  });
});

describe("projectKeyedArchive root selection", () => {
  const archive = {
    $version: 100_000,
    $archiver: "NSKeyedArchiver",
    $top: { UID: 1, ordinary: 7 },
    $objects: ["$null"],
  };

  it("does not read a selected scalar root named UID as a reference", () => {
    const projection = projectKeyedArchive(archive, {
      root: "UID",
      offset: 0,
      limit: 10,
    });
    expect(projection.roots).toEqual({ UID: 1 });
    expect(projection.references).toEqual([]);
    expect(projection.total_references).toBe(0);
    expect(
      projectKeyedArchive(archive, { offset: 0, limit: 10 }).references,
    ).toEqual([]);
  });

  it("reports a selected root that holds a UID under its key", () => {
    const projection = projectKeyedArchive(
      { ...archive, $top: { root: { CF$UID: 0 }, ordinary: 7 } },
      { root: "root", offset: 0, limit: 10 },
    );
    expect(projection.references).toEqual([
      {
        source: null,
        path: ["root"],
        target: 0,
        raw: { CF$UID: 0 },
        status: "nil",
      },
    ]);
  });

  it("keeps one value budget across the selected roots", () => {
    const values = Array.from({ length: 150_000 }, () => 0);
    expect(() =>
      projectKeyedArchive(
        { ...archive, $top: { first: values, second: values } },
        { offset: 0, limit: 10 },
      ),
    ).toThrow(RangeError);
  });
});
