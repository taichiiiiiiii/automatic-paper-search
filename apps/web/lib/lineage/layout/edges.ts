/**
 * Edge geometry for the SVG graph -- `fanOffsets` and `edgeStyle` are
 * ported 1:1 from docs/assets/utils.js (`PP.fanOffsets`, `PP.edgeStyle`,
 * shared by all three family-tree viewers). `buildEdgePath` and
 * `computeSvgSize` are new pure helpers that replace the DOM-measuring
 * parts of docs/assets/lineage.js `drawSvg` (bezier `d` string, label
 * midpoint, overall canvas size) with something a component can call
 * without touching the DOM.
 *
 * `heightOf` defaults every node to the static NODE_H so this module
 * stays pure and testable without a DOM; the real measured heights
 * (ported from the original's post-font-load `getBoundingClientRect`
 * pass) are threaded in by
 * components/lineage/graph/lineage-graph-app.tsx through
 * lib/lineage/layout/view-model.ts's `buildGraph`, so an edge lands on
 * the card's actual rendered bottom instead of the static slot once
 * fonts have settled -- see that file for the DOM side.
 *
 * `buildEdgePath`/`computeSvgSize` take optional `nodeW`/`padding`
 * overrides (defaulting to this module's own NODE_W/PADDING) so
 * lib/lineage/layout/deep-view-model.ts can reuse the exact same
 * bezier/canvas-size math with deep.js's own 240×180 card dimensions
 * instead of duplicating it -- deep.js's `drawSvg` edge loop and this
 * file's are otherwise identical. Every existing call site keeps
 * calling these with no override, so the lineage viewer's own geometry
 * is unaffected.
 */
import type { LineageEdge } from "../core";
import { NODE_H, NODE_W, PADDING } from "./constants";

interface PositionedLike {
  id: string;
  _x: number;
  _y: number;
}

const REL_EDGE_WEIGHT: Record<string, { w: number; op: number }> = {
  supersedes: { w: 1.0, op: 1.0 },
  successor: { w: 1.0, op: 1.0 },
  contrasts: { w: 0.9, op: 0.95 },
  ablation: { w: 0.7, op: 0.84 },
  baseline: { w: 0.7, op: 0.82 },
  extends: { w: 0.62, op: 0.76 },
};
const EDGE_MIN_WIDTH = 0.9;

export interface EdgeStyle {
  opacity: string;
  width: string;
}

/** Ported from `PP.edgeStyle`. `markerClassName` is the CSS-class
 * relation (`baseline_only` is also accepted and normalized to
 * "baseline", matching the original's `if (mc === "baseline_only")`
 * guard for callers that pass the raw relation). Returns `null` when
 * `conf` isn't numeric, so the caller keeps a CSS/attribute fallback. */
export function edgeStyle(markerClassName: string, conf: unknown): EdgeStyle | null {
  if (typeof conf !== "number") return null;
  const mc = markerClassName === "baseline_only" ? "baseline" : markerClassName;
  const k = REL_EDGE_WEIGHT[mc] || { w: 0.85, op: 0.92 };
  return {
    opacity: ((0.5 + conf * 0.5) * k.op).toFixed(3),
    width: Math.max((1 + conf * 1.5) * k.w, EDGE_MIN_WIDTH).toFixed(2),
  };
}

const EDGE_FAN_STEP = 18;
const EDGE_FAN_MAX_FRAC = 0.55;

/** Ported from `PP.fanOffsets`. Spreads each parent's outgoing edges
 * across the bottom of its card (ordered left-to-right by child x) so
 * multiple children don't all radiate from one point. Returns a Map
 * keyed by the same edge object references passed in `edges`. */
export function fanOffsets(
  edges: readonly LineageEdge[],
  posById: ReadonlyMap<string, PositionedLike>,
  nodeW: number,
): Map<LineageEdge, number> {
  const bySrc = new Map<string, LineageEdge[]>();
  for (const e of edges) {
    if (!posById.has(e.src) || !posById.has(e.dst)) continue;
    if (!bySrc.has(e.src)) bySrc.set(e.src, []);
    bySrc.get(e.src)?.push(e);
  }
  const out = new Map<LineageEdge, number>();
  for (const group of bySrc.values()) {
    group.sort((p, q) => {
      const pDst = posById.get(p.dst) as PositionedLike;
      const qDst = posById.get(q.dst) as PositionedLike;
      return pDst._x - qDst._x;
    });
    const n = group.length;
    const span = Math.min(nodeW * EDGE_FAN_MAX_FRAC, (n - 1) * EDGE_FAN_STEP);
    group.forEach((e, i) => {
      out.set(e, n > 1 ? (i / (n - 1) - 0.5) * span : 0);
    });
  }
  return out;
}

export interface EdgeGeometry {
  /** SVG path `d` attribute: a cubic bezier from the parent card's
   * bottom-center (offset by the fan-out) to the child card's
   * top-center. */
  d: string;
  labelX: number;
  labelY: number;
}

/** Replaces the inline bezier-building code in lineage.js `drawSvg`'s
 * edge loop. `heightOf` defaults to the static NODE_H for every node
 * (see module header for the measured-height parity gap). */
export function buildEdgePath(
  a: PositionedLike,
  b: PositionedLike,
  fanOffset: number,
  heightOf: (node: PositionedLike) => number = () => NODE_H,
  nodeW: number = NODE_W,
): EdgeGeometry {
  const ax = a._x + nodeW / 2 + fanOffset;
  const ay = a._y + heightOf(a);
  const bx = b._x + nodeW / 2;
  const by = b._y;
  const midY = (ay + by) / 2;
  return {
    d: `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`,
    labelX: (ax + bx) / 2,
    labelY: midY,
  };
}

export interface SvgSize {
  width: number;
  height: number;
}

/** Replaces the `W`/`H` computation at the top of lineage.js
 * `drawSvg`. Returns `{width: 0, height: 0}` for an empty layout
 * (callers render the "No data to display." empty state instead). */
export function computeSvgSize(
  positioned: readonly PositionedLike[],
  heightOf: (node: PositionedLike) => number = () => NODE_H,
  nodeW: number = NODE_W,
  padding: number = PADDING,
): SvgSize {
  if (positioned.length === 0) return { width: 0, height: 0 };
  const width = Math.max(...positioned.map((p) => p._x + nodeW)) + padding;
  const height = Math.max(...positioned.map((p) => p._y + heightOf(p))) + padding;
  return { width, height };
}
