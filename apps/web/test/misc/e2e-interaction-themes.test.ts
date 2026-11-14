// #515: the e2e interaction suite runs on a sample of the published themes
// (e2e/support/site.ts interactionThemes, #466). The page's cost grows with
// the number of relations, but the sample only looked at paper counts and
// recency, so the 588-relation NeRF theme was sampled only by chance (as the
// newest). The unaudited theme with the most relations is now always in.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interactionThemes,
  OUT_DIR,
  type PublishedTheme,
  publishedThemes,
  themeEdgeCount,
} from "../../e2e/support/site";

const THEMES: PublishedTheme[] = [
  { slug: "audited-a", theme: "A", paper_count: 10, generated_at: "2026-10-01", tier: "audited" },
  {
    slug: "most-papers",
    theme: "B",
    paper_count: 90,
    generated_at: "2026-10-02",
    tier: "unaudited",
  },
  {
    slug: "most-edges",
    theme: "C",
    paper_count: 40,
    generated_at: "2026-10-03",
    tier: "unaudited",
  },
  { slug: "newest", theme: "D", paper_count: 20, generated_at: "2026-11-11", tier: "unaudited" },
  { slug: "other", theme: "E", paper_count: 30, generated_at: "2026-10-04", tier: "unaudited" },
];
const EDGES: Record<string, number> = {
  "audited-a": 900,
  "most-papers": 200,
  "most-edges": 600,
  newest: 50,
  other: 300,
};

describe("interactionThemes (#466 / #515)", () => {
  it("samples audited + most papers + most relations + newest, when all differ", () => {
    const slugs = interactionThemes(THEMES, (s) => EDGES[s] ?? 0).map((t) => t.slug);
    expect(slugs.sort()).toEqual(["audited-a", "most-edges", "most-papers", "newest"]);
  });

  it("deduplicates when one theme is both the largest and the most connected", () => {
    const slugs = interactionThemes(THEMES, (s) => (s === "most-papers" ? 999 : (EDGES[s] ?? 0)));
    expect(slugs.map((t) => t.slug).sort()).toEqual(["audited-a", "most-papers", "newest"]);
  });

  it.skipIf(!existsSync(join(OUT_DIR, "themes", "themes-manifest.json")))(
    "on the built site, includes the unaudited theme with the most relations",
    () => {
      const all = publishedThemes();
      const unaudited = all.filter((t) => t.tier !== "audited");
      const max = Math.max(...unaudited.map((t) => themeEdgeCount(t.slug)));
      const picked = interactionThemes(all);
      expect(picked.some((t) => t.tier !== "audited" && themeEdgeCount(t.slug) === max)).toBe(true);
    },
  );
});
