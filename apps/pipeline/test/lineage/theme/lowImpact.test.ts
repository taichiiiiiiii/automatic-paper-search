/**
 * R2-45: low-impact leaves are dropped; seeds, focus nodes, recent papers,
 * cited nodes and nodes with a lineage relation stay.
 */
import { describe, expect, it } from "vitest";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import { pruneLowImpactLeaves } from "../../../src/lineage/theme/lowImpact.js";

const n = (
  id: string,
  year: number,
  cites: number,
  extra: Partial<ThemeGraphNode> = {},
): ThemeGraphNode => ({
  id,
  title: id,
  year,
  venue: "",
  venue_tier: "preprint",
  authors: [],
  kinds: [],
  citation_count: cites,
  github_stars: 0,
  tldr: "",
  ...extra,
});
const e = (src: string, dst: string, relation = "baseline_only"): ThemeEdge =>
  ({ src, dst, relation }) as unknown as ThemeEdge;

describe("pruneLowImpactLeaves (R2-45)", () => {
  const build = () => {
    const nodes = new Map<string, ThemeGraphNode>(
      [
        n("seed", 2020, 5000),
        n("hub", 2023, 900),
        n("niche", 2024, 12), // low, old enough, cited by nobody -> dropped
        n("fresh", 2026, 3), // this year -> stays
        n("cited", 2024, 8), // cited by `hub2` in the graph -> stays
        n("hub2", 2024, 400),
        n("lineage", 2024, 5), // lineage edge -> stays
        n("focus", 2024, 4, { is_focus: true }), // stays
        n("popular", 2024, 200), // enough citations -> stays
      ].map((x) => [x.id, x]),
    );
    const edges = [
      e("seed", "hub"),
      e("hub", "niche"),
      e("hub", "fresh"),
      e("cited", "hub2"),
      e("hub", "cited"),
      e("seed", "lineage", "extends"),
      e("seed", "focus"),
      e("seed", "popular"),
    ];
    return { nodes, edges };
  };

  it("drops only the niche leaf and its edges", () => {
    const { nodes, edges } = build();
    const r = pruneLowImpactLeaves(nodes, edges, { seedIds: new Set(["seed"]), currentYear: 2026 });
    expect(r.dropped.map((d) => d.id)).toEqual(["niche"]);
    expect(nodes.has("niche")).toBe(false);
    expect(r.edges.some((x) => x.src === "niche" || x.dst === "niche")).toBe(false);
    expect(r.edges.length).toBe(edges.length - 1);
    for (const keep of ["seed", "hub", "fresh", "cited", "lineage", "focus", "popular"]) {
      expect(nodes.has(keep), keep).toBe(true);
    }
  });

  it("leaves a graph without such leaves untouched", () => {
    const { nodes, edges } = build();
    nodes.delete("niche");
    const kept = edges.filter((x) => x.dst !== "niche");
    const r = pruneLowImpactLeaves(nodes, kept, { seedIds: new Set(["seed"]), currentYear: 2026 });
    expect(r.dropped).toEqual([]);
    expect(r.edges).toBe(kept);
  });
});
