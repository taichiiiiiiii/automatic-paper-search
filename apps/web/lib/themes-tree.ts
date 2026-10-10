/**
 * Ported pure layout/scoring logic from docs/assets/theme.js's
 * chronological family-tree renderer (Y axis = year, rank-based so
 * every unique year gets one equal-height row; X axis = one of 6
 * selectable encodings), plus the per-card visual-hook computation
 * (`computeModeData`) and the sparse-graph threshold check. See
 * test/themes/tree-layout.test.ts for the ported coverage.
 *
 * Interactive chrome that isn't pure layout logic (pan/scroll, minimap
 * canvas drawing, SVG/PNG export, keyboard shortcuts, onboarding,
 * search/year/relation filter UI, card popover, edge tooltip) lives in
 * components/themes/LineageTree.tsx and lib/themes-export.ts instead.
 */

import type { LineageEdge, LineageNode } from "./themes-quality";

export const X_AXIS_MODES = [
  "rank",
  "citation_log",
  "genealogy",
  "centrality",
  "venue",
  "novelty",
] as const;
export type XAxisMode = (typeof X_AXIS_MODES)[number];
export const DEFAULT_X_AXIS_MODE: XAxisMode = "rank";

/** The 6 LLM-classified relation types (docs/assets/theme.js's
 * `ALL_RELATIONS`). `unrelated` is excluded -- build_theme_lineage.py
 * drops it from the artifact entirely, so it never reaches the UI. */
export const ALL_RELATIONS = [
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
] as const;
export type Relation = (typeof ALL_RELATIONS)[number];

/** Relation chips visible on first load (docs/assets/theme.js's
 * `DEFAULT_RELATIONS`) -- `contrasts` starts hidden since it's the
 * noisiest/least common relation in most themes. */
export const DEFAULT_RELATIONS: readonly Relation[] = [
  "supersedes",
  "successor",
  "extends",
  "ablation",
];

export const NODE_W = 260;
export const NODE_H = 200;
export const ROW_GAP = 80;
export const SIBLING_GAP = 28;
export const PADDING = 56;
export const YEAR_LABEL_W = 84;

/** Sentinel bucket key for nodes with a missing / implausible year. */
export const UNKNOWN_YEAR = "__unknown__" as const;
export type YearBucket = number | typeof UNKNOWN_YEAR;

export const MIN_PLAUSIBLE_YEAR = 1900;
export const MAX_PLAUSIBLE_YEAR = new Date().getFullYear() + 2;

/** Bucket key for a node's year: the year itself when it's a finite
 * integer in the plausible range, otherwise the `UNKNOWN_YEAR`
 * sentinel. Pure (no console.warn side effect -- the original's
 * one-time dev-console warning is UI-only telemetry, not ported). */
export function bucketYear(year: unknown): YearBucket {
  if (typeof year !== "number" || !Number.isFinite(year) || !Number.isInteger(year)) {
    return UNKNOWN_YEAR;
  }
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return UNKNOWN_YEAR;
  return year;
}

/** case-insensitive needle in title / authors / venue. Empty query
 * always matches (no filter applied). */
export function matchesSearch(node: LineageNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (typeof node.title === "string" && node.title.toLowerCase().includes(needle)) return true;
  if (typeof node.venue === "string" && node.venue.toLowerCase().includes(needle)) return true;
  for (const author of node.authors ?? []) {
    if (typeof author === "string" && author.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** True when node.year is within [min, max] inclusive. Null bounds (no
 * filter) and unknown years (year not numeric) both pass. */
export function matchesYear(node: LineageNode, min: number | null, max: number | null): boolean {
  if (min == null && max == null) return true;
  const y = node.year;
  if (typeof y !== "number") return true; // unknown-year nodes always shown
  if (min != null && y < min) return false;
  if (max != null && y > max) return false;
  return true;
}

export function venueTierBucket(tier: unknown): number {
  if (typeof tier === "number") {
    if (tier >= 1 && tier <= 3) return tier;
    return 99;
  }
  if (typeof tier !== "string") return 99;
  const t = tier.trim().toLowerCase();
  if (t === "a+" || t === "aplus") return 1;
  if (t === "a") return 2;
  if (t === "preprint" || t === "") return 3;
  return 99;
}

export interface LayoutContext {
  parentsById: Map<string, Set<string>>;
  edgesByNode: Map<string, LineageEdge[]>;
  pagerank: Map<string, number>;
  placedX: Map<string, number>;
}

/** Scores a node for the given X-axis mode (lower = further left). The
 * "rank" mode is implemented by the caller (sort by citation_count
 * desc) and has no per-node score. */
export function scoreForMode(node: LineageNode, mode: XAxisMode, ctx: LayoutContext): number {
  switch (mode) {
    case "citation_log": {
      const c = typeof node.citation_count === "number" ? node.citation_count : 0;
      return -Math.log10(c + 1);
    }
    case "genealogy": {
      const parents = ctx.parentsById.get(node.id);
      if (!parents || parents.size === 0) return Number.POSITIVE_INFINITY;
      let sum = 0;
      let n = 0;
      for (const pid of parents) {
        const px = ctx.placedX.get(pid);
        if (typeof px === "number") {
          sum += px;
          n++;
        }
      }
      if (n === 0) return Number.POSITIVE_INFINITY;
      return sum / n;
    }
    case "centrality": {
      const r = ctx.pagerank.get(node.id) ?? 0;
      return -r;
    }
    case "venue": {
      const tier = venueTierBucket(node.venue_tier);
      const c = typeof node.citation_count === "number" ? node.citation_count : 0;
      return tier * 1e9 - c;
    }
    case "novelty": {
      const edges = ctx.edgesByNode.get(node.id) ?? [];
      let disrupt = 0;
      let incremental = 0;
      for (const e of edges) {
        if (e.dst !== node.id) continue; // only incoming edges describe this node's relation to its ancestors
        if (e.relation === "supersedes" || e.relation === "contrasts") disrupt += 1;
        else if (
          e.relation === "successor" ||
          e.relation === "extends" ||
          e.relation === "ablation"
        )
          incremental += 1;
      }
      if (disrupt === 0 && incremental === 0) {
        const c = typeof node.citation_count === "number" ? node.citation_count : 0;
        return -c * 1e-6;
      }
      return incremental - disrupt;
    }
    default: {
      const c = typeof node.citation_count === "number" ? node.citation_count : 0;
      return -c;
    }
  }
}

/** Damped PageRank over the lineage edges, reversed (child -> parent:
 * "descendants vote for the ancestor that influenced them") so a seed
 * paper with many descendants outranks a childless leaf. 20 iterations
 * is plenty for the graph sizes involved (typically well under 200
 * nodes). */
export function computePagerank(
  nodes: LineageNode[],
  edges: LineageEdge[],
  { damping = 0.85, iterations = 20 }: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return new Map();
  const rank = new Map<string, number>(ids.map((id) => [id, 1 / N]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const outDeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const validEdges = (edges || []).filter((e) => out.has(e.dst) && rank.has(e.src));
  for (const e of validEdges) {
    out.get(e.dst)?.push(e.src);
    outDeg.set(e.dst, (outDeg.get(e.dst) ?? 0) + 1);
  }
  const base = (1 - damping) / N;
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>(ids.map((id) => [id, base]));
    let dangling = 0;
    for (const id of ids) {
      if ((outDeg.get(id) ?? 0) === 0) dangling += rank.get(id) ?? 0;
    }
    const danglingShare = (damping * dangling) / N;
    for (const id of ids) next.set(id, (next.get(id) ?? 0) + danglingShare);
    for (const id of ids) {
      const r = rank.get(id) ?? 0;
      const targets = out.get(id) ?? [];
      if (targets.length === 0) continue;
      const share = (damping * r) / targets.length;
      for (const t of targets) next.set(t, (next.get(t) ?? 0) + share);
    }
    for (const id of ids) rank.set(id, next.get(id) ?? 0);
  }
  return rank;
}

export function buildLayoutContext(nodes: LineageNode[], edges: LineageEdge[]): LayoutContext {
  const parentsById = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  const edgesByNode = new Map<string, LineageEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges || []) {
    parentsById.get(e.dst)?.add(e.src);
    edgesByNode.get(e.dst)?.push(e);
    edgesByNode.get(e.src)?.push(e);
  }
  const pagerank = computePagerank(nodes, edges || []);
  return { parentsById, edgesByNode, pagerank, placedX: new Map() };
}

export interface PositionedNode extends LineageNode {
  _x: number;
  _y: number;
}

export interface YearLabel {
  label: string;
  y: number;
  isUnknown: boolean;
  importance: "regular" | "decade" | "decade-major";
}

export interface LayoutResult {
  positioned: PositionedNode[];
  yearLabels: YearLabel[];
  totalW: number;
  totalH: number;
}

/** Y axis = year (rank-based: every unique year occupies one row of
 * equal height, regardless of calendar gaps). X axis = `mode`. Edges
 * run parent (older, top) -> child (newer, bottom). Left-aligned rows
 * so sparse early years don't drift to the middle of a wide canvas. */
export function layoutChronological(
  nodes: LineageNode[],
  edges: LineageEdge[],
  mode: XAxisMode = DEFAULT_X_AXIS_MODE,
): LayoutResult {
  const effectiveMode: XAxisMode = X_AXIS_MODES.includes(mode) ? mode : DEFAULT_X_AXIS_MODE;

  const byYear = new Map<YearBucket, LineageNode[]>();
  for (const n of nodes) {
    const key = bucketYear(n.year);
    const bucket = byYear.get(key);
    if (bucket) bucket.push(n);
    else byYear.set(key, [n]);
  }

  const years: YearBucket[] = [...byYear.keys()]
    .filter((y): y is number => y !== UNKNOWN_YEAR)
    .sort((a, b) => a - b);
  if (byYear.has(UNKNOWN_YEAR)) years.push(UNKNOWN_YEAR);

  const ctx = buildLayoutContext(nodes, edges);

  if (effectiveMode !== "genealogy") {
    for (const y of years) {
      const row = byYear.get(y);
      if (!row) continue;
      if (effectiveMode === "rank") {
        row.sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0));
      } else {
        row.sort(
          (a, b) => scoreForMode(a, effectiveMode, ctx) - scoreForMode(b, effectiveMode, ctx),
        );
      }
    }
  }

  const maxRow = Math.max(0, ...[...byYear.values()].map((v) => v.length));
  const rowSpanW = maxRow * (NODE_W + SIBLING_GAP);
  const totalW = YEAR_LABEL_W + rowSpanW + PADDING;
  const totalH = PADDING + years.length * (NODE_H + ROW_GAP) + PADDING;

  const positioned: PositionedNode[] = [];
  const yearLabels: YearLabel[] = [];

  years.forEach((year, rowIdx) => {
    const row = byYear.get(year);
    if (!row) return;
    if (effectiveMode === "genealogy") {
      row.sort((a, b) => {
        const sa = scoreForMode(a, effectiveMode, ctx);
        const sb = scoreForMode(b, effectiveMode, ctx);
        if (sa !== sb) return sa - sb;
        return (b.citation_count ?? 0) - (a.citation_count ?? 0);
      });
    }
    const xStart = YEAR_LABEL_W + PADDING / 2;
    const y = PADDING + rowIdx * (NODE_H + ROW_GAP);
    let importance: YearLabel["importance"] = "regular";
    if (year !== UNKNOWN_YEAR) {
      if (year % 10 === 0) importance = "decade-major";
      else if (year % 5 === 0) importance = "decade";
    }
    yearLabels.push({
      label: year === UNKNOWN_YEAR ? "Unknown" : String(year),
      y: y + NODE_H / 2,
      isUnknown: year === UNKNOWN_YEAR,
      importance,
    });
    row.forEach((n, i) => {
      const x = xStart + i * (NODE_W + SIBLING_GAP);
      positioned.push({ ...n, _x: x, _y: y });
      ctx.placedX.set(n.id, x);
    });
  });

  return { positioned, yearLabels, totalW, totalH };
}

/** Nodes whose (in+out) degree clears the 90th percentile -- tagged as
 * "hub" papers. Returns an empty set on graphs too small to talk about
 * percentiles meaningfully (<5 non-isolated nodes). */
export function computeHubSet(nodes: LineageNode[], edges: LineageEdge[]): Set<string> {
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    if (degree.has(e.src)) degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    if (degree.has(e.dst)) degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const values = [...degree.values()].filter((d) => d > 0).sort((a, b) => a - b);
  if (values.length < 5) return new Set();
  const idx = Math.min(Math.ceil(values.length * 0.9) - 1, values.length - 1);
  const threshold = Math.max(values[idx] ?? 0, 4);
  const hubs = new Set<string>();
  for (const [id, d] of degree) if (d >= threshold) hubs.add(id);
  return hubs;
}

/** Nodes with no incident edge in the full relation graph (ignoring any
 * UI relation filter, so toggling filter chips never reshuffles which
 * nodes count as orphaned). */
export function computeOrphanSet(nodes: LineageNode[], edges: LineageEdge[]): Set<string> {
  const incident = new Set<string>();
  for (const e of edges || []) {
    if (e.src) incident.add(e.src);
    if (e.dst) incident.add(e.dst);
  }
  const orphans = new Set<string>();
  for (const n of nodes) if (!incident.has(n.id)) orphans.add(n.id);
  return orphans;
}

/** #67: citation-heat ceiling -- 500k matches the most-cited DL papers
 * (~226k ResNet, ~174k "Attention is all you need") so a single runaway
 * citation count doesn't saturate every other card's halo to white. */
export const CITATION_HEAT_CEILING = 500_001;

/** Log-normalised 0..1 "how often is this cited" weight (ported from
 * docs/assets/theme.js's inline `heat` calc in buildCardElement). */
export function computeCitationHeat(citationCount: number | null | undefined): number {
  const cit = typeof citationCount === "number" && citationCount > 0 ? citationCount : 0;
  if (cit === 0) return 0;
  return Math.min(1, Math.log10(cit + 1) / Math.log10(CITATION_HEAT_CEILING));
}

/** Number of discrete halo steps exposed as CSS classes (`heat0` ..
 * `heat{HEAT_BUCKET_COUNT - 1}`) in LineageTree.module.css. The original
 * sets a continuous `--card-heat` custom property via an inline
 * `style.setProperty(...)` call and lets a `box-shadow` `calc()` scale
 * off it; CSP `style-src 'self'` forbids inline `style=` here (P2
 * brief), so the continuous value is quantised into a small, fixed set
 * of pre-computed box-shadow classes instead. */
export const HEAT_BUCKET_COUNT = 6;

/** Which of the `HEAT_BUCKET_COUNT` discrete halo steps a citation count
 * falls into (0 = no citations, `HEAT_BUCKET_COUNT - 1` = at/above the
 * ceiling). Pure quantisation of `computeCitationHeat`. */
export function heatBucket(citationCount: number | null | undefined): number {
  const heat = computeCitationHeat(citationCount);
  return Math.round(heat * (HEAT_BUCKET_COUNT - 1));
}

/** Per-card visual hooks for the current X-axis mode (ported from
 * docs/assets/theme.js's `computeModeData`): a venue tier bucket, a
 * disrupt/incremental/neutral novelty bucket, or a lineage-ancestor hue
 * (0..359), keyed by node id. Modes without a dedicated visual hook
 * ("rank" / "citation_log" / "centrality") return an empty map -- the
 * card simply shows no extra accent for those. */
export type ModeDatum =
  | { kind: "tier"; value: 1 | 2 | 3 | null }
  | { kind: "novelty"; value: "disrupt" | "incremental" | "neutral" }
  | { kind: "lineage"; value: number };

export function computeModeData(
  nodes: LineageNode[],
  edges: LineageEdge[],
  mode: XAxisMode,
): Map<string, ModeDatum> {
  const meta = new Map<string, ModeDatum>();

  if (mode === "venue") {
    for (const n of nodes) {
      const bucket = venueTierBucket(n.venue_tier);
      const value = bucket >= 1 && bucket <= 3 ? (bucket as 1 | 2 | 3) : null;
      meta.set(n.id, { kind: "tier", value });
    }
    return meta;
  }

  if (mode === "novelty") {
    const incoming = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      incoming.get(e.dst)?.push(e.relation);
    }
    for (const n of nodes) {
      let disrupt = 0;
      let incremental = 0;
      for (const rel of incoming.get(n.id) ?? []) {
        if (rel === "supersedes" || rel === "contrasts") disrupt += 1;
        else if (rel === "successor" || rel === "extends" || rel === "ablation") incremental += 1;
      }
      let value: "disrupt" | "incremental" | "neutral" = "neutral";
      if (disrupt > incremental) value = "disrupt";
      else if (incremental > disrupt) value = "incremental";
      meta.set(n.id, { kind: "novelty", value });
    }
    return meta;
  }

  if (mode === "genealogy") {
    // Walk each node up to its furthest ancestor reachable via parent
    // edges; the ancestor id becomes the lineage bucket. Cards in the
    // same bucket get the same hue offset.
    const parents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      parents.get(e.dst)?.push(e.src);
    }
    const root = (id: string, seen: Set<string> = new Set<string>()): string => {
      if (seen.has(id)) return id;
      seen.add(id);
      const parentIds = parents.get(id) ?? [];
      if (parentIds.length === 0) return id;
      // Pick the parent with the smallest id deterministically so the
      // bucket assignment is stable across renders.
      const sorted = [...parentIds].sort();
      return root(sorted[0] as string, seen);
    };
    for (const n of nodes) {
      const ancestor = root(n.id);
      // Simple FNV-1a-ish string hash to a 0..359 hue offset -- quality
      // is fine for visual bucketing, not cryptographic.
      let h = 0;
      for (let i = 0; i < ancestor.length; i++) h = (h * 31 + ancestor.charCodeAt(i)) & 0xffff;
      meta.set(n.id, { kind: "lineage", value: h % 360 });
    }
    return meta;
  }

  return meta;
}

/** Sparse-lineage thresholds mirroring build_theme_lineage.py's
 * SPARSE_NODES / SPARSE_EDGES -- below either, the viewer shows a
 * one-line hint explaining the thin graph is a data limit (the theme
 * hasn't accumulated enough citation-graph density yet), not a bug. */
export const SPARSE_NODE_THRESHOLD = 15;
export const SPARSE_EDGE_THRESHOLD = 5;

export function isSparseLineage(nodeCount: number, edgeCount: number): boolean {
  return nodeCount < SPARSE_NODE_THRESHOLD || edgeCount < SPARSE_EDGE_THRESHOLD;
}

/** One-line hint shown under a sparse lineage. There is no scheduled
 * regeneration (themes are rebuilt only on request / by an operator), so
 * the copy must not promise one (the old text claimed a weekly Sunday
 * rebuild). */
export function sparseLineageNotice(nodeCount: number, edgeCount: number): string {
  return `🌱 このテーマは家系図がまだ薄いです (${nodeCount} 件 / ${edgeCount} edges)。論文が少ないうちは家系図が薄くなります。作り直しで密になることがあります。`;
}
