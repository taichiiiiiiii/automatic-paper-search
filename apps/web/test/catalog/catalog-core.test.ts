/**
 * Ported from paperpilot/tests/viewer/test_catalog_paper_link.mjs (same
 * cases) -- SCR-16/SCR-17.
 */
import { describe, expect, it } from "vitest";
import {
  detailShardUrl,
  pinSelected,
  readDetailAbstract,
  readPaperParam,
  setPaperParam,
  validateCatalog,
} from "../../lib/catalog-core";

const idA = "0".repeat(40);
const idB = "a".repeat(40);
const idC = `aa${"0".repeat(38)}`;
const paperA = {
  paper_id: idA,
  title: "A",
  authors: [],
  tags: [],
  abstract: "preview",
  type: "Poster",
};
const paperB = {
  paper_id: idB,
  title: "B",
  authors: [],
  tags: [],
  abstract: "preview",
  type: "Poster",
};

describe("validateCatalog", () => {
  it("indexes valid rows by paper_id", () => {
    const byId = validateCatalog([paperA, paperB]);
    expect(byId.get(idA)).toBe(paperA);
  });

  it("throws on a duplicate paper_id", () => {
    expect(() => validateCatalog([paperA, paperA])).toThrow(/duplicate paper_id/);
  });

  it("throws on an invalid paper_id", () => {
    expect(() => validateCatalog([{ ...paperA, paper_id: "not-an-id" }])).toThrow(/paper_id/);
  });
});

describe("readPaperParam", () => {
  it("returns raw + validated paperId for a well-formed id", () => {
    expect(readPaperParam(`?q=A&paper=${idA}`)).toEqual({ raw: idA, paperId: idA });
  });
  it("returns raw but null paperId for a malformed id", () => {
    expect(readPaperParam("?paper=BAD")).toEqual({ raw: "BAD", paperId: null });
  });
  it("returns null/null when absent", () => {
    expect(readPaperParam("?q=A")).toEqual({ raw: null, paperId: null });
  });
});

describe("pinSelected", () => {
  it("moves the selected paper to the front without disturbing order otherwise", () => {
    expect(pinSelected([paperB], paperA)).toEqual([paperA, paperB]);
    expect(pinSelected([paperA, paperB], paperA)).toEqual([paperA, paperB]);
    expect(pinSelected([paperB, paperA], paperA)).toEqual([paperA, paperB]);
  });
  it("returns a copy, unchanged, when nothing is selected", () => {
    expect(pinSelected([paperB, paperA], null)).toEqual([paperB, paperA]);
  });
});

describe("detailShardUrl", () => {
  it("builds the shard path from the id's first two hex chars", () => {
    expect(detailShardUrl(idB)).toBe("/paper-details-v1/aa.json");
  });
});

describe("readDetailAbstract", () => {
  const shard = {
    schema_version: "paper-details-v1",
    prefix: "aa",
    papers: [[idB, "full abstract"]],
  };

  it("returns the matching row's text", () => {
    expect(readDetailAbstract(shard, idB)).toBe("full abstract");
  });
  it("treats an intentionally empty abstract as valid", () => {
    expect(readDetailAbstract({ ...shard, papers: [[idB, ""]] }, idB)).toBe("");
  });
  it("rejects a shard whose prefix does not match the paper_id", () => {
    expect(() => readDetailAbstract({ ...shard, prefix: "00" }, idB)).toThrow(/prefix/);
  });
  it("rejects a shard where the id is not found", () => {
    expect(() => readDetailAbstract({ ...shard, papers: [] }, idB)).toThrow(/not found/);
  });
  it("rejects a shard whose rows are not strictly sorted", () => {
    expect(() =>
      readDetailAbstract(
        {
          ...shard,
          papers: [
            [idB, "x"],
            [idC, "y"],
          ],
        },
        idB,
      ),
    ).toThrow(/sorted/);
  });
});

describe("setPaperParam", () => {
  it("sets ?paper= while preserving other params", () => {
    const withPaper = setPaperParam("https://example.test/iclr/?q=abc", idA);
    const url = new URL(withPaper);
    expect(url.searchParams.get("q")).toBe("abc");
    expect(url.searchParams.get("paper")).toBe(idA);
  });
  it("clears ?paper= while preserving other params", () => {
    const withPaper = setPaperParam("https://example.test/iclr/?q=abc", idA);
    const withoutPaper = setPaperParam(withPaper, null);
    const url = new URL(withoutPaper);
    expect(url.searchParams.get("q")).toBe("abc");
    expect(url.searchParams.has("paper")).toBe(false);
  });
  it("throws when asked to set a malformed id", () => {
    expect(() => setPaperParam("https://example.test/iclr/", "not-an-id")).toThrow(/paper_id/);
  });
});
