/**
 * #459: how one edge of the family tree is drawn.
 *
 * A theme can have 200+ plain-citation edges; drawn all alike they bury the
 * few strong relations and the main path. Edges are layered (plain citations
 * under strong relations under the main path), plain citations are thin and
 * faint, and pointing at a paper (hover or selection) brings its own edges
 * forward and fades the rest.
 */

export interface EdgeStyleInput {
  relation: string;
  confidence: number;
  influential: boolean;
  selected: boolean;
  onMain: boolean;
  onPath: boolean;
  showMainPath: boolean;
  /** The paper under the pointer / selected, if any. */
  focusId: string | null;
  src: string;
  dst: string;
}

export interface EdgeStyle {
  width: number;
  opacity: number;
}

/** Draw order: plain citations first (bottom), strong relations, then the main path. */
export function edgeLayer(relation: string, onMain: boolean): 0 | 1 | 2 {
  if (onMain) return 2;
  return relation === "baseline_only" ? 0 : 1;
}

export function edgeStyle(i: EdgeStyleInput): EdgeStyle {
  const plain = i.relation === "baseline_only";
  const base = i.influential ? 3 : Math.max(1, i.confidence * 2);
  const baseWidth = plain && !i.influential ? 1 : base;
  if (i.selected) return { width: i.onMain || i.onPath ? 7 : 4, opacity: 1 };
  if (i.onPath) return { width: 6, opacity: 1 };
  if (i.onMain) return { width: 5, opacity: 1 };
  if (i.focusId !== null) {
    const touches = i.src === i.focusId || i.dst === i.focusId;
    if (touches) return { width: Math.max(2, baseWidth + 1), opacity: 1 };
    return { width: baseWidth, opacity: plain ? 0.05 : 0.2 };
  }
  if (i.showMainPath) return { width: baseWidth, opacity: plain ? 0.18 : 0.45 };
  if (plain) return { width: baseWidth, opacity: i.influential ? 0.55 : 0.28 };
  return { width: baseWidth, opacity: 0.9 };
}
