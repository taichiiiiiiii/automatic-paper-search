/**
 * Timeline layout (x = year) -- ported 1:1 from docs/assets/lineage.js
 * `layoutTimeline`. Pure function; see tree.ts's header comment for
 * the parity-testing approach (test/lineage/graph/timeline.test.ts
 * runs the original under node:vm against the same inputs).
 *
 * Caveat inherited from the original: `years.sort((a, b) => a - b)`
 * compares `undefined` (a node with no `year`) as `NaN`, which makes
 * the relative order of undefined-year columns among themselves
 * implementation-defined (V8's sort is stable, so it ends up as
 * insertion order in practice, but this is not a contract). Callers
 * that care about a deterministic column order should not feed nodes
 * with a missing `year` into this function.
 */
import type { LineageNode } from "../core";
import { NODE_H, NODE_W, PADDING, SIBLING_GAP } from "./constants";

export interface PositionedTimelineNode extends LineageNode {
  _x: number;
  _y: number;
}

export function layoutTimeline(nodes: readonly LineageNode[]): PositionedTimelineNode[] {
  const sorted = [...nodes].sort((a, b) => (a.year || 0) - (b.year || 0));
  const years = [...new Set(sorted.map((n) => n.year))].sort(
    (a, b) => (a as number) - (b as number),
  );
  const yearToCol = new Map(years.map((y, i) => [y, i]));
  const countsPerYear = new Map(years.map((y) => [y, 0]));

  return sorted.map((n) => {
    const col = yearToCol.get(n.year) as number;
    const row = countsPerYear.get(n.year) as number;
    countsPerYear.set(n.year, row + 1);
    return {
      ...n,
      _x: PADDING + col * (NODE_W + SIBLING_GAP * 2),
      _y: PADDING + row * (NODE_H + 20),
    };
  });
}
