import { describe, expect, it } from "vitest";
import { isCatalogSlug, selectCatalogConferences } from "../../lib/catalog-conferences";

const row = (name: string) => ({
  name,
  papers: 1,
  types: { Oral: 1 },
  top_tags: [["LLM", 1]],
  generated: "2026-06-28",
});

describe("isCatalogSlug", () => {
  it("accepts a well-formed conference slug", () => {
    expect(isCatalogSlug("cvpr-2026")).toBe(true);
  });
  it("rejects a reserved top-level site section", () => {
    expect(isCatalogSlug("themes")).toBe(false);
    expect(isCatalogSlug("daily")).toBe(false);
    expect(isCatalogSlug("lineage")).toBe(false);
    expect(isCatalogSlug("how-it-works")).toBe(false);
  });
  it("rejects a slug that does not match the slug pattern", () => {
    expect(isCatalogSlug("CVPR-2026")).toBe(false);
    expect(isCatalogSlug("-leading-dash")).toBe(false);
  });
});

describe("selectCatalogConferences", () => {
  it("passes through well-formed, non-reserved rows", () => {
    const rows = [row("cvpr-2026"), row("iclr-2026")];
    expect(selectCatalogConferences(rows).map((r) => r.name)).toEqual(["cvpr-2026", "iclr-2026"]);
  });

  it("filters out a reserved slug even if it somehow appeared in conferences.json", () => {
    const rows = [row("cvpr-2026"), row("themes")];
    expect(selectCatalogConferences(rows).map((r) => r.name)).toEqual(["cvpr-2026"]);
  });

  it("throws on a malformed conferences.json (fail loudly at build time)", () => {
    expect(() => selectCatalogConferences([{ name: "cvpr-2026" }])).toThrow();
    expect(() => selectCatalogConferences("not an array")).toThrow();
  });
});
