/**
 * Tree layout with pruning + grouping -- ported 1:1 from
 * docs/assets/lineage.js `layoutTree`. Pure function: no DOM, no
 * globals. test/lineage/graph/tree.test.ts runs the original
 * `layoutTree` under node:vm against the same inputs and asserts this
 * port produces byte-identical `_x`/`_y` coordinates (same operation
 * order, same `reduce`/`sort` calls, so floats match exactly rather
 * than merely "close enough").
 *
 * Keep this file behaviourally identical to lineage.js's `layoutTree`.
 * If the two diverge, the graph the site renders no longer matches
 * what the original viewer would have drawn for the same artifact.
 */
import type { LineageEdge, LineageNode } from "../core";
import { GENEALOGY, LEVEL_GAP, MAX_DEPTH, NODE_H, NODE_W, PADDING, SIBLING_GAP } from "./constants";

export interface PositionedLineageNode extends LineageNode {
  _x: number;
  _y: number;
  /** Relation connecting this node to the focus branch, or "focus" for
   * the focus node itself. Undefined for a node lineage.js never
   * visited (not returned by `layoutTree` in the first place). */
  _rel?: string;
}

interface ParentRef {
  id: string;
  rel: string;
}

export function layoutTree(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  focusId: string | null,
): PositionedLineageNode[] {
  const parents = new Map<string, ParentRef[]>();
  const children = new Map<string, ParentRef[]>();
  for (const n of nodes) {
    parents.set(n.id, []);
    children.set(n.id, []);
  }
  for (const e of edges) {
    if (!GENEALOGY.has(e.relation)) continue;
    parents.get(e.dst)?.push({ id: e.src, rel: e.relation });
    children.get(e.src)?.push({ id: e.dst, rel: e.relation });
  }

  // BFS bounded by MAX_DEPTH in each direction.
  const level = new Map<string, number>();
  const relToFocus = new Map<string, string>();
  if (focusId === null) return [];
  level.set(focusId, 0);
  relToFocus.set(focusId, "focus");

  const qUp: string[] = [focusId];
  while (qUp.length) {
    const id = qUp.shift() as string;
    if ((level.get(id) ?? 0) <= -MAX_DEPTH) continue;
    for (const { id: p, rel } of parents.get(id) || []) {
      if (!level.has(p)) {
        level.set(p, (level.get(id) ?? 0) - 1);
        relToFocus.set(p, rel);
        qUp.push(p);
      }
    }
  }
  const qDown: string[] = [focusId];
  while (qDown.length) {
    const id = qDown.shift() as string;
    if ((level.get(id) ?? 0) >= MAX_DEPTH) continue;
    for (const { id: c, rel } of children.get(id) || []) {
      if (!level.has(c)) {
        level.set(c, (level.get(id) ?? 0) + 1);
        relToFocus.set(c, rel);
        qDown.push(c);
      }
    }
  }

  // Bucket nodes by level, in `nodes` insertion order (matches the
  // original's `for (const n of nodes)` loop).
  const byLevel = new Map<number, PositionedLineageNode[]>();
  for (const n of nodes) {
    if (!level.has(n.id)) continue;
    const lv = level.get(n.id) as number;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)?.push({ ...n, _rel: relToFocus.get(n.id), _x: 0, _y: 0 });
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  // Position nodes relative to their neighbor at the adjacent level, so
  // siblings sharing a parent cluster together (minimizes crossings).
  const xByNodeId = new Map<string, number>();
  xByNodeId.set(focusId, 0);

  const zeroIdx = sortedLevels.indexOf(0);
  const GAP_X = NODE_W + SIBLING_GAP;

  const positionRow = (
    row: PositionedLineageNode[],
    getPreferredX: (node: PositionedLineageNode) => number,
  ): void => {
    if (row.length === 0) return;
    const withPref = row.map((n) => ({ node: n, pref: getPreferredX(n) }));
    withPref.sort((a, b) => a.pref - b.pref);

    let lastX = -Infinity;
    const temp: { node: PositionedLineageNode; pref: number; x: number }[] = [];
    for (const { node, pref } of withPref) {
      const x = Math.max(pref, lastX + GAP_X);
      temp.push({ node, pref, x });
      lastX = x;
    }
    // Center the row's actual x around the row's preferred-x centroid
    // so tied-preference groups don't all drift to the right.
    const avgPref = temp.reduce((s, t) => s + t.pref, 0) / temp.length;
    const avgActual = temp.reduce((s, t) => s + t.x, 0) / temp.length;
    const shift = avgPref - avgActual;
    for (const t of temp) xByNodeId.set(t.node.id, t.x + shift);
  };

  // Look at ALL already-positioned connected nodes (any level) so gaps
  // in levels don't force unrelated nodes to pile at x=0.
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

  const positioned: PositionedLineageNode[] = [];
  sortedLevels.forEach((lv, idx) => {
    for (const n of byLevel.get(lv) || []) {
      positioned.push({ ...n, _x: xByNodeId.get(n.id) ?? 0, _y: idx * (NODE_H + LEVEL_GAP) });
    }
  });

  if (positioned.length === 0) return [];
  const minX = Math.min(...positioned.map((p) => p._x));
  const minY = Math.min(...positioned.map((p) => p._y));
  for (const p of positioned) {
    p._x = p._x - minX + PADDING;
    p._y = p._y - minY + PADDING;
  }
  return positioned;
}
