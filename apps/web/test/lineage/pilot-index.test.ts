import { describe, expect, it } from "vitest";
import {
  findPilotEntry,
  isValidPaperId,
  parsePilotIndex,
  readSinglePaperParam,
} from "../../lib/lineage/pilot-index";

const paperId = "1".repeat(40);

describe("parsePilotIndex", () => {
  it("accepts the current empty published shape", () => {
    expect(parsePilotIndex({ entries: [], schema_version: "lineage-pilot-index-v1" })).toEqual({
      schema_version: "lineage-pilot-index-v1",
      entries: [],
    });
  });

  it("accepts an entry carrying a valid paper_id", () => {
    const parsed = parsePilotIndex({
      schema_version: "lineage-pilot-index-v1",
      entries: [{ paper_id: paperId, release_id: "r1" }],
    });
    expect(parsed?.entries).toHaveLength(1);
  });

  it("rejects a wrong schema_version", () => {
    expect(parsePilotIndex({ schema_version: "lineage-pilot-index-v2", entries: [] })).toBeNull();
  });

  it("rejects extra top-level keys", () => {
    expect(
      parsePilotIndex({ schema_version: "lineage-pilot-index-v1", entries: [], extra: true }),
    ).toBeNull();
  });

  it("rejects an entry with a malformed paper_id", () => {
    expect(
      parsePilotIndex({
        schema_version: "lineage-pilot-index-v1",
        entries: [{ paper_id: "not-hex" }],
      }),
    ).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(parsePilotIndex(null)).toBeNull();
    expect(parsePilotIndex([])).toBeNull();
  });
});

describe("isValidPaperId", () => {
  it("accepts 40 lowercase hex characters", () => {
    expect(isValidPaperId(paperId)).toBe(true);
  });
  it("rejects null, short, uppercase, and non-hex values", () => {
    expect(isValidPaperId(null)).toBe(false);
    expect(isValidPaperId("abc")).toBe(false);
    expect(isValidPaperId("A".repeat(40))).toBe(false);
    expect(isValidPaperId("g".repeat(40))).toBe(false);
  });
});

describe("readSinglePaperParam", () => {
  it("reads exactly one occurrence", () => {
    expect(readSinglePaperParam(`?paper=${paperId}`)).toBe(paperId);
  });
  it("returns null when the param is absent", () => {
    expect(readSinglePaperParam("")).toBeNull();
  });
  it("returns null when the param repeats (never 'pick the first')", () => {
    expect(readSinglePaperParam(`?paper=${paperId}&paper=${"2".repeat(40)}`)).toBeNull();
  });
});

describe("findPilotEntry", () => {
  it("finds a unique matching entry", () => {
    const index = parsePilotIndex({
      schema_version: "lineage-pilot-index-v1",
      entries: [{ paper_id: paperId }],
    });
    expect(findPilotEntry(index, paperId)?.paper_id).toBe(paperId);
  });
  it("returns null for an empty index (today's production state)", () => {
    const index = parsePilotIndex({ schema_version: "lineage-pilot-index-v1", entries: [] });
    expect(findPilotEntry(index, paperId)).toBeNull();
  });
  it("returns null when the index itself is null", () => {
    expect(findPilotEntry(null, paperId)).toBeNull();
  });
});
