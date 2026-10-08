"use client";

/**
 * SVG canvas for the tree/timeline layouts -- ported from the edge +
 * marker + node-card half of docs/assets/lineage.js `drawSvg`. Takes a
 * `GraphModel` (lib/lineage/layout/view-model.ts, already positioned
 * and geometry-resolved) and draws it; no layout math happens here.
 *
 * Edge hover/focus highlighting mirrors `highlightConnectedEdges`:
 * connected edges go to full opacity + a touch wider, everything else
 * dims, instead of the original's `.edge--highlight`/`.edge--dim`
 * classes (done here with plain attributes computed from the hovered
 * node id, since there is no CSS sibling-combinator equivalent without
 * a shared ancestor class per node).
 *
 * Edge tooltip: the original (`#tooltip` in docs/iclr-2026/lineage.html
 * + `onEdgeHover`/`onEdgeMove`/`onEdgeLeave` in lineage.js) is a
 * cursor-following `<div>` positioned via `tooltip.style.left/top` --
 * impossible under this app's CSP (`style-src 'self'`, no inline
 * style). Instead this is a `<foreignObject>` anchored to the edge's
 * midpoint (`path.labelX/labelY`, the same point the relation-label
 * chip already uses), positioned via SVG `x`/`y` attributes and
 * clamped to stay inside the canvas -- the same approach
 * components/themes/LineageTree.tsx already uses for its edge tooltip
 * and card popover. Same content (relation, rationale, confidence) and
 * same instant show-on-hover/focus, hide-on-leave/blur timing as the
 * original; only the anchor point (edge midpoint vs. cursor position)
 * differs.
 *
 * Marker colors are literal `oklch(...)` strings (ported verbatim from
 * lineage.js's `markers` array), not CSS custom properties -- `fill`/
 * `stroke` are plain presentation attributes here, so this is not an
 * inline `style=` attribute and is unaffected by the CSP.
 *
 * `nodeWidth`/`cardVariant` (both optional, defaulting to the
 * conference lineage viewer's own `NODE_W`/unset variant) let
 * components/lineage/graph/deep-lineage-app.tsx reuse this same canvas
 * for deep.js's 240px-wide `.node-card--deep` cards instead of
 * duplicating the marker-defs/edge-drawing SVG shell -- the `graph`
 * prop's own `GraphModel` shape (lib/lineage/layout/deep-view-model.ts's
 * `buildDeepGraphModel` output) already matches what this component
 * expects, so only the two card-sizing/content knobs need threading
 * through. Every existing caller omits both, so the conference viewer
 * is unaffected.
 *
 * `cardVariant === "deep"` also swaps the `supersedes`/`successor`
 * arrow-marker lightness to deep.js's own values (50%/64%, vs.
 * lineage.js's 55%/72% for the conference viewer's own tree/timeline)
 * -- the two assets' `drawSvg` ship genuinely different `markers`
 * arrays for those two relations; every other relation's color/shape is
 * identical between them.
 */
import { forwardRef, useState } from "react";
import { NODE_W } from "../../../lib/lineage/layout/constants";
import type { GraphModel } from "../../../lib/lineage/layout/view-model";
import { NodeCard, type NodeCardProps } from "./node-card";
import { relationStrokeClass } from "./relation-colors";

type MarkerShape = "filled" | "hollow" | "dot" | "cross";

const MARKERS: readonly [string, string, MarkerShape][] = [
  ["supersedes", "oklch(55% 0.14 75)", "filled"],
  ["successor", "oklch(72% 0.13 80)", "filled"],
  ["extends", "oklch(62% 0.14 145)", "filled"],
  ["ablation", "oklch(60% 0.13 240)", "hollow"],
  ["baseline", "oklch(60% 0.02 270)", "dot"],
  ["contrasts", "oklch(58% 0.20 25)", "cross"],
];

// docs/assets/deep.js `drawSvg`'s own `markers` array differs from
// lineage.js's only in these two entries' lightness.
const DEEP_MARKERS: readonly [string, string, MarkerShape][] = [
  ["supersedes", "oklch(50% 0.14 75)", "filled"],
  ["successor", "oklch(64% 0.13 80)", "filled"],
  ["extends", "oklch(62% 0.14 145)", "filled"],
  ["ablation", "oklch(60% 0.13 240)", "hollow"],
  ["baseline", "oklch(60% 0.02 270)", "dot"],
  ["contrasts", "oklch(58% 0.20 25)", "cross"],
];

const TOOLTIP_W = 220;
const TOOLTIP_H = 92;
const TOOLTIP_GAP = 10;

function edgeKey(edge: { src: string; dst: string; relation: string }): string {
  return `${edge.src}\u0000${edge.dst}\u0000${edge.relation}`;
}

export interface GraphCanvasProps {
  graph: GraphModel;
  onSelect: (id: string) => void;
  registerCard: (id: string, el: HTMLButtonElement | null) => void;
  /** Card width in SVG units. Defaults to the conference lineage
   * viewer's `NODE_W` (220). Pass deep.js's `DEEP_NODE_W` (240) for the
   * deep viewer. */
  nodeWidth?: number;
  /** Forwarded to `NodeCard`'s `variant` prop. */
  cardVariant?: NodeCardProps["variant"];
}

export const GraphCanvas = forwardRef<SVGSVGElement, GraphCanvasProps>(function GraphCanvas(
  { graph, onSelect, registerCard, nodeWidth = NODE_W, cardVariant },
  ref,
) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const { positioned, edges, svgSize } = graph;
  const markers = cardVariant === "deep" ? DEEP_MARKERS : MARKERS;

  if (positioned.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-ink-subtle">表示できるデータがありません。</p>
    );
  }

  const width = Math.max(svgSize.width, 320);
  const height = Math.max(svgSize.height, 200);
  const hoveredEdge = hoveredEdgeKey
    ? edges.find(({ edge }) => edgeKey(edge) === hoveredEdgeKey)
    : null;

  return (
    <svg
      ref={ref}
      role="img"
      aria-label="Paper lineage graph showing relationships between research papers"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      <title>論文の系譜グラフ</title>
      <defs>
        {markers.map(([key, color, kind]) => (
          <marker
            key={key}
            id={`arrow-${key}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            {kind === "filled" && <path d="M0,0 L10,5 L0,10 z" fill={color} />}
            {kind === "hollow" && (
              <circle cx={5} cy={5} r={3} fill="white" stroke={color} strokeWidth={1.5} />
            )}
            {kind === "dot" && <circle cx={5} cy={5} r={1.8} fill={color} />}
            {kind === "cross" && (
              <path d="M0,0 L10,10 M10,0 L0,10" stroke={color} strokeWidth={1.8} fill="none" />
            )}
          </marker>
        ))}
      </defs>
      <g id="edges">
        {edges.map(({ edge, markerClass, label, path, style }) => {
          const connected =
            hoveredId !== null && (edge.src === hoveredId || edge.dst === hoveredId);
          const dimmed = hoveredId !== null && !connected;
          const baseOpacity = style ? Number(style.opacity) : 0.9;
          const baseWidth = style ? Number(style.width) : 1.4;
          const opacity = dimmed ? baseOpacity * 0.25 : connected ? 1 : baseOpacity;
          const strokeWidth = connected ? baseWidth + 0.6 : baseWidth;
          const key = edgeKey(edge);
          const tooltipLabel = `${label ?? edge.relation}: ${edge.rationale}${
            typeof edge.confidence === "number" ? ` (confidence ${edge.confidence.toFixed(2)})` : ""
          }`;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: mirrors hover/focus bubbling from the focusable hit-area <path> below (tabIndex + aria-label) to show the tooltip, same pattern as components/themes/LineageTree.tsx's edge <g>.
            <g
              key={key}
              onMouseEnter={() => setHoveredEdgeKey(key)}
              onMouseLeave={() =>
                setHoveredEdgeKey((current) => (current === key ? null : current))
              }
              onFocus={() => setHoveredEdgeKey(key)}
              onBlur={() => setHoveredEdgeKey((current) => (current === key ? null : current))}
            >
              <path
                d={path.d}
                className={relationStrokeClass(markerClass)}
                fill="none"
                strokeWidth={strokeWidth}
                strokeOpacity={opacity}
                markerEnd={`url(#arrow-${markerClass})`}
              />
              {/* Wider invisible hit-area, keyboard-focusable, so hovering/
                  tabbing to a thin edge is not required pixel-perfect --
                  same rationale as LineageTree.tsx's `.edgeHit`. */}
              <path
                d={path.d}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                className="cursor-pointer"
                tabIndex={0}
                aria-label={tooltipLabel}
              />
              {label && (
                <g opacity={dimmed ? 0.4 : 1}>
                  <rect
                    x={path.labelX - 14}
                    y={path.labelY - 8}
                    width={28}
                    height={16}
                    rx={3}
                    className={`fill-[var(--color-surface)] ${relationStrokeClass(markerClass)}`}
                    strokeWidth={1}
                  />
                  <text
                    x={path.labelX}
                    y={path.labelY + 4}
                    textAnchor="middle"
                    className="fill-ink-subtle text-[0.6rem]"
                  >
                    {label}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
      <g id="nodes">
        {positioned.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            width={nodeWidth}
            height={node._h}
            isFocus={node.id === graph.focusId}
            onSelect={onSelect}
            onHoverChange={(id, hovered) => setHoveredId(hovered ? id : null)}
            variant={cardVariant}
            ref={(el) => registerCard(node.id, el)}
          />
        ))}
      </g>
      {hoveredEdge &&
        (() => {
          const { edge, markerClass, label, path } = hoveredEdge;
          const flip = path.labelY - TOOLTIP_H - TOOLTIP_GAP < 0;
          const ttX = Math.max(0, Math.min(path.labelX - TOOLTIP_W / 2, width - TOOLTIP_W));
          const ttY = flip
            ? Math.min(path.labelY + TOOLTIP_GAP, height - TOOLTIP_H)
            : path.labelY - TOOLTIP_H - TOOLTIP_GAP;
          return (
            <foreignObject x={ttX} y={Math.max(0, ttY)} width={TOOLTIP_W} height={TOOLTIP_H}>
              <div
                role="tooltip"
                className="pointer-events-none rounded-md bg-ink px-3 py-2 text-xs text-paper shadow-lg"
              >
                <div className="text-[0.65rem] tracking-wide text-paper/70 uppercase">
                  {label ?? markerClass}
                </div>
                <p className="mt-1 line-clamp-3 leading-snug">{edge.rationale}</p>
                {typeof edge.confidence === "number" && (
                  <div className="mt-1 text-[0.65rem] text-paper/60">
                    confidence {edge.confidence.toFixed(2)}
                  </div>
                )}
              </div>
            </foreignObject>
          );
        })()}
    </svg>
  );
});
