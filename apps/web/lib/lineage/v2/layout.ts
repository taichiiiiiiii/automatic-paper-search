/**
 * Pure graph-layout geometry and small display helpers for the Focus
 * View -- ported 1:1 from the non-DOM parts of
 * docs/assets/lineage-focus.js: `labelForRelation`, `shortTitle`,
 * `layeredLayout`, `rectangleEdgePoints`, `segmentHitsCard`,
 * `routeEdge`, `placeEdgeLabel`, `hiddenCounts`, `nodeLanes`,
 * `laneLayout`, `fixtureLabel`, `safeEvidenceLink`.
 *
 * Every function here is pure (no DOM, no SVG element construction) so
 * `components/lineage/focus/*` can call them to compute positions/
 * routes/labels and render React elements from the results, instead of
 * imperatively building `<svg>` nodes the way the original does. Kept
 * byte-identical in behaviour to the JS -- test/lineage/focus/
 * layout.test.ts ports the pure-geometry subset of
 * test_lineage_focus_app.mjs's cases against this module.
 */
import type { Relation } from "./constants";
import type { FixtureCollection, LineageV2Claim, LineageV2Node, Release } from "./types";

/** Japanese relation labels as THIS viewer displays them -- distinct
 * from `lib/lineage/relations.ts`'s `RELATION_LABEL_JA` (that module is
 * shared by the v1 conference/deep/theme viewers and uses different
 * Japanese wording for `ablation`/`baseline_only`/`contrasts`; reusing
 * it here would silently change this page's copy). */
export const RELATION_LABELS: Record<Relation, string> = {
  supersedes: "置換",
  successor: "後継",
  extends: "拡張",
  ablation: "アブレーション",
  baseline_only: "ベースライン比較",
  contrasts: "対照",
};

export const EXCLUSION_LABELS: Record<string, string> = {
  decision: "非採択判定",
  trust: "信頼段階",
  family: "関係族",
  relation: "関係タイプ",
  confidence: "確信度",
  evidence: "証拠",
  hop: "hop 範囲",
  branch: "枝の折り畳み",
  nodeCap: "論文上限",
  claimCap: "関係上限",
  collapse: "折り畳み",
};

export function labelForRelation(relation: Relation | null | undefined): string {
  return (relation && RELATION_LABELS[relation]) || relation || "未分類";
}

export function shortTitle(title: string, max = 31): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayeredLayout {
  positions: Map<string, Point>;
  rankCount: number;
  maxLayerSize: number;
}

/** Ranks nodes by longest-path distance from any genealogy root
 * (Kahn's algorithm over the TRUSTED -- accepted, verified/
 * corroborated -- subset of `claims` restricted to `nodes`), then
 * packs each rank into a column. A residual cycle (which a verified
 * producer should never emit, but this function does not trust that)
 * and anything downstream of it gets rank 0 rather than a
 * partially-computed one. */
export function layeredLayout(nodes: LineageV2Node[], claims: LineageV2Claim[]): LayeredLayout {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const trusted = claims.filter(
    (claim) =>
      claim.claim_family === "genealogy" &&
      claim.decision === "accepted" &&
      (claim.trust_tier === "verified" || claim.trust_tier === "corroborated") &&
      nodeIds.has(claim.src) &&
      nodeIds.has(claim.dst),
  );
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const rank = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const claim of trusted) {
    (outgoing.get(claim.src) as string[]).push(claim.dst);
    indegree.set(claim.dst, (indegree.get(claim.dst) as number) + 1);
  }
  for (const values of outgoing.values()) values.sort();
  const queue = nodes
    .map((node) => node.id)
    .filter((id) => indegree.get(id) === 0)
    .sort();
  while (queue.length) {
    const id = queue.shift() as string;
    for (const child of outgoing.get(id) as string[]) {
      rank.set(child, Math.max(rank.get(child) as number, (rank.get(id) as number) + 1));
      indegree.set(child, (indegree.get(child) as number) - 1);
      if (indegree.get(child) === 0) {
        queue.push(child);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  for (const node of nodes) {
    if ((indegree.get(node.id) as number) > 0) rank.set(node.id, 0);
  }
  const layers = new Map<number, LineageV2Node[]>();
  for (const node of nodes) {
    const value = rank.get(node.id) as number;
    if (!layers.has(value)) layers.set(value, []);
    (layers.get(value) as LineageV2Node[]).push(node);
  }
  for (const values of layers.values()) {
    values.sort((left, right) => left.id.localeCompare(right.id));
  }
  const positions = new Map<string, Point>();
  for (const [layer, values] of [...layers].sort(([left], [right]) => left - right)) {
    values.forEach((node, index) => {
      positions.set(node.id, { x: 105 + layer * 250, y: 75 + index * 122 });
    });
  }
  return {
    positions,
    rankCount: Math.max(1, ...layers.keys()) + 1,
    maxLayerSize: Math.max(1, ...[...layers.values()].map((values) => values.length)),
  };
}

export interface RectangleEdgePoints {
  start: Point;
  end: Point;
}

/** Where a straight line between two rectangle CENTERS actually enters
 * each rectangle's border (130x62 node cards: half-width 65, half-height
 * 31 by default) -- used to keep arrowheads on the card edge instead of
 * floating over its center. */
export function rectangleEdgePoints(
  from: Point,
  to: Point,
  halfWidth = 65,
  halfHeight = 31,
): RectangleEdgePoints {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { start: { ...from }, end: { ...to } };
  const xScale = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const yScale = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  return {
    start: { x: from.x + dx * scale, y: from.y + dy * scale },
    end: { x: to.x - dx * scale, y: to.y - dy * scale },
  };
}

/** Whether the axis-aligned segment `a`-`b` passes through the
 * clearance zone (146x78, i.e. the 130x62 card plus an 8px margin)
 * around `card`. Routing only ever produces axis-aligned segments, so
 * this is a simple bounding-box overlap test, not general
 * line-segment intersection. */
export function segmentHitsCard(a: Point, b: Point, card: Point): boolean {
  return (
    Math.max(a.x, b.x) > card.x - 73 &&
    Math.min(a.x, b.x) < card.x + 73 &&
    Math.max(a.y, b.y) > card.y - 39 &&
    Math.min(a.y, b.y) < card.y + 39
  );
}

/** BFS over a visibility grid (card borders +/- half-extent) from
 * `from` to `to`, routing around every OTHER card's clearance zone.
 * Returns `[]` ("never draw a misleading line through a card") if no
 * such path exists, otherwise a polyline from `from`'s rectangle edge
 * to `to`'s rectangle edge via collinear-simplified waypoints. */
export function routeEdge(from: Point, to: Point, positions: Map<string, Point>): Point[] {
  if (from.x === to.x && from.y === to.y) return [];
  const cards = [...positions.values()];
  const xs = [...new Set(cards.flatMap((p) => [p.x - 81, p.x, p.x + 81]))].sort((a, b) => a - b);
  const ys = [...new Set(cards.flatMap((p) => [p.y - 47, p.y, p.y + 47]))].sort((a, b) => a - b);
  const key = (x: number, y: number) => y * xs.length + x;
  const point = (index: number): Point => ({
    x: xs[index % xs.length] as number,
    y: ys[Math.floor(index / xs.length)] as number,
  });
  const start = key(xs.indexOf(from.x), ys.indexOf(from.y));
  const end = key(xs.indexOf(to.x), ys.indexOf(to.y));
  const previous = new Map<number, number | null>([[start, null]]);
  const queue = [start];
  // A bounded visibility grid: at most (3 * displayed node count)^2 cells.
  for (let head = 0; head < queue.length && !previous.has(end); head++) {
    const current = queue[head] as number;
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      let nx = x + dx;
      let ny = y + dy;
      // Other lanes can introduce grid coordinates inside an endpoint card.
      // Skip those interior grid points, but still collision-check the full segment.
      while (
        nx >= 0 &&
        ny >= 0 &&
        nx < xs.length &&
        ny < ys.length &&
        key(nx, ny) !== end &&
        cards.some((card) => segmentHitsCard(point(key(nx, ny)), point(key(nx, ny)), card))
      ) {
        nx += dx;
        ny += dy;
      }
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      const next = key(nx, ny);
      if (previous.has(next)) continue;
      const a = point(current);
      const b = point(next);
      if (
        cards.some((card) => {
          if (card.x === from.x && card.y === from.y && current === start) return false;
          if (card.x === to.x && card.y === to.y && next === end) return false;
          return segmentHitsCard(a, b, card);
        })
      ) {
        continue;
      }
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(end)) return [];
  const path: Point[] = [];
  for (let at: number | null = end; at !== null; at = previous.get(at) ?? null)
    path.push(point(at));
  path.reverse();
  const compact = path.filter(
    (p, i) =>
      i === 0 ||
      i === path.length - 1 ||
      !(
        (path[i - 1]?.x === p.x && p.x === path[i + 1]?.x) ||
        (path[i - 1]?.y === p.y && p.y === path[i + 1]?.y)
      ),
  );
  const first = rectangleEdgePoints(compact[0] as Point, compact[1] as Point).start;
  const last = rectangleEdgePoints(
    compact[compact.length - 2] as Point,
    compact[compact.length - 1] as Point,
  ).end;
  return [first, ...compact.slice(1, -1), last];
}

export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CanvasBounds {
  width: number;
  height: number;
}

/**
 * Finds an unoccupied spot for an edge label along `route` (preferring
 * its longest segment), skipping any spot that would overlap a card,
 * an already-`occupied` box, or the canvas bounds. Mutates `occupied`
 * by pushing the chosen box on success. Returns `null` (omit the
 * label, never overprint) if no segment has room.
 */
export function placeEdgeLabel(
  route: Point[],
  text: string,
  positions: Map<string, Point>,
  occupied: LabelBox[],
  bounds: CanvasBounds = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
): Point | null {
  const width = [...text].length * 12 + 12;
  const overlaps = (a: LabelBox, b: LabelBox) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const cards: LabelBox[] = [...positions.values()].map((p) => ({
    left: p.x - 73,
    right: p.x + 73,
    top: p.y - 39,
    bottom: p.y + 39,
  }));
  const segments = route
    .slice(1)
    .map((end, i) => ({
      start: route[i] as Point,
      end,
      length: Math.abs(end.x - (route[i] as Point).x) + Math.abs(end.y - (route[i] as Point).y),
    }))
    .sort((a, b) => b.length - a.length);
  for (const { start, end } of segments) {
    const x = (start.x + end.x) / 2;
    const y = (start.y + end.y) / 2 - 8;
    const box: LabelBox = { left: x - width / 2, right: x + width / 2, top: y - 14, bottom: y + 4 };
    if (
      box.left < 0 ||
      box.top < 0 ||
      box.right > bounds.width ||
      box.bottom > bounds.height ||
      [...cards, ...occupied].some((other) => overlaps(box, other))
    ) {
      continue;
    }
    occupied.push(box);
    return { x, y };
  }
  return null;
}

export interface LaneDefinition {
  key: "focus" | "prior" | "later" | "comparison" | "other";
  label: string;
  nodes: LineageV2Node[];
}

/** Partitions `nodes` into five display lanes relative to `focusId`
 * using TRUSTED (accepted, verified/corroborated) genealogy claims for
 * ancestor/descendant reachability and accepted comparison claims
 * touching the focus for the comparison lane -- a node reachable as
 * both an ancestor and a descendant (a diamond, not a cycle, since
 * `layeredLayout` already rejects genealogy cycles upstream) lands in
 * "other", not "prior"/"later". Lane membership reflects GRAPH
 * POSITION relative to the focus, not trust/verification status --
 * every lane can contain claims of differing trust tiers. */
export function nodeLanes(
  nodes: LineageV2Node[],
  claims: LineageV2Claim[],
  focusId: string,
): LaneDefinition[] {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const comparisons = new Set<string>();
  for (const claim of claims) {
    if (
      !ids.has(claim.src) ||
      !ids.has(claim.dst) ||
      claim.decision !== "accepted" ||
      !(claim.trust_tier === "verified" || claim.trust_tier === "corroborated")
    ) {
      continue;
    }
    if (claim.claim_family === "genealogy") {
      (outgoing.get(claim.src) as string[]).push(claim.dst);
      (incoming.get(claim.dst) as string[]).push(claim.src);
    } else if (claim.claim_family === "comparison") {
      if (claim.src === focusId) comparisons.add(claim.dst);
      if (claim.dst === focusId) comparisons.add(claim.src);
    }
  }
  const reachable = (adjacency: Map<string, string[]>): Set<string> => {
    const seen = new Set([focusId]);
    const queue = [focusId];
    for (let index = 0; index < queue.length; index++) {
      for (const id of adjacency.get(queue[index] as string) ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(id);
        }
      }
    }
    return seen;
  };
  const ancestors = reachable(incoming);
  const descendants = reachable(outgoing);
  const lanes: LaneDefinition[] = [
    { key: "focus", label: "中心の論文", nodes: [] },
    { key: "prior", label: "先行研究", nodes: [] },
    { key: "later", label: "発展研究", nodes: [] },
    { key: "comparison", label: "比較対象（継承とは別）", nodes: [] },
    { key: "other", label: "その他の関連論文", nodes: [] },
  ];
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const prior = ancestors.has(node.id);
    const later = descendants.has(node.id);
    const laneIndex =
      node.id === focusId
        ? 0
        : prior && later
          ? 4
          : prior
            ? 1
            : later
              ? 2
              : comparisons.has(node.id)
                ? 3
                : 4;
    (lanes[laneIndex] as LaneDefinition).nodes.push(node);
  }
  return lanes;
}

export interface LaneLayout {
  positions: Map<string, Point>;
  labels: Array<{ key: string; label: string; x: number; y: number }>;
  width: number;
  height: number;
}

/** Composes `nodeLanes` + `layeredLayout` into the full graph canvas:
 * prior/focus/later lanes side by side (left to right), then
 * comparison/other lanes stacked below in a fixed-width grid. */
export function laneLayout(
  nodes: LineageV2Node[],
  claims: LineageV2Claim[],
  focusId: string,
): LaneLayout {
  const lanes = nodeLanes(nodes, claims, focusId);
  const positions = new Map<string, Point>();
  const labels: Array<{ key: string; label: string; x: number; y: number }> = [];
  let right = 40;
  let bottom = 60;
  for (const key of ["prior", "focus", "later"] as const) {
    const lane = lanes.find((value) => value.key === key) as LaneDefinition;
    if (!lane.nodes.length) continue;
    const local = layeredLayout(lane.nodes, claims);
    labels.push({ key, label: lane.label, x: right, y: 30 });
    let edge = right;
    for (const [id, point] of local.positions) {
      const at = { x: point.x + right, y: point.y + 20 };
      positions.set(id, at);
      edge = Math.max(edge, at.x + 65);
      bottom = Math.max(bottom, at.y + 31);
    }
    right = edge + 80;
  }
  for (const key of ["comparison", "other"] as const) {
    const lane = lanes.find((value) => value.key === key) as LaneDefinition;
    if (!lane.nodes.length) continue;
    const top = bottom + 80;
    labels.push({ key, label: lane.label, x: 40, y: top });
    lane.nodes.forEach((node, index) => {
      const at = { x: 145 + (index % 3) * 250, y: top + 65 + Math.floor(index / 3) * 122 };
      positions.set(node.id, at);
      right = Math.max(right, at.x + 105);
      bottom = Math.max(bottom, at.y + 31);
    });
  }
  return {
    positions,
    labels,
    width: Math.max(760, right + 40),
    height: Math.max(360, bottom + 60),
  };
}

export interface HiddenCounts {
  parent: number;
  child: number;
}

export function hiddenCounts(
  hiddenBranches: Array<{ nodeId: string; parent: number; child: number }>,
  nodeId: string,
): HiddenCounts {
  return hiddenBranches
    .filter((branch) => branch.nodeId === nodeId)
    .reduce(
      (counts, branch) => {
        counts.parent += branch.parent;
        counts.child += branch.child;
        return counts;
      },
      { parent: 0, child: 0 },
    );
}

/** Finds the fixture edge label bound to `claim`'s `review_binding`
 * (used by the inspector to show the human review/adjudication that
 * backs a `verified`-tier accepted claim). `null` if the claim carries
 * no binding or the fixture has no matching label. */
export function fixtureLabel(
  release: Release,
  claim: LineageV2Claim,
): FixtureCollection["edge_labels"][number] | null {
  const labels = release.fixtureCollection?.edge_labels ?? [];
  if (!claim.review_binding) return null;
  return (
    labels.find(
      (label) =>
        label.review_id === claim.review_binding?.review_id &&
        label.evidence_sha256 === claim.review_binding?.evidence_sha256,
    ) ?? null
  );
}

/** Only an http(s) URL is ever offered as an "open the source" link
 * (SCR-45) -- anything else (including a syntactically malformed
 * value, which `new URL` throws on) returns `null` rather than
 * rendering a broken or dangerous href. */
export function safeEvidenceLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
