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
      hasAbstract: false,
    });
  });

  it("reads abs=1 as the has-abstract filter and ignores any other value", () => {
    expect(readCatalogUrlState("?abs=1").hasAbstract).toBe(true);
    expect(readCatalogUrlState("?abs=0").hasAbstract).toBe(false);
    expect(readCatalogUrlState("?abs=yes").hasAbstract).toBe(false);
  });

  it("falls back to defaults for an absent query string", () => {
    expect(readCatalogUrlState("")).toEqual({
      search: "",
      type: "all",
      sort: "default",
      activeTags: new Set(),
      hasAbstract: false,
    });
  });

  it("falls back to defaults on an unrecognized type/sort, never widening the result", () => {
    expect(readCatalogUrlState("?type=Workshop&sort=bogus")).toEqual({
      search: "",
      type: "all",
      sort: "default",
      activeTags: new Set(),
      hasAbstract: false,
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

  it("writes abs=1 only while the has-abstract filter is on", () => {
    const base = {
      search: "",
      type: "all" as const,
      sort: "default" as const,
      activeTags: new Set<string>(),
    };
    const on = new URL(
      buildCatalogUrl("https://example.test/iclr-2025/", { ...base, hasAbstract: true }),
    );
    expect(on.searchParams.get("abs")).toBe("1");
    const off = new URL(buildCatalogUrl(on.toString(), { ...base, hasAbstract: false }));
    expect(off.searchParams.has("abs")).toBe(false);
  });
});
