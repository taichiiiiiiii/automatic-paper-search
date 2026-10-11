import { describe, expect, it } from "vitest";
import { computeMainPath, MAIN_PATH_RELATION_WEIGHT } from "../../lib/lineage/main-path";

type E = { src: string; dst: string; relation: string; confidence: number };
const edge = (src: string, dst: string, relation = "baseline_only", confidence = 1): E => ({
  src,
  dst,
  relation,
  confidence,
});
const node = (id: string, year: number | null) => ({ id, year });
const ids = (edges: readonly E[]) => edges.map((e) => `${e.src}>${e.dst}`);

describe("computeMainPath (SPC global main path, design 48 P0-1)", () => {
  it("returns nothing for an empty graph", () => {
    expect(computeMainPath([], []).edges).toEqual([]);
    expect(computeMainPath([node("a", 2000)], []).nodeIds).toEqual([]);
  });

  it("counts search paths per edge (textbook diamond)", () => {
    // a → b → d, a → c → d, d → e: 2 source-to-sink paths.
    const nodes = [
      node("a", 2000),
      node("b", 2001),
      node("c", 2001),
      node("d", 2002),
      node("e", 2003),
    ];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("d", "e")];
    const r = computeMainPath(nodes, edges);
    expect(r.spc).toEqual([1, 1, 1, 1, 2]);
    expect(r.nodeIds[0]).toBe("a");
    expect(r.nodeIds.at(-1)).toBe("e");
    expect(r.edges).toHaveLength(3);
  });

  it("prefers the branch made of strong relations", () => {
    const nodes = [node("a", 2000), node("b", 2001), node("c", 2001), node("d", 2002)];
    const edges = [
      edge("a", "b", "baseline_only"),
      edge("b", "d", "baseline_only"),
      edge("a", "c", "extends"),
      edge("c", "d", "supersedes"),
    ];
    expect(ids(computeMainPath(nodes, edges).edges)).toEqual(["a>c", "c>d"]);
    expect(MAIN_PATH_RELATION_WEIGHT.extends).toBeGreaterThan(
      MAIN_PATH_RELATION_WEIGHT.baseline_only ?? 0,
    );
  });

  it("weights by confidence too", () => {
    const nodes = [node("a", 2000), node("b", 2001), node("c", 2001), node("d", 2002)];
    const edges = [
      edge("a", "b", "extends", 0.9),
      edge("b", "d", "extends", 0.9),
      edge("a", "c", "extends", 0.2),
      edge("c", "d", "extends", 0.2),
    ];
    expect(ids(computeMainPath(nodes, edges).edges)).toEqual(["a>b", "b>d"]);
  });

  it("orients a year-inverted edge older → newer and survives same-year cycles", () => {
    const nodes = [node("old", 2010), node("x", 2015), node("y", 2015), node("new", 2020)];
    const edges = [
      edge("new", "old"), // inverted in the data
      edge("x", "y"),
      edge("y", "x"), // same-year cycle
      edge("old", "x"),
      edge("y", "new"),
    ];
    const r = computeMainPath(nodes, edges);
    expect(r.nodeIds[0]).toBe("old");
    expect(r.nodeIds.at(-1)).toBe("new");
    // Every consecutive pair on the path is non-decreasing in year.
    const year = new Map(nodes.map((n) => [n.id, n.year]));
    for (let i = 1; i < r.nodeIds.length; i += 1) {
      expect(year.get(r.nodeIds[i] as string)! >= year.get(r.nodeIds[i - 1] as string)!).toBe(true);
    }
  });

  it("ignores edges whose endpoints are not nodes, and self loops", () => {
    const nodes = [node("a", 2000), node("b", 2001)];
    const r = computeMainPath(nodes, [edge("a", "zz"), edge("a", "a"), edge("a", "b")]);
    expect(ids(r.edges)).toEqual(["a>b"]);
  });

  it("is deterministic regardless of edge order", () => {
    const nodes = [node("a", 2000), node("b", 2001), node("c", 2001), node("d", 2002)];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    const r1 = computeMainPath(nodes, edges);
    const r2 = computeMainPath(nodes, [...edges].reverse());
    expect(ids(r1.edges)).toEqual(ids(r2.edges));
  });

  it("keeps a long chain whole and handles unknown years", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`, i < 29 ? 2000 + i : null));
    const edges = nodes.slice(1).map((n, i) => edge(`n${i}`, n.id));
    expect(computeMainPath(nodes, edges).edges).toHaveLength(29);
  });
});
