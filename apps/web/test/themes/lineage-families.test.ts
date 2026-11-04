import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectFamilies,
  familyLabel,
  initialFamily,
  readFamilyParam,
} from "../../lib/themes-families";

const THEMES = join(__dirname, "../../../../data/published/themes");
type A = {
  nodes: { id: string; title?: string; year?: number; citation_count?: number }[];
  edges: { src: string; dst: string }[];
  meta: { seeds?: string[] };
};
const load = (slug: string): A =>
  JSON.parse(readFileSync(join(THEMES, slug, "lineage.json"), "utf8"));
const slugs = readdirSync(THEMES).filter((s) => {
  try {
    load(s);
    return true;
  } catch {
    return false;
  }
});

describe("detectFamilies on the published themes (#483)", () => {
  it("finds no second family in single-sense themes", () => {
    for (const slug of slugs.filter((s) => s !== "state-space-models")) {
      const a = load(slug);
      expect(detectFamilies(a.nodes, a.edges, a.meta.seeds ?? []), slug).toBeNull();
    }
  });
  it.runIf(slugs.includes("state-space-models"))(
    "splits State Space Models into two families and keeps every paper",
    () => {
      const a = load("state-space-models");
      const fams = detectFamilies(a.nodes, a.edges, a.meta.seeds ?? []);
      expect(fams).not.toBeNull();
      expect(fams?.length).toBe(2);
      const total = (fams ?? []).reduce((n, f) => n + f.size, 0);
      expect(total).toBe(a.nodes.length);
      expect((fams?.[1]?.yearMin ?? 9999) < (fams?.[0]?.yearMin ?? 0)).toBe(true); // the older sense is the smaller family
    },
  );
});

describe("detectFamilies (synthetic)", () => {
  const chain = (p: string, n: number) =>
    Array.from({ length: n - 1 }, (_, i) => ({ src: `${p}${i}`, dst: `${p}${i + 1}` }));
  const nodes = (p: string, n: number, y: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${p}${i}`,
      title: `${p}${i}`,
      year: y + i,
      citation_count: i,
    }));
  it("splits two communities joined only by a seed", () => {
    const ns = [
      ...nodes("a", 12, 2020),
      ...nodes("b", 8, 1990),
      { id: "s", title: "S", year: 2010 },
    ];
    const es = [
      ...chain("a", 12),
      ...chain("b", 8),
      { src: "s", dst: "a0" },
      { src: "s", dst: "a1" },
      { src: "s", dst: "b0" },
    ];
    const fams = detectFamilies(ns, es, ["s"]);
    expect(fams?.map((f) => f.size)).toEqual([13, 8]); // bridge joins the side it has more edges into
    expect(familyLabel(fams?.[1] as never)).toContain("ほか 8 本（1990–1997）");
  });
  it("ignores a split-off group below 5 papers / 10%", () => {
    const ns = [...nodes("a", 20, 2020), ...nodes("b", 3, 1990), { id: "s" }];
    const es = [
      ...chain("a", 20),
      ...chain("b", 3),
      { src: "s", dst: "a0" },
      { src: "s", dst: "b0" },
    ];
    expect(detectFamilies(ns, es, ["s"])).toBeNull();
  });
  it("needs the split to come from removing a seed", () => {
    const ns = [...nodes("a", 12, 2020), ...nodes("b", 8, 1990), { id: "x" }];
    const es = [
      ...chain("a", 12),
      ...chain("b", 8),
      { src: "x", dst: "a0" },
      { src: "x", dst: "b0" },
    ];
    expect(detectFamilies(ns, es, ["a11"])).toBeNull(); // an end-of-chain seed splits nothing
  });
});

describe("family URL state", () => {
  const fams = [
    { index: 1, nodeIds: new Set(["a"]), size: 1, yearMin: null, yearMax: null, anchorTitle: "A" },
    { index: 2, nodeIds: new Set(["b"]), size: 1, yearMin: null, yearMax: null, anchorTitle: "B" },
  ];
  it("reads ?fam= within range only", () => {
    expect(readFamilyParam("?fam=0", 2)).toBe(0);
    expect(readFamilyParam("?fam=3", 2)).toBeNull();
    expect(readFamilyParam("?fam=x", 2)).toBeNull();
  });
  it("opens the family of a permalinked paper, else the largest", () => {
    expect(initialFamily(fams, "?node=b")).toBe(2);
    expect(initialFamily(fams, "")).toBe(1);
    expect(initialFamily(fams, "?fam=0&node=b")).toBe(0);
  });
});
