import { describe, expect, it } from "vitest";

/**
 * Independent re-implementation of scripts/copy-data.ts's `shouldCopy`
 * filter, kept deliberately separate (not imported) for two reasons:
 *   1. Like test/csp.test.ts's `collectInlineScriptHashes`, restating the
 *      rule here catches bugs in the real one rather than mirroring them.
 *   2. scripts/copy-data.ts's `main()` runs unconditionally on import
 *      (same pattern as scripts/csp-hash.ts) and does real filesystem
 *      I/O against ../../docs -- importing it from a test would copy
 *      ~79 MB of real data as a side effect of running `vitest run`.
 */
const EXCLUDED_TOP_LEVEL_DIRS = new Set(["design", "research"]);

function shouldCopy(relPath: string): boolean {
  const segments = relPath.split("/");
  const topLevelDir = segments.length > 1 ? segments[0] : undefined;
  if (topLevelDir !== undefined && EXCLUDED_TOP_LEVEL_DIRS.has(topLevelDir)) {
    return false;
  }
  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith("_IMPLEMENTER.md")) {
    return false;
  }
  return basename.endsWith(".json");
}

describe("copy-data shouldCopy", () => {
  it("copies top-level JSON (conferences.json)", () => {
    expect(shouldCopy("conferences.json")).toBe(true);
  });

  it("copies a conference's papers.json", () => {
    expect(shouldCopy("cvpr-2026/papers.json")).toBe(true);
  });

  it("copies a conference's lineage.json", () => {
    expect(shouldCopy("iclr-2026/lineage.json")).toBe(true);
  });

  it("copies the cross-conference search index", () => {
    expect(shouldCopy("search-index-v2.json")).toBe(true);
  });

  it("copies nested shard JSON (paper-details-v1/, search-paper-ids-v1/)", () => {
    expect(shouldCopy("paper-details-v1/4f.json")).toBe(true);
    expect(shouldCopy("search-paper-ids-v1/0048.json")).toBe(true);
  });

  it("copies theme lineage JSON and the themes manifest", () => {
    expect(shouldCopy("themes/flash-attention/lineage.json")).toBe(true);
    expect(shouldCopy("themes/themes-manifest.json")).toBe(true);
  });

  it("excludes non-JSON files (HTML, CSS, JS, images)", () => {
    expect(shouldCopy("index.html")).toBe(false);
    expect(shouldCopy("cvpr-2026/index.html")).toBe(false);
    expect(shouldCopy("assets/style.css")).toBe(false);
    expect(shouldCopy("assets/app.js")).toBe(false);
    expect(shouldCopy("assets/og-image.png")).toBe(false);
  });

  it("excludes everything under docs/design/", () => {
    expect(shouldCopy("design/39-typescript-cloudflare-migration.md")).toBe(false);
  });

  it("excludes everything under docs/research/", () => {
    expect(shouldCopy("research/01-market.md")).toBe(false);
  });

  it("excludes *_IMPLEMENTER.md wherever it appears", () => {
    expect(shouldCopy("QWEN_IMPLEMENTER.md")).toBe(false);
    expect(shouldCopy("some/nested/FLASH_IMPLEMENTER.md")).toBe(false);
  });

  it("a design/research-named JSON file would still be excluded (dir wins over extension)", () => {
    expect(shouldCopy("design/hypothetical.json")).toBe(false);
    expect(shouldCopy("research/hypothetical.json")).toBe(false);
  });
});
