/**
 * R2-31 (design 41): proceedings-year correction and chronology-inversion
 * guard, on a recorded slice of the published GNN lineage (2026-10-11,
 * R2-29 second review: W4322614756 is a mixed OpenAlex record; Gori et
 * al. IJCNN 2005 is shown as 2006). Synthetic copies only — the published
 * file itself is never asserted on (it changes when themes regenerate).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  arxivIdYear,
  chronologyInversions,
  correctProceedingsYears,
  earliestYear,
  ieeeProceedingsDoiYear,
  mergeSuspects,
} from "../../../src/lineage/theme/recordChronology.js";

type Node = Record<string, unknown> & { id: string };
type Edge = { src: string; dst: string; relation: string; rationale: string };
interface Fixture {
  focus: string[];
  nodes: Node[];
  edges: Edge[];
  dblp: Record<string, { year: number | null; key: string | null }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const load = (): Fixture =>
  JSON.parse(readFileSync(join(here, "fixtures/record-chronology-r231.json"), "utf8"));

const MIXED = "openalex:W4322614756";
const GORI = "openalex:W1501856433";
const ARMA = "openalex:W2912636151";
const GCN = "openalex:W2519887557";

describe("R2-31 helpers", () => {
  it("dates arXiv ids and IEEE proceedings DOIs", () => {
    expect(arxivIdYear("1901.01343")).toBe(2019);
    expect(arxivIdYear("2106.05974v2")).toBe(2021);
    expect(arxivIdYear("cs/0601001")).toBe(2006);
    expect(arxivIdYear("hep-th/9901001")).toBe(1999);
    expect(arxivIdYear("not-an-id")).toBeNull();
    expect(ieeeProceedingsDoiYear("10.1109/ijcnn.2005.1555942")).toBe(2005);
    expect(ieeeProceedingsDoiYear("10.1109/cvpr.2017.753")).toBe(2017);
    expect(ieeeProceedingsDoiYear("10.1145/3219819.3220007")).toBeNull();
    expect(ieeeProceedingsDoiYear("10.4230/lipics.giscience.2025.9")).toBeNull();
  });

  it("earliest year takes the arXiv preprint when it is earlier (ARMA: TPAMI 2021, arXiv 2019)", () => {
    const fx = load();
    const arma = fx.nodes.find((n) => n.id === ARMA) as Node;
    expect(earliestYear(arma)).toBe(2019);
  });
});

describe("R2-31 proceedings year (Gori et al. IJCNN)", () => {
  it("2006 -> 2005 from the IEEE proceedings DOI; the edge rationales follow", () => {
    const fx = load();
    const nodes = new Map(fx.nodes.map((n) => [n.id, n]));
    const before = fx.edges.filter((e) => e.src === GORI || e.dst === GORI);
    expect(before.some((e) => e.rationale.includes("」(2006)"))).toBe(true);
    const out = correctProceedingsYears(nodes, fx.edges, { dblp: fx.dblp });
    expect(out).toEqual([
      {
        id: GORI,
        title: "A new model for learning in graph domains",
        from: 2006,
        to: 2005,
        source: "ieee_doi",
      },
    ]);
    expect(nodes.get(GORI)?.year).toBe(2005);
    for (const e of fx.edges.filter((x) => x.src === GORI || x.dst === GORI)) {
      expect(e.rationale).not.toMatch(/「A new model[^」]*」\(2006\)/);
      expect(e.rationale).toMatch(/「A new model[^」]*」\(2005\)/);
    }
  });

  it("an arXiv-first paper keeps its preprint year (GCN: arXiv 2016, DBLP ICLR 2017)", () => {
    const fx = load();
    const nodes = new Map(fx.nodes.map((n) => [n.id, n]));
    correctProceedingsYears(nodes, fx.edges, { dblp: fx.dblp });
    expect(nodes.get(GCN)?.year).toBe(2016);
  });

  it("a DBLP conference year one off corrects a node without an arXiv id", () => {
    const n: Node = { id: "x", title: "Some proceedings paper", year: 2019, venue: "WWW" };
    const out = correctProceedingsYears([n], [], {
      dblp: { x: { year: 2018, key: "conf/www/Someone18" } },
    });
    expect(out[0]?.source).toBe("dblp");
    expect(n.year).toBe(2018);
  });

  it("does not touch a gap of two or more years, journals, or non-IEEE DOIs", () => {
    const far: Node = {
      id: "a",
      title: "Far",
      year: 2008,
      venue: "IEEE International Joint Conference on Neural Networks",
      doi: "10.1109/ijcnn.2005.1",
    };
    const journal: Node = {
      id: "b",
      title: "Journal",
      year: 2022,
      venue: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
      doi: "10.1109/tpami.2021.3054830",
    };
    const dblpJournal: Node = { id: "c", title: "J", year: 2021, venue: "JMLR" };
    const out = correctProceedingsYears([far, journal, dblpJournal], [], {
      dblp: { c: { year: 2022, key: "journals/jmlr/X22" } },
    });
    expect(out).toEqual([]);
    expect([far.year, journal.year, dblpJournal.year]).toEqual([2008, 2022, 2021]);
  });
});

describe("R2-31 chronology inversion (mixed OpenAlex records)", () => {
  it("drops W4322614756 (2025 title, cited by ARMA 2021) and nothing else of the slice", () => {
    const fx = load();
    const nodes = new Map(fx.nodes.map((n) => [n.id, n]));
    const out = chronologyInversions(nodes, fx.edges, { focusIds: new Set(fx.focus) });
    expect(out).toEqual([
      {
        id: MIXED,
        title:
          "Identifying Resilient Communities in Road Networks: A Path-Based Embedding Approach",
        reasons: ["chronology_inversion:1/1@4"],
        action: "dropped",
      },
    ]);
  });

  it("a focus node is only flagged", () => {
    const fx = load();
    const out = chronologyInversions(fx.nodes, fx.edges, { focusIds: new Set([MIXED]) });
    expect(out.find((s) => s.id === MIXED)?.action).toBe("flagged");
  });

  it("a journal version cited as a preprint is not an inversion (arXiv year counts)", () => {
    const nodes: Node[] = [
      { id: "j", title: "Journal version", year: 2022, arxiv_id: "1905.00001" },
      { id: "c1", title: "Citer 1", year: 2019 },
      { id: "c2", title: "Citer 2", year: 2020 },
    ];
    const edges = [
      { src: "j", dst: "c1" },
      { src: "j", dst: "c2" },
    ];
    expect(chronologyInversions(nodes, edges)).toEqual([]);
  });

  it("one inverted citer by two years among several is only flagged", () => {
    const nodes: Node[] = [
      { id: "n", title: "Late venue version", year: 2021 },
      { id: "c1", title: "Early citer", year: 2019 },
      { id: "c2", title: "Later citer", year: 2022 },
      { id: "c3", title: "Later citer 2", year: 2023 },
    ];
    const edges = ["c1", "c2", "c3"].map((d) => ({ src: "n", dst: d }));
    const out = chronologyInversions(nodes, edges);
    expect(out).toEqual([
      {
        id: "n",
        title: "Late venue version",
        reasons: ["chronology_inversion:1/3@2"],
        action: "flagged",
      },
    ]);
  });

  it("merges with the identity guard's record for the same node (drop wins)", () => {
    const merged = mergeSuspects(
      [{ id: MIXED, title: "t", reasons: ["young_high_citations:1570@2025"], action: "flagged" }],
      [{ id: MIXED, title: "t", reasons: ["chronology_inversion:1/1@4"], action: "dropped" }],
    );
    expect(merged).toEqual([
      {
        id: MIXED,
        title: "t",
        reasons: ["young_high_citations:1570@2025", "chronology_inversion:1/1@4"],
        action: "dropped",
      },
    ]);
  });
});
