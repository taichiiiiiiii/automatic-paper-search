/**
 * Ported from docs/assets/app.js `readUrlState`/`syncUrlState`'s
 * contract (no direct viewer test file -- these were only exercised
 * indirectly through the DOM harness in
 * paperpilot/tests/viewer/test_catalog_viewer_medium.mjs).
 */
import { describe, expect, it } from "vitest";
import { buildCatalogUrl, readCatalogUrlState } from "../../lib/catalog-url-state";

describe("readCatalogUrlState", () => {
  it("reads q/type/tags/sort", () => {
    expect(readCatalogUrlState("?q=vision&type=Oral&tags=3D,LLM&sort=title")).toEqual({
      search: "vision",
      type: "Oral",
      sort: "title",
      activeTags: new Set(["3D", "LLM"]),
    });
  });

  it("falls back to defaults for an absent query string", () => {
    expect(readCatalogUrlState("")).toEqual({
      search: "",
      type: "all",
      sort: "default",
      activeTags: new Set(),
    });
  });

  it("falls back to defaults on an unrecognized type/sort, never widening the result", () => {
    expect(readCatalogUrlState("?type=Workshop&sort=bogus")).toEqual({
      search: "",
      type: "all",
      sort: "default",
      activeTags: new Set(),
    });
  });

  it("drops blank/whitespace-only tag entries", () => {
    expect(readCatalogUrlState("?tags=3D,, ,LLM").activeTags).toEqual(new Set(["3D", "LLM"]));
  });
});

describe("buildCatalogUrl", () => {
  it("sets q/type/tags/sort and preserves an unrelated param (?paper=)", () => {
    const url = buildCatalogUrl("https://example.test/cvpr-2026/?paper=aa", {
      search: "vision",
      type: "Oral",
      sort: "title",
      activeTags: new Set(["3D", "LLM"]),
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("vision");
    expect(parsed.searchParams.get("type")).toBe("Oral");
    expect(parsed.searchParams.get("sort")).toBe("title");
    expect(parsed.searchParams.get("tags")).toBe("3D,LLM");
    expect(parsed.searchParams.get("paper")).toBe("aa");
  });

  it("omits every param that equals its default, keeping the URL clean", () => {
    const url = buildCatalogUrl("https://example.test/cvpr-2026/?q=stale&type=Oral", {
      search: "",
      type: "all",
      sort: "default",
      activeTags: new Set(),
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has("q")).toBe(false);
    expect(parsed.searchParams.has("type")).toBe(false);
    expect(parsed.searchParams.has("tags")).toBe(false);
    expect(parsed.searchParams.has("sort")).toBe(false);
  });
});
