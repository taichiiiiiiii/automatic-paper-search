import { describe, expect, it } from "vitest";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";
import { layoutChronological, planYearLines, sameYearDepths } from "../../lib/themes-tree";

const n = (id: string, year: number): LineageNode =>
  ({ id, title: id, year, is_focus: false, citation_count: 1 }) as LineageNode;
const e = (src: string, dst: string, relation = "extends"): LineageEdge =>
  ({ src, dst, relation, confidence: 0.8, rationale: "" }) as LineageEdge;

describe("same-year line order (#461)", () => {
  it("puts a citing paper on a later line than the same-year paper it cites", () => {
    const nodes = [n("b", 2023), n("a", 2023), n("c", 2023)];
    const edges = [e("a", "b"), e("b", "c")];
    const plan = planYearLines(nodes, edges, 12);
    const line = new Map(plan.ordered.map((x, i) => [x.id, plan.lineOf[i]]));
    expect(line.get("a")).toBe(0);
    expect(line.get("b")).toBe(1);
    expect(line.get("c")).toBe(2);
    expect(plan.lines).toBe(3);
  });

  it("is cycle-safe and leaves a year without relations as one wrapped row", () => {
    const cyc = planYearLines([n("a", 2023), n("b", 2023)], [e("a", "b"), e("b", "a")], 12);
    expect(cyc.lines).toBeGreaterThanOrEqual(1);
    const nodes = ["a", "b", "c", "d", "e"].map((id) => n(id, 2023));
    const plain = planYearLines(nodes, [e("a", "b", "baseline_only")], 2);
    expect(plain.lines).toBe(3); // 5 cards, 2 per line, plain citations do not constrain
    expect(plain.lineOf).toEqual([0, 0, 1, 1, 2]);
  });

  it("plain citations do not chain a year into one column", () => {
    const nodes = ["a", "b", "c"].map((id) => n(id, 2023));
    const depth = sameYearDepths(nodes, [
      e("a", "b", "baseline_only"),
      e("b", "c", "baseline_only"),
    ]);
    expect([...depth.values()]).toEqual([0, 0, 0]);
  });

  it("no relation edge runs upward or sideways in the laid-out tree", () => {
    const nodes = [n("a", 2022), n("b", 2023), n("c", 2023), n("d", 2023), n("f", 2024)];
    const edges = [
      e("a", "b"),
      e("b", "c"),
      e("c", "d", "contrasts"),
      e("d", "f"),
      e("a", "d", "baseline_only"),
    ];
    const r = layoutChronological(nodes, edges, "genealogy", { maxPerLine: 12 });
    const y = new Map(r.positioned.map((p) => [p.id, p._y]));
    for (const ed of edges.filter((x) => x.relation !== "baseline_only")) {
      expect(y.get(ed.dst) as number).toBeGreaterThan(y.get(ed.src) as number);
    }
  });
});
