// Design doc 48 P0-5 / P1-3 / P1-5: pure helpers behind the Prior /
// Derivative panel, the two-paper path, the year × citation timeline and
// the catalog's "系譜での位置".
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadThemePositionIndex, resetThemePositionIndexForTests } from "../../lib/data-themes";
import {
  isStrongRelation,
  priorDerivative,
  shortestLineagePath,
} from "../../lib/lineage/paper-neighbors";
import {
  buildThemePositionIndex,
  catalogPaperKeys,
  lineageNodeKeys,
  lookupThemePositions,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  themeFocusPath,
} from "../../lib/lineage/theme-position";
import { formatCitationTick, layoutYearCitationTimeline } from "../../lib/lineage/theme-timeline";

type E = { src: string; dst: string; relation: string; confidence: number };
const e = (src: string, dst: string, relation: string, confidence = 0.8): E => ({
  src,
  dst,
  relation,
  confidence,
});

// a(2015) ─extends→ b(2017) ─supersedes→ d(2020) ─extends→ f(2022)
// a ─baseline→ c(2018) ─baseline→ d ;  e(2019) ─baseline→ d ; g isolated
const NODES = [
  { id: "a", title: "A", year: 2015, citation_count: 5000 },
  { id: "b", title: "B", year: 2017, citation_count: 800 },
  { id: "c", title: "C", year: 2018, citation_count: 40 },
  { id: "d", title: "D", year: 2020, citation_count: 300 },
  { id: "e", title: "E", year: 2019, citation_count: 0 },
  { id: "f", title: "F", year: 2022, citation_count: 12 },
  { id: "g", title: "G", year: 2021, citation_count: 3 },
];
const EDGES = [
  e("a", "b", "extends"),
  e("b", "d", "supersedes", 0.9),
  e("d", "f", "extends"),
  e("a", "c", "baseline_only", 0.5),
  e("c", "d", "baseline_only", 0.5),
  e("e", "d", "baseline_only", 0.5),
];

describe("priorDerivative", () => {
  it("lists direct strong relations, then strong chains, then references", () => {
    const r = priorDerivative(NODES, EDGES, "d");
    expect(r.prior.map((i) => [i.id, i.kind, i.hops])).toEqual([
      ["b", "strong", 1],
      ["a", "strong-indirect", 2],
      ["e", "reference", 1],
      ["c", "reference", 1],
    ]);
    // The chain of an indirect ancestor runs from it to the selected paper.
    const a = r.prior.find((i) => i.id === "a");
    expect(a?.chain.map((x) => `${x.src}>${x.dst}`)).toEqual(["a>b", "b>d"]);
    expect(a?.edge.relation).toBe("extends");
    expect(r.derivative.map((i) => [i.id, i.kind])).toEqual([["f", "strong"]]);
  });

  it("follows strong chains downwards for derivatives and ignores reference chains", () => {
    const r = priorDerivative(NODES, EDGES, "a");
    expect(r.prior).toEqual([]);
    expect(r.derivative.map((i) => [i.id, i.kind, i.hops])).toEqual([
      ["b", "strong", 1],
      ["d", "strong-indirect", 2],
      ["f", "strong-indirect", 3],
      ["c", "reference", 1],
    ]);
    expect(r.derivative.find((i) => i.id === "f")?.chain.map((x) => `${x.src}>${x.dst}`)).toEqual([
      "a>b",
      "b>d",
      "d>f",
    ]);
    // maxHops bounds the strong closure.
    expect(priorDerivative(NODES, EDGES, "a", 1).derivative.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("is independent of edge order and empty for unknown or isolated papers", () => {
    const shuffled = [...EDGES].reverse();
    expect(priorDerivative(NODES, shuffled, "d")).toEqual(priorDerivative(NODES, EDGES, "d"));
    expect(priorDerivative(NODES, EDGES, "g")).toEqual({ prior: [], derivative: [] });
    expect(priorDerivative(NODES, EDGES, "zzz")).toEqual({ prior: [], derivative: [] });
  });

  it("treats every relation except baseline_only as strong", () => {
    expect(isStrongRelation("baseline_only")).toBe(false);
    for (const r of ["extends", "supersedes", "successor", "ablation", "contrasts"]) {
      expect(isStrongRelation(r)).toBe(true);
    }
  });
});

describe("shortestLineagePath", () => {
  it("prefers strong relations over a shorter chain of references", () => {
    // a→c→d (two references, cost 4) vs a→b→d (two strong, cost 2).
    const p = shortestLineagePath(NODES, EDGES, "a", "d");
    expect(p?.nodeIds).toEqual(["a", "b", "d"]);
    expect(p?.strongCount).toBe(2);
    expect(p?.cost).toBe(2);
    expect(p?.steps.map((s) => s.direction)).toEqual(["forward", "forward"]);
  });

  it("walks against edge direction (through a common descendant)", () => {
    const p = shortestLineagePath(NODES, EDGES, "e", "b");
    expect(p?.nodeIds).toEqual(["e", "d", "b"]);
    expect(p?.steps.map((s) => s.direction)).toEqual(["forward", "backward"]);
    expect(p?.strongCount).toBe(1);
  });

  it("takes a reference when it is much shorter than the strong detour", () => {
    const nodes = ["x", "m1", "m2", "m3", "y"].map((id, i) => ({ id, year: 2000 + i }));
    const edges = [
      e("x", "m1", "extends"),
      e("m1", "m2", "extends"),
      e("m2", "m3", "extends"),
      e("m3", "y", "extends"),
      e("x", "y", "baseline_only"),
    ];
    expect(shortestLineagePath(nodes, edges, "x", "y")?.nodeIds).toEqual(["x", "y"]);
  });

  it("returns null when not connected and a 0-step path for the same paper", () => {
    expect(shortestLineagePath(NODES, EDGES, "a", "g")).toBeNull();
    expect(shortestLineagePath(NODES, EDGES, "a", "nope")).toBeNull();
    expect(shortestLineagePath(NODES, EDGES, "a", "a")?.steps).toEqual([]);
  });

  it("does not depend on edge order", () => {
    const a = shortestLineagePath(NODES, EDGES, "f", "c");
    const b = shortestLineagePath(NODES, [...EDGES].reverse(), "f", "c");
    expect(a?.nodeIds).toEqual(b?.nodeIds);
    expect(a?.nodeIds).toEqual(["f", "d", "c"]);
  });
});

describe("layoutYearCitationTimeline", () => {
  it("places papers by year (x) and log citations (y), skipping missing years", () => {
    const l = layoutYearCitationTimeline([...NODES, { id: "noyear", year: null }]);
    expect(l.missingYear).toBe(1);
    expect(l.points).toHaveLength(NODES.length);
    const by = new Map(l.points.map((p) => [p.id, p]));
    // Older papers left, more-cited papers higher (smaller y).
    expect((by.get("a")?.x ?? 0) < (by.get("f")?.x ?? 0)).toBe(true);
    expect((by.get("a")?.y ?? 0) < (by.get("d")?.y ?? 0)).toBe(true);
    expect(by.get("e")?.y).toBe(l.plot.bottom);
    for (const p of l.points) {
      expect(p.x).toBeGreaterThanOrEqual(l.plot.left);
      expect(p.x).toBeLessThanOrEqual(l.plot.right);
      expect(p.y).toBeGreaterThanOrEqual(l.plot.top);
      expect(p.y).toBeLessThanOrEqual(l.plot.bottom);
    }
    expect(l.xTicks[0]?.label).toBe("2015");
    expect(l.xTicks.at(-1)?.label).toBe("2022");
    expect(l.yTicks.map((t) => t.label)).toEqual(["0", "10", "100", "1k", "10k"]);
  });

  it("spreads papers of one year sideways, deterministically", () => {
    const nodes = [
      { id: "p", year: 2020, citation_count: 10 },
      { id: "q", year: 2020, citation_count: 10 },
    ];
    const l1 = layoutYearCitationTimeline(nodes);
    const l2 = layoutYearCitationTimeline([...nodes].reverse());
    expect(l1.points[0]?.x).not.toBe(l1.points[1]?.x);
    expect(l1.points).toEqual(l2.points);
  });

  it("handles an empty theme and formats ticks", () => {
    const l = layoutYearCitationTimeline([]);
    expect(l.points).toEqual([]);
    expect(formatCitationTick(1000)).toBe("1k");
    expect(formatCitationTick(2_000_000)).toBe("2M");
  });
});

describe("theme position (系譜での位置)", () => {
  it("normalises arXiv ids, DOIs and OpenAlex ids", () => {
    expect(normalizeArxivId("arXiv:1706.03762v5")).toBe("1706.03762");
    expect(normalizeArxivId("https://arxiv.org/abs/2205.14135")).toBe("2205.14135");
    expect(normalizeArxivId("https://arxiv.org/pdf/2205.14135v2.pdf")).toBe("2205.14135");
    expect(normalizeArxivId("cs/0601001v1")).toBe("cs/0601001");
    expect(normalizeArxivId("")).toBeNull();
    expect(normalizeArxivId("https://proceedings.iclr.cc/x")).toBeNull();
    expect(normalizeDoi("https://doi.org/10.1145/ABC.1")).toBe("10.1145/abc.1");
    expect(normalizeDoi("not-a-doi")).toBeNull();
    expect(normalizeOpenAlexId("https://openalex.org/W123")).toBe("w123");
  });

  it("matches a catalog row to a lineage node by arXiv id, DOI or alias tuple", () => {
    const node = {
      id: "openalex:W42",
      aliases: [
        ["arxiv", "2205.14135"],
        ["doi", "10.48550/arxiv.2205.14135"],
      ],
    };
    const nodeKeys = lineageNodeKeys(node);
    expect(nodeKeys.has("openalex:w42")).toBe(true);
    expect(nodeKeys.has("arxiv:2205.14135")).toBe(true);
    // arXiv id on the catalog row (with a version suffix).
    const k1 = catalogPaperKeys({ arxiv_id: "2205.14135v3", source: "arxiv" });
    expect([...k1].some((k) => nodeKeys.has(k))).toBe(true);
    // ACL Anthology id → derived DOI.
    const aclNode = lineageNodeKeys({
      id: "openalex:W9",
      aliases: [["doi", "10.18653/V1/2025.ACL-LONG.1"]],
    });
    const k2 = catalogPaperKeys({ source: "acl_anthology", source_id: "2025.acl-long.1" });
    expect([...k2].some((k) => aclNode.has(k))).toBe(true);
    // OpenReview identity alias tuple.
    const orNode = lineageNodeKeys({ id: "x", aliases: [["openreview", "AbC123"]] });
    expect(
      [...catalogPaperKeys({ source: "openreview", source_id: "AbC123" })].some((k) =>
        orNode.has(k),
      ),
    ).toBe(true);
    // A proceedings URL in arxiv_url is not an arXiv id.
    expect(catalogPaperKeys({ arxiv_url: "https://proceedings.iclr.cc/p/2025/hash/x" }).size).toBe(
      0,
    );
  });

  it("indexes published themes and summarises the paper's role", () => {
    const index = buildThemePositionIndex([
      {
        slug: "toy",
        theme: "Toy",
        tier: "unaudited",
        artifact: {
          nodes: NODES.map((n) =>
            n.id === "b" ? { ...n, aliases: [["arxiv", "1234.56789"]] } : n,
          ),
          edges: EDGES,
        },
      },
    ]);
    const [pos, ...rest] = lookupThemePositions(index, { arxiv_id: "1234.56789v2" });
    expect(rest).toEqual([]);
    expect(pos).toMatchObject({
      slug: "toy",
      theme: "Toy",
      nodeId: "b",
      tier: "unaudited",
      derivativeCount: 1,
      priorCount: 1,
      strongDerivativeCount: 1,
      derivedBy: { supersedes: 1 },
      buildsOn: { extends: 1 },
      onMainPath: true,
    });
    expect(lookupThemePositions(index, { arxiv_id: "9999.99999" })).toEqual([]);
    expect(lookupThemePositions(null, { arxiv_id: "1234.56789" })).toEqual([]);
    expect(themeFocusPath("toy", "openalex:W1")).toBe("/themes/?theme=toy&focus=openalex%3AW1");
  });

  it("keys every node of the published themes (no crash on real data)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, "..", "..", "..", "..", "data", "published", "themes");
    const slugs = ["graph-neural-network", "flash-attention"];
    for (const slug of slugs) {
      let artifact: { nodes: { id: string }[]; edges: E[] };
      try {
        artifact = JSON.parse(readFileSync(join(path, slug, "lineage.json"), "utf8"));
      } catch {
        continue; // theme renamed or removed: nothing to check
      }
      const index = buildThemePositionIndex([{ slug, theme: slug, artifact }]);
      for (const n of artifact.nodes) {
        expect(lineageNodeKeys(n).size).toBeGreaterThan(0);
      }
      expect(index.size).toBeGreaterThan(0);
    }
  });
});

describe("loadThemePositionIndex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetThemePositionIndexForTests();
  });

  it("fails closed to an empty index when the manifest or quality file is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const index = await loadThemePositionIndex();
    expect(index.size).toBe(0);
    // Memoised: a second call does not fetch again.
    const calls = fetchMock.mock.calls.length;
    await loadThemePositionIndex();
    expect(fetchMock.mock.calls.length).toBe(calls);
    // No theme artifact is fetched without a published quality row.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("lineage.json"))).toBe(false);
  });
});
