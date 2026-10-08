/**
 * Pure render model for the lineage graph page -- composes the layout
 * modules (tree.ts / timeline.ts / edges.ts) and lib/lineage/core.ts's
 * `selectActiveEdges` into one data structure that
 * components/lineage/graph/* render without doing any layout math of
 * their own, and that test/lineage/graph/view-model.test.ts can
 * exercise against a fixture artifact with zero DOM / React
 * dependency (React Testing Library is not installed in this repo).
 *
 * Mirrors docs/assets/lineage.js's `render()` + `applyModeUI()` +
 * `renderCrumb()` decision tree, minus anything that requires the DOM
 * directly (scroll position, focus movement -- those stay in
 * components/lineage/graph/lineage-graph-app.tsx). Measured card
 * heights DO flow through here: `buildLineageViewModel`'s `heights`
 * parameter takes the post-font-load measurements that component
 * takes via `getBoundingClientRect`, so this function stays pure
 * (same artifact + state + heights always produces the same model)
 * while still reproducing `drawSvg`'s two-pass measure-then-redraw.
 */
import type { LineageArtifact, LineageEdge, LineageNode, Relation } from "../core";
import { selectActiveEdges } from "../core";
import { RELATION_LABEL_JA } from "../relations";
import {
  CLUSTER_SUBTITLE,
  FOOTER_HINT,
  LIST_FOOTER_HINT,
  type LineageLayout,
  type LineageView,
  markerClass,
  NODE_H,
  NODE_W,
} from "./constants";
import {
  buildEdgePath,
  computeSvgSize,
  type EdgeGeometry,
  type EdgeStyle,
  edgeStyle,
  fanOffsets,
} from "./edges";
import { layoutTimeline } from "./timeline";
import { layoutTree } from "./tree";

export interface LineageGraphState {
  layout: LineageLayout;
  view: LineageView;
  focusId: string | null;
  currentCluster: string | null;
  visibleRelations: ReadonlySet<Relation>;
}

export interface LineageCluster {
  id: string;
  label: string;
  focus_ids: string[];
}

/** Narrows `artifact.clusters` (typed `Record<string, unknown>[]` in
 * core.ts, which this page agent does not own) to the shape lineage.js
 * actually reads (`id`, `label`, `focus_ids: string[]`). A cluster row
 * missing any of these is dropped rather than rendered with holes --
 * same fail-closed instinct as core.ts's own parsers, scoped to display. */
export function getClusters(artifact: LineageArtifact): LineageCluster[] {
  const out: LineageCluster[] = [];
  for (const raw of artifact.clusters || []) {
    const { id, label, focus_ids: focusIds } = raw as Record<string, unknown>;
    if (
      typeof id === "string" &&
      typeof label === "string" &&
      Array.isArray(focusIds) &&
      focusIds.every((f) => typeof f === "string")
    ) {
      out.push({ id, label, focus_ids: focusIds as string[] });
    }
  }
  return out;
}

function clusterForFocus(
  clusters: LineageCluster[],
  focusId: string | null,
): LineageCluster | null {
  if (focusId === null) return null;
  for (const c of clusters) {
    if (c.focus_ids.includes(focusId)) return c;
  }
  return null;
}

export interface CrumbModel {
  visible: boolean;
  clusterId: string | null;
  clusterLabel: string | null;
  /** Focus node's title, sliced to 80 chars (no ellipsis) -- matches
   * lineage.js `renderCrumb`'s `focusNode.title.slice(0, 80)` exactly. */
  focusTitle: string | null;
}

/** Ported from lineage.js `renderCrumb`. Computed independent of
 * `state.view` -- the original calls this unconditionally at the top
 * of `render()`, so the crumb reflects `state.layout` even while the
 * list view is showing. */
function buildCrumb(
  clusters: LineageCluster[],
  nodesById: ReadonlyMap<string, LineageNode>,
  state: LineageGraphState,
): CrumbModel {
  const empty: CrumbModel = {
    visible: false,
    clusterId: null,
    clusterLabel: null,
    focusTitle: null,
  };
  if (clusters.length === 0) return empty;
  if (state.layout === "topics" || state.layout === "timeline") return empty;
  const cluster = state.currentCluster
    ? (clusters.find((c) => c.id === state.currentCluster) ?? null)
    : clusterForFocus(clusters, state.focusId);
  if (!cluster) return empty;
  const focusNode = state.focusId ? (nodesById.get(state.focusId) ?? null) : null;
  return {
    visible: true,
    clusterId: cluster.id,
    clusterLabel: cluster.label,
    focusTitle: focusNode?.title ? focusNode.title.slice(0, 80) : null,
  };
}

export interface TopicsClusterModel {
  id: string;
  label: string;
  subtitle: string;
  count: number;
  nodes: LineageNode[];
}

export interface TopicsModel {
  totalPapers: number;
  clusters: TopicsClusterModel[];
}

/** Ported from lineage.js `renderTopicsGallery`. A cluster's
 * `focus_ids` referring to a node absent from `artifact.nodes` is
 * skipped (`if (!n) continue`), same as the original. */
function buildTopics(
  clusters: LineageCluster[],
  nodesById: ReadonlyMap<string, LineageNode>,
): TopicsModel {
  const totalPapers = clusters.reduce((s, c) => s + c.focus_ids.length, 0);
  return {
    totalPapers,
    clusters: clusters.map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      subtitle: CLUSTER_SUBTITLE[cluster.label] || "",
      count: cluster.focus_ids.length,
      nodes: cluster.focus_ids
        .map((id) => nodesById.get(id))
        .filter((n): n is LineageNode => n !== undefined),
    })),
  };
}

export interface GraphEdgeModel {
  edge: LineageEdge;
  markerClass: string;
  label: string | null;
  path: EdgeGeometry;
  style: EdgeStyle | null;
}

export interface GraphModel {
  focusId: string | null;
  positioned: (LineageNode & { _x: number; _y: number; _h: number })[];
  edges: GraphEdgeModel[];
  svgSize: { width: number; height: number };
}

/**
 * Measured card heights by node id (`getBoundingClientRect()` after
 * `document.fonts.ready`, taken in
 * components/lineage/graph/lineage-graph-app.tsx -- the only place in
 * this area allowed to touch the DOM). Absent here means "not measured
 * yet"; `buildGraph` then falls back to the static `NODE_H`, exactly
 * like the very first paint in docs/assets/lineage.js `drawSvg` before
 * its own post-render measurement pass.
 */
export type NodeHeights = ReadonlyMap<string, number>;

function buildGraph(
  artifact: LineageArtifact,
  state: LineageGraphState,
  heights: NodeHeights = new Map(),
): GraphModel {
  const positioned =
    state.layout === "tree"
      ? layoutTree(artifact.nodes, artifact.edges, state.focusId)
      : layoutTimeline(artifact.nodes);
  const positionedIds = new Set(positioned.map((n) => n.id));
  const activeEdges = selectActiveEdges(
    artifact.edges,
    new Set(state.visibleRelations),
    positionedIds,
  );
  const posById = new Map(positioned.map((p) => [p.id, p]));
  // Ported from lineage.js `drawSvg`'s second pass: `p._actualH` lands
  // edges on the card's real rendered bottom instead of the static
  // NODE_H slot once fonts have loaded and layout settles.
  const heightOf = (node: { id: string }): number => heights.get(node.id) ?? NODE_H;
  const fanOff = fanOffsets(activeEdges, posById, NODE_W);
  const edges: GraphEdgeModel[] = [];
  for (const edge of activeEdges) {
    const a = posById.get(edge.src);
    const b = posById.get(edge.dst);
    if (!a || !b) continue;
    const mc = markerClass(edge.relation);
    edges.push({
      edge,
      markerClass: mc,
      label: RELATION_LABEL_JA[edge.relation] ?? null,
      path: buildEdgePath(a, b, fanOff.get(edge) ?? 0, heightOf),
      style: edgeStyle(mc, edge.confidence),
    });
  }
  return {
    focusId: state.focusId,
    positioned: positioned.map((p) => ({ ...p, _h: heightOf(p) })),
    edges,
    svgSize: computeSvgSize(positioned, heightOf),
  };
}

export interface LineageViewModel {
  /** `state.view === "list"` -- components/lineage/relation-list.tsx
   * owns this mode; this view model does not render it. */
  isList: boolean;
  isTopics: boolean;
  /** Tree or timeline, in graph view -- the two modes that draw the
   * SVG canvas. */
  isGraphSvg: boolean;
  legendVisible: boolean;
  filterBarVisible: boolean;
  footerHint: string;
  crumb: CrumbModel;
  topics: TopicsModel | null;
  graph: GraphModel | null;
}

/**
 * Ported from lineage.js `render()` + `applyModeUI()`. Pure: same
 * artifact + state always produces the same model, with no DOM
 * reads/writes anywhere in the call tree.
 */
export function buildLineageViewModel(
  artifact: LineageArtifact,
  state: LineageGraphState,
  heights: NodeHeights = new Map(),
): LineageViewModel {
  const clusters = getClusters(artifact);
  const nodesById = new Map(artifact.nodes.map((n) => [n.id, n]));
  const isList = state.view === "list";
  const isTopics = !isList && state.layout === "topics";
  const isGraphSvg = !isList && (state.layout === "tree" || state.layout === "timeline");

  return {
    isList,
    isTopics,
    isGraphSvg,
    legendVisible: isGraphSvg,
    filterBarVisible: isList || state.layout !== "topics",
    footerHint: isList ? LIST_FOOTER_HINT : FOOTER_HINT[state.layout] || "",
    crumb: buildCrumb(clusters, nodesById, state),
    topics: isTopics ? buildTopics(clusters, nodesById) : null,
    graph: isGraphSvg ? buildGraph(artifact, state, heights) : null,
  };
}
