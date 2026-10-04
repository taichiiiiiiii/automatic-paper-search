"use client";

/**
 * The SVG genealogy graph -- ported from docs/assets/lineage-focus.js
 * `renderGraph` (and the lane/route/label math in lib/lineage/v2/
 * layout.ts, which is what is actually under test; this component is
 * the thin JSX rendering of that math's output).
 *
 * Draw order matters: edges, then node cards, then lane headings LAST
 * (so a lane heading's halo -- `paint-order: stroke fill` with a
 * page-background stroke -- sits on top of and can visually mask a
 * crossing edge, never the reverse). Each edge is drawn twice: a
 * thin, styled, non-interactive `<polyline>` for the visible line,
 * and a wide, transparent, focusable `<polyline>` on top of it that
 * is the actual click/keyboard target (a 2px line is not a usable hit
 * target).
 */
import { useId } from "react";
import {
  type LabelBox,
  labelForRelation,
  laneLayout,
  placeEdgeLabel,
  routeEdge,
  shortTitle,
} from "../../../lib/lineage/v2/layout";
import type { FocusProjection } from "../../../lib/lineage/v2/projection";
import styles from "./focus.module.css";

export interface GraphViewProps {
  projection: FocusProjection;
  onCenter: (nodeId: string) => void;
  onInspect: (claimId: string, trigger: HTMLElement) => void;
}

function activateOnKey<T extends Element>(handler: (event: React.KeyboardEvent<T>) => void) {
  return (event: React.KeyboardEvent<T>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler(event);
    }
  };
}

export function GraphView({ projection, onCenter, onInspect }: GraphViewProps) {
  const arrowId = useId();
  const layout = laneLayout(projection.nodes, projection.claims, projection.focus.id);
  const labelBoxes: LabelBox[] = layout.labels.map((lane) => ({
    left: lane.x,
    right: lane.x + [...lane.label].length * 16,
    top: lane.y - 18,
    bottom: lane.y + 6,
  }));

  const edges: React.ReactNode[] = [];
  for (const claim of projection.claims) {
    const from = layout.positions.get(claim.src);
    const to = layout.positions.get(claim.dst);
    if (!from || !to) continue;
    const route = routeEdge(from, to, layout.positions);
    if (route.length < 2) continue;
    const points = route.map((p) => `${p.x},${p.y}`).join(" ");
    const edgeClassName = [
      styles.edge,
      claim.claim_family === "comparison" && styles.edgeComparison,
      claim.trust_tier === "tentative" && styles.edgeTentative,
    ]
      .filter(Boolean)
      .join(" ");
    const labelText =
      claim.trust_tier === "tentative"
        ? `${labelForRelation(claim.relation)} · 要確認`
        : labelForRelation(claim.relation);
    const ariaLabel = `${labelForRelation(claim.relation)}${claim.trust_tier === "tentative" ? "（要確認）" : ""}の監査詳細を開く`;
    edges.push(
      <polyline
        key={`${claim.id}-line`}
        points={points}
        fill="none"
        className={edgeClassName}
        markerEnd={`url(#${arrowId})`}
      />,
    );
    edges.push(
      // biome-ignore lint/a11y/useSemanticElements: an SVG <polyline> cannot be a <button>; it is the keyboard/click target for one edge's audit-detail action (ported from docs/assets/lineage-focus.js's `line.setAttribute("role", "button")`).
      <polyline
        key={`${claim.id}-hit`}
        points={points}
        fill="none"
        className={styles.edgeHit}
        tabIndex={0}
        role="button"
        aria-label={ariaLabel}
        onClick={(event) => onInspect(claim.id, event.currentTarget as unknown as HTMLElement)}
        onKeyDown={activateOnKey<SVGPolylineElement>((event) =>
          onInspect(claim.id, event.currentTarget as unknown as HTMLElement),
        )}
      />,
    );
    const labelAt = placeEdgeLabel(route, labelText, layout.positions, labelBoxes, {
      width: layout.width,
      height: layout.height,
    });
    if (labelAt) {
      edges.push(
        <text
          key={`${claim.id}-label`}
          x={labelAt.x}
          y={labelAt.y}
          textAnchor="middle"
          className={
            claim.trust_tier === "tentative"
              ? `${styles.edgeLabel} ${styles.edgeLabelTentative}`
              : styles.edgeLabel
          }
        >
          {labelText}
        </text>,
      );
    }
  }

  const nodes = projection.nodes.map((node) => {
    const at = layout.positions.get(node.id);
    if (!at) return null;
    const isFocus = node.id === projection.focus.id;
    return (
      // biome-ignore lint/a11y/useSemanticElements: an SVG <g> node card cannot be a <button>; it is the keyboard/click target for "center on this paper" (ported from docs/assets/lineage-focus.js's `group.setAttribute("role", "button")`).
      <g
        key={node.id}
        className={isFocus ? styles.nodeFocus : undefined}
        transform={`translate(${at.x - 65} ${at.y - 31})`}
        tabIndex={0}
        role="button"
        aria-label={`${node.title}を中心にする`}
        onClick={() => onCenter(node.id)}
        onKeyDown={activateOnKey<SVGGElement>(() => onCenter(node.id))}
      >
        <rect width={130} height={62} rx={4} className={styles.nodeRect} />
        <text x={9} y={27} className={styles.nodeText}>
          {shortTitle(node.title, 18)}
        </text>
      </g>
    );
  });

  const laneLabels = layout.labels.map((lane) => (
    <text key={lane.key} x={lane.x} y={lane.y} className={styles.laneLabel}>
      {lane.label}
    </text>
  ));

  return (
    // biome-ignore lint: two rules apply here and Biome only lets one named rule be suppressed per comment -- useSemanticElements (this is a scrollable graph viewport, not a <fieldset> of form controls) and noNoninteractiveTabindex (`role="group"` + `tabIndex=0` intentionally lets a keyboard user focus the viewport itself to scroll it, per the adjacent help text), both ported from docs/assets/lineage-focus.js's `#lineage-graph`.
    <div
      id="lineage-graph"
      className={styles.graphWrap}
      role="group"
      aria-label="研究系譜グラフ"
      aria-describedby="lineage-graph-help"
      // biome-ignore lint: intentionally focusable (see the comment above this element) so keyboard users can scroll this wide graph viewport without a mouse.
      tabIndex={0}
    >
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`${projection.nodes.length} 論文、${projection.claims.length} 関係のグラフ`}
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {edges}
        {nodes}
        {laneLabels}
      </svg>
    </div>
  );
}
