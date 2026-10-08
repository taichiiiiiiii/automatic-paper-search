/**
 * Pure render model for the deep-lineage page's graph view -- the deep
 * equivalent of lib/lineage/layout/view-model.ts's `buildLineageViewModel`,
 * scoped to what docs/assets/deep.js's `render()` actually does: deep.js
 * has only ONE layout (the unbounded tree, lib/lineage/layout/deep-tree.ts)
 * and no topics/timeline/clusters, so this module is simpler than the
 * conference lineage one -- just "list" vs "graph" view over the same
 * tree.
 *
 * Reuses lib/lineage/core.ts's `selectActiveEdges` and
 * lib/lineage/layout/edges.ts's `fanOffsets`/`edgeStyle`/`buildEdgePath`/
 * `computeSvgSize` (the latter two via their deep-sized `nodeW`/`padding`
 * overrides -- see edges.ts's module header) and
 * lib/lineage/layout/constants.ts's `markerClass`, so the edge geometry
 * and styling stay byte-identical to the conference viewer's, just at
 * deep's own card size. The resulting `GraphModel` shape matches
 * lib/lineage/layout/view-model.ts's own `GraphModel`, so
 * components/lineage/graph/graph-canvas.tsx can render either without a
 * deep-specific canvas component -- only the node CARD content differs
 * (deep-node-card.tsx), threaded through as a prop.
 */
import type { LineageArtifact, LineageEdge, LineageNode, Relation } from "../core";
import { selectActiveEdges } from "../core";
import { RELATION_LABEL_JA } from "../relations";
import { markerClass } from "./constants";
import { DEEP_NODE_H, DEEP_NODE_W, DEEP_PADDING, layoutDeepTree } from "./deep-tree";
import {
  buildEdgePath,
  computeSvgSize,
  type EdgeGeometry,
  type EdgeStyle,
  edgeStyle,
  fanOffsets,
} from "./edges";

export interface DeepGraphEdgeModel {
  edge: LineageEdge;
  markerClass: string;
  label: string | null;
  path: EdgeGeometry;
  style: EdgeStyle | null;
}

export interface DeepGraphModel {
  focusId: string | null;
  positioned: (LineageNode & { _x: number; _y: number; _h: number })[];
  edges: DeepGraphEdgeModel[];
  svgSize: { width: number; height: number };
}

/** Measured card heights by node id, same contract as
 * lib/lineage/layout/view-model.ts's `NodeHeights` -- threaded in by
 * components/lineage/graph/deep-lineage-app.tsx after
 * `getBoundingClientRect()` once fonts/layout settle (deep.js
 * `drawSvg`'s own post-render measurement pass). Absent here means "not
 * measured yet", falling back to the static deep NODE_H (180, not
 * lineage's 150). */
export type DeepNodeHeights = ReadonlyMap<string, number>;

export interface BuildDeepGraphModelState {
  focusId: string | null;
  visibleRelations: ReadonlySet<Relation>;
}

export function buildDeepGraphModel(
  artifact: LineageArtifact,
  state: BuildDeepGraphModelState,
  heights: DeepNodeHeights = new Map(),
): DeepGraphModel {
  const positioned = layoutDeepTree(artifact.nodes, artifact.edges, state.focusId);
  const positionedIds = new Set(positioned.map((n) => n.id));
  const activeEdges = selectActiveEdges(
    artifact.edges,
    new Set(state.visibleRelations),
    positionedIds,
  );
  const posById = new Map(positioned.map((p) => [p.id, p]));
  const heightOf = (node: { id: string }): number => heights.get(node.id) ?? DEEP_NODE_H;
  const fanOff = fanOffsets(activeEdges, posById, DEEP_NODE_W);
  const edges: DeepGraphEdgeModel[] = [];
  for (const edge of activeEdges) {
    const a = posById.get(edge.src);
    const b = posById.get(edge.dst);
    if (!a || !b) continue;
    const mc = markerClass(edge.relation);
    edges.push({
      edge,
      markerClass: mc,
      label: RELATION_LABEL_JA[edge.relation] ?? null,
      path: buildEdgePath(a, b, fanOff.get(edge) ?? 0, heightOf, DEEP_NODE_W),
      style: edgeStyle(mc, edge.confidence),
    });
  }
  return {
    focusId: state.focusId,
    positioned: positioned.map((p) => ({ ...p, _h: heightOf(p) })),
    edges,
    svgSize: computeSvgSize(positioned, heightOf, DEEP_NODE_W, DEEP_PADDING),
  };
}
