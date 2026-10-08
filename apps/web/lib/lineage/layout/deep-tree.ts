/**
 * Deep-lineage tree layout -- ported 1:1 from docs/assets/deep.js
 * `layoutTree`. Deliberately a SEPARATE module from
 * lib/lineage/layout/tree.ts (the conference lineage viewer's own
 * `layoutTree`), not a parameterized variant of it, because the two
 * originals differ in ways a shared function could not express without
 * becoming "lineage.js's layoutTree with some flags" -- which is not
 * what deep.js actually does:
 *
 *  - Card size/spacing constants are deep.js's own (240×180 cards,
 *    100px level gap, 32px sibling gap, 48px padding) -- NOT
 *    lineage.js's 220×150/80/28/40. Deep's cards carry more metadata
 *    (3 authors, a TLDR, a citation count) so they are taller and
 *    wider.
 *  - lineage.js's BFS is bounded to MAX_DEPTH=3 each direction; deep.js
 *    has NO depth cap at all -- "for deep mode, show everything
 *    reachable" (the whole point of the "deep" viewer is the full
 *    multi-hop family tree for one paper, not a bounded neighbourhood).
 *  - lineage.js's parent/child maps walk GENEALOGY edges only
 *    (supersedes/successor/extends/ablation); deep.js's walk
 *    GENEALOGY **plus** `contrasts` and `baseline_only` -- comparison
 *    edges participate in the BFS itself here, not just in what gets
 *    drawn once nodes are already positioned.
 *
 * Pure function: no DOM, no globals. test/lineage/graph/deep-tree.test.ts
 * runs the original `layoutTree` from docs/assets/deep.js under
 * node:vm against the same inputs and asserts this port produces
 * byte-identical `_x`/`_y` coordinates.
 *
 * Keep this file behaviourally identical to deep.js's `layoutTree`. If
 * the two diverge, the graph this page renders no longer matches what
 * the original deep viewer would have drawn for the same artifact.
 */
import type { LineageEdge, LineageNode, Relation } from "../core";

export const DEEP_NODE_W = 240;
export const DEEP_NODE_H = 180;
export const DEEP_LEVEL_GAP = 100;
export const DEEP_SIBLING_GAP = 32;
export const DEEP_PADDING = 48;

/** Relations lineage.js's `GENEALOGY` set also has (supersedes,
 * successor, extends, ablation) -- deep.js reuses the same constant
 * name/value. Kept local rather than imported from
 * lib/lineage/layout/constants.ts so this module never needs an edit
 * there to add deep's extra two relations below. */
const GENEALOGY = new Set<Relation>(["supersedes", "successor", "extends", "ablation"]);

export interface PositionedDeepNode extends LineageNode {
  _x: number;
  _y: number;
}

interface ParentRef {
  id: string;
  rel: Relation;
}

/** Ported from deep.js's edge-walk guard:
 * `if (!GENEALOGY.has(e.relation) && e.relation !== "contrasts" && e.relation !== "baseline_only") continue;`
 * i.e. every relation EXCEPT this condition participates -- which is
 * every relation there is, since `Relation` only has these six values.
 * Spelled out as its own predicate (rather than "always true") to keep
 * the port legible against the original's exact condition. */
function deepWalksRelation(relation: Relation): boolean {
  return GENEALOGY.has(relation) || relation === "contrasts" || relation === "baseline_only";
}

export function layoutDeepTree(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  focusId: string | null,
): PositionedDeepNode[] {
  const parents = new Map<string, ParentRef[]>();
  const children = new Map<string, ParentRef[]>();
  for (const n of nodes) {
    parents.set(n.id, []);
    children.set(n.id, []);
  }
  for (const e of edges) {
    if (!deepWalksRelation(e.relation)) continue;
    parents.get(e.dst)?.push({ id: e.src, rel: e.relation });
    children.get(e.src)?.push({ id: e.dst, rel: e.relation });
  }

  if (focusId === null) return [];
  const level = new Map<string, number>();
  level.set(focusId, 0);

  // Unbounded BFS in both directions -- deep mode shows everything
  // reachable, with no MAX_DEPTH cap (unlike lineage.js's layoutTree).
  const qUp: string[] = [focusId];
  while (qUp.length) {
    const id = qUp.shift() as string;
    for (const { id: p } of parents.get(id) || []) {
      if (!level.has(p)) {
        level.set(p, (level.get(id) as number) - 1);
        qUp.push(p);
      }
    }
  }
  const qDown: string[] = [focusId];
  while (qDown.length) {
    const id = qDown.shift() as string;
    for (const { id: c } of children.get(id) || []) {
      if (!level.has(c)) {
        level.set(c, (level.get(id) as number) + 1);
        qDown.push(c);
      }
    }
  }

  const byLevel = new Map<number, PositionedDeepNode[]>();
  for (const n of nodes) {
    if (!level.has(n.id)) continue;
    const lv = level.get(n.id) as number;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)?.push({ ...n, _x: 0, _y: 0 });
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const zeroIdx = sortedLevels.indexOf(0);
  const GAP_X = DEEP_NODE_W + DEEP_SIBLING_GAP;

  const xByNodeId = new Map<string, number>();
  xByNodeId.set(focusId, 0);

  const positionRow = (
    row: PositionedDeepNode[],
    getPreferredX: (node: PositionedDeepNode) => number,
  ): void => {
    if (row.length === 0) return;
    const withPref = row.map((n) => ({ node: n, pref: getPreferredX(n) }));
    withPref.sort((a, b) => a.pref - b.pref);

    let lastX = -Infinity;
    const temp: { node: PositionedDeepNode; pref: number; x: number }[] = [];
    for (const { node, pref } of withPref) {
      const x = Math.max(pref, lastX + GAP_X);
      temp.push({ node, pref, x });
      lastX = x;
    }
    const avgPref = temp.reduce((s, t) => s + t.pref, 0) / temp.length;
    const avgActual = temp.reduce((s, t) => s + t.x, 0) / temp.length;
    const shift = avgPref - avgActual;
    for (const t of temp) xByNodeId.set(t.node.id, t.x + shift);
  };

  for (let i = zeroIdx - 1; i >= 0; i--) {
    const row = byLevel.get(sortedLevels[i] as number) || [];
    positionRow(row, (node) => {
      const xs: number[] = [];
      for (const { id } of children.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id) as number);
      }
      for (const { id } of parents.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id) as number);
      }
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }
  for (let i = zeroIdx + 1; i < sortedLevels.length; i++) {
    const row = byLevel.get(sortedLevels[i] as number) || [];
    positionRow(row, (node) => {
      const xs: number[] = [];
      for (const { id } of parents.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id) as number);
      }
      for (const { id } of children.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id) as number);
      }
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }

  const positioned: PositionedDeepNode[] = [];
  sortedLevels.forEach((lv, idx) => {
    for (const n of byLevel.get(lv) || []) {
      positioned.push({
        ...n,
        _x: xByNodeId.get(n.id) ?? 0,
        _y: idx * (DEEP_NODE_H + DEEP_LEVEL_GAP),
      });
    }
  });
  if (positioned.length === 0) return [];
  const minX = Math.min(...positioned.map((p) => p._x));
  const minY = Math.min(...positioned.map((p) => p._y));
  for (const p of positioned) {
    p._x = p._x - minX + DEEP_PADDING;
    p._y = p._y - minY + DEEP_PADDING;
  }
  return positioned;
}
