// R4-5: crowded years wrap onto several lines inside their year band.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";
import {
  computeOrphanSet,
  FIT_ZOOM_FLOOR_NARROW,
  FIT_ZOOM_FLOOR_WIDE,
  LINE_GAP,
  layoutChronological,
  maxCardsPerLine,
  NODE_H,
  NODE_W,
  ROW_GAP,
  SIBLING_GAP,
  treeWidthFor,
  X_AXIS_MODES,
} from "../../lib/themes-tree";

function node(id: string, year: number, citation_count: number): LineageNode {
  return { id, year, citation_count, is_focus: false };
}
function edge(src: string, dst: string): LineageEdge {
  return { src, dst, relation: "extends", confidence: 0.9, rationale: "r" } as LineageEdge;
}

// 2020: 2 papers, 2021: 7 papers (wraps at 3 -> 3 lines).
const nodes: LineageNode[] = [
  node("a", 2020, 50),
  node("b", 2020, 10),
  ...Array.from({ length: 7 }, (_, i) => node(`c${i}`, 2021, 100 - i)),
];
const edges: LineageEdge[] = [edge("a", "c3"), edge("b", "c0"), edge("a", "c6")];

const order = (r: ReturnType<typeof layoutChronological>, year: number) =>
  [...r.positioned.filter((p) => p.year === year)]
    .sort((p, q) => p._y - q._y || p._x - q._x)
    .map((p) => p.id);

describe("layoutChronological wrapping", () => {
  it("without a cap is the unwrapped layout (one line per year)", () => {
    const a = layoutChronological(nodes, edges, "rank");
    const b = layoutChronological(nodes, edges, "rank", { maxPerLine: Number.POSITIVE_INFINITY });
    expect(b).toEqual(a);
    expect(a.perLine).toBe(7);
    expect(a.totalW).toBe(treeWidthFor(7));
    expect(a.yearLabels.every((l) => l.lines === 1)).toBe(true);
    expect(a.totalH).toBe(56 + 2 * (NODE_H + ROW_GAP) + 56);
  });

  it("wraps a year row-major into lines of at most maxPerLine, keeping the order", () => {
    for (const mode of X_AXIS_MODES) {
      const flat = layoutChronological(nodes, edges, mode);
      const wrapped = layoutChronological(nodes, edges, mode, { maxPerLine: 3 });
      expect(order(wrapped, 2021), mode).toEqual(order(flat, 2021));
      expect(order(wrapped, 2020), mode).toEqual(order(flat, 2020));
    }
    const r = layoutChronological(nodes, edges, "rank", { maxPerLine: 3 });
    expect(r.perLine).toBe(3);
    expect(r.totalW).toBe(treeWidthFor(3));
    const row = r.positioned.filter((p) => p.year === 2021);
    const ys = [...new Set(row.map((p) => p._y))].sort((a, b) => a - b);
    expect(ys).toHaveLength(3);
    expect(ys[1]! - ys[0]!).toBe(NODE_H + LINE_GAP);
    // Columns line up across lines.
    const xs = [...new Set(row.map((p) => p._x))];
    expect(xs).toHaveLength(3);
    for (const p of r.positioned) expect(p._x + NODE_W).toBeLessThanOrEqual(r.totalW);
  });

  it("describes each year band (top/bottom/count/lines) and stacks bands without overlap", () => {
    const r = layoutChronological(nodes, edges, "rank", { maxPerLine: 3 });
    const [y2020, y2021] = r.yearLabels;
    expect(y2020).toMatchObject({ label: "2020", count: 2, lines: 1 });
    expect(y2021).toMatchObject({ label: "2021", count: 7, lines: 3 });
    expect(y2020!.bottom - y2020!.top).toBe(NODE_H);
    expect(y2021!.bottom - y2021!.top).toBe(3 * NODE_H + 2 * LINE_GAP);
    expect(y2021!.top).toBe(y2020!.bottom + ROW_GAP);
    // The label sits on the band's first line.
    expect(y2021!.y).toBe(y2021!.top + NODE_H / 2);
    for (const p of r.positioned) {
      const band = r.yearLabels.find((l) => l.label === String(p.year))!;
      expect(p._y).toBeGreaterThanOrEqual(band.top);
      expect(p._y + NODE_H).toBeLessThanOrEqual(band.bottom);
    }
    expect(r.totalH).toBe(y2021!.bottom + ROW_GAP + 56);
  });
});

describe("maxCardsPerLine", () => {
  it("no width -> no wrapping", () => {
    expect(maxCardsPerLine(0)).toBe(Number.POSITIVE_INFINITY);
    expect(maxCardsPerLine(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });
  it("keeps the fit zoom above the floor on a phone and on a desktop", () => {
    for (const w of [300, 341, 375, 414, 639, 640, 768, 1024, 1230, 1600]) {
      const n = maxCardsPerLine(w);
      expect(n).toBeGreaterThanOrEqual(1);
      const fit = (w - 8) / treeWidthFor(n);
      const floor = w < 640 ? FIT_ZOOM_FLOOR_NARROW : FIT_ZOOM_FLOOR_WIDE;
      if (n > 1) expect(fit, `w=${w}`).toBeGreaterThanOrEqual(floor);
      // ...and is not needlessly narrow: one more card would drop below the target.
      const fitMore = (w - 8) / treeWidthFor(n + 1);
      expect(fitMore, `w=${w}`).toBeLessThan(w < 640 ? 0.42 : 0.62);
    }
    expect(maxCardsPerLine(341)).toBe(2); // 375px phone
    expect(maxCardsPerLine(1230)).toBe(6); // 1280px desktop
    expect(NODE_W + SIBLING_GAP).toBe(288);
  });
});

describe("published themes stay readable after 全体", () => {
  const dir = join(__dirname, "../../../../data/published/themes");
  const slugs = JSON.parse(readFileSync(join(dir, "themes-manifest.json"), "utf8")) as unknown;
  const list = (
    Array.isArray(slugs) ? slugs : ((slugs as { themes?: unknown[] }).themes ?? [])
  ) as Array<{ slug: string }>;
  it("has published themes", () => {
    expect(list.length).toBeGreaterThan(0);
  });
  for (const { slug } of list) {
    it(`${slug}: fit zoom >= floor at 375px and 1280px`, () => {
      const art = JSON.parse(readFileSync(join(dir, slug, "lineage.json"), "utf8")) as {
        nodes: LineageNode[];
        edges: LineageEdge[];
      };
      const orphans = computeOrphanSet(art.nodes, art.edges);
      const shown = art.nodes.filter((n) => !orphans.has(n.id));
      for (const [box, floor] of [
        [341, FIT_ZOOM_FLOOR_NARROW],
        [1230, FIT_ZOOM_FLOOR_WIDE],
      ] as const) {
        for (const set of [shown, art.nodes]) {
          const r = layoutChronological(set, art.edges, "rank", {
            maxPerLine: maxCardsPerLine(box),
          });
          expect(Math.min(1, (box - 8) / r.totalW)).toBeGreaterThanOrEqual(floor);
        }
      }
    });
  }
});
