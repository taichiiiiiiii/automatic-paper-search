/**
 * Main path ("本流") of a theme lineage — design doc 48 P0-1.
 *
 * Search path count (SPC, Hummon & Doreian 1989; Batagelj 2003): orient
 * every lineage edge from the older paper to the newer one so the graph is
 * a DAG, count for each edge e = (u → v) how many source-to-sink paths run
 * through it (`paths into u` × `paths out of v`), and pick the
 * source-to-sink path whose edges have the largest summed weight (the
 * "global main path"). The weight of an edge is its SPC, normalised to
 * [0, 1], times a relation weight so strong relations (置換・拡張・後継・
 * 分析) win over plain background citations, times the edge's confidence.
 *
 * Computed client-side from the published `lineage.json` — no artifact
 * field, no schema change. Pure and deterministic: same input, same path.
 */

export interface MainPathNode {
  id: string;
  year?: number | null;
}

export interface MainPathEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
}

/** How much a relation counts on the main path. Background citations
 * (`baseline_only`) still connect papers but weigh least. */
export const MAIN_PATH_RELATION_WEIGHT: Readonly<Record<string, number>> = {
  supersedes: 3,
  extends: 3,
  successor: 2.5,
  ablation: 2,
  contrasts: 1.5,
  baseline_only: 1,
};

const DEFAULT_RELATION_WEIGHT = 1;

export interface MainPathResult<E extends MainPathEdge> {
  /** Edges on the main path, oldest first. */
  edges: E[];
  /** Node ids on the main path, oldest first. */
  nodeIds: string[];
  /** Unnormalised SPC per input edge index (0 for dropped edges). */
  spc: number[];
}

function yearKey(year: number | null | undefined): number {
  return typeof year === "number" && Number.isFinite(year) ? year : Number.POSITIVE_INFINITY;
}

function compareNodes(a: MainPathNode, b: MainPathNode): number {
  const dy = yearKey(a.year) - yearKey(b.year);
  if (dy !== 0) return dy;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A deterministic topological order: older papers first; inside a year
 * the cited paper (`src`) comes before the citing one when that is
 * consistent; same-year cycles are broken by id.
 */
function topologicalOrder(
  nodes: readonly MainPathNode[],
  edges: readonly MainPathEdge[],
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n.id, new Set());
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (!a || !b || a.id === b.id) continue;
    // A citation always points from the older paper to the newer one; a
    // year inversion in the data is read as the reverse direction.
    const [from, to] = yearKey(a.year) <= yearKey(b.year) ? [a.id, b.id] : [b.id, a.id];
    const set = out.get(from);
    if (set && !set.has(to)) {
      set.add(to);
      indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
  }
  const remaining = new Set(nodes.map((n) => n.id));
  const order: string[] = [];
  const sortedIds = [...nodes].sort(compareNodes).map((n) => n.id);
  while (remaining.size > 0) {
    // Lowest (year, id) node with no unplaced predecessor; when a
    // same-year cycle blocks every node, take the lowest one anyway.
    let pick = sortedIds.find((id) => remaining.has(id) && (indeg.get(id) ?? 0) === 0);
    if (pick === undefined) pick = sortedIds.find((id) => remaining.has(id));
    if (pick === undefined) break;
    remaining.delete(pick);
    order.push(pick);
    for (const to of out.get(pick) ?? []) indeg.set(to, (indeg.get(to) ?? 0) - 1);
  }
  return order;
}

export function computeMainPath<E extends MainPathEdge>(
  nodes: readonly MainPathNode[],
  edges: readonly E[],
): MainPathResult<E> {
  const empty: MainPathResult<E> = { edges: [], nodeIds: [], spc: edges.map(() => 0) };
  if (edges.length === 0 || nodes.length === 0) return empty;

  const order = topologicalOrder(nodes, edges);
  const rank = new Map(order.map((id, i) => [id, i]));

  // Oriented edges (older → newer by topological rank). Parallel edges
  // between the same pair are kept: each is a separate relation claim.
  type Oriented = { index: number; from: string; to: string };
  const oriented: Oriented[] = [];
  edges.forEach((e, index) => {
    const ra = rank.get(e.src);
    const rb = rank.get(e.dst);
    if (ra === undefined || rb === undefined || ra === rb) return;
    oriented.push(ra < rb ? { index, from: e.src, to: e.dst } : { index, from: e.dst, to: e.src });
  });
  if (oriented.length === 0) return empty;

  const outEdges = new Map<string, Oriented[]>();
  const inEdges = new Map<string, Oriented[]>();
  for (const o of oriented) {
    if (!outEdges.has(o.from)) outEdges.set(o.from, []);
    if (!inEdges.has(o.to)) inEdges.set(o.to, []);
    outEdges.get(o.from)?.push(o);
    inEdges.get(o.to)?.push(o);
  }
  const touched = order.filter((id) => outEdges.has(id) || inEdges.has(id));

  // Paths from any source into each node, and from each node to any sink.
  const nIn = new Map<string, number>();
  for (const id of touched) {
    const ins = inEdges.get(id);
    nIn.set(id, ins ? ins.reduce((s, o) => s + (nIn.get(o.from) ?? 0), 0) : 1);
  }
  const nOut = new Map<string, number>();
  for (let i = touched.length - 1; i >= 0; i -= 1) {
    const id = touched[i] as string;
    const outs = outEdges.get(id);
    nOut.set(id, outs ? outs.reduce((s, o) => s + (nOut.get(o.to) ?? 0), 0) : 1);
  }

  const spc = edges.map(() => 0);
  let maxSpc = 0;
  for (const o of oriented) {
    const v = (nIn.get(o.from) ?? 0) * (nOut.get(o.to) ?? 0);
    spc[o.index] = v;
    if (v > maxSpc) maxSpc = v;
  }
  if (maxSpc <= 0) return empty;

  const weightOf = (o: Oriented): number => {
    const e = edges[o.index] as E;
    const rel = MAIN_PATH_RELATION_WEIGHT[e.relation] ?? DEFAULT_RELATION_WEIGHT;
    const conf = Number.isFinite(e.confidence) ? Math.min(1, Math.max(0.05, e.confidence)) : 0.5;
    return ((spc[o.index] as number) / maxSpc) * rel * conf;
  };

  // Ties are broken by an order-independent key (topological rank of the
  // older endpoint, then src/dst/relation), so the result never depends on
  // the order edges appear in the file.
  const tieKey = (o: Oriented): string => {
    const e = edges[o.index] as E;
    return `${String(rank.get(o.from) ?? 0).padStart(8, "0")}\u0000${e.src}\u0000${e.dst}\u0000${e.relation}`;
  };

  // Longest (max summed weight) path ending at each node, in topo order.
  const best = new Map<string, { score: number; via: Oriented | null }>();
  for (const id of touched) {
    let score = 0;
    let via: Oriented | null = null;
    for (const o of inEdges.get(id) ?? []) {
      const s = (best.get(o.from)?.score ?? 0) + weightOf(o);
      if (
        via === null ||
        s > score + 1e-12 ||
        (Math.abs(s - score) <= 1e-12 && tieKey(o) < tieKey(via))
      ) {
        score = s;
        via = o;
      }
    }
    best.set(id, { score, via });
  }

  // End at the best-scoring sink (a node with no outgoing edge).
  let end: string | null = null;
  let endScore = 0;
  for (const id of touched) {
    if (outEdges.has(id)) continue;
    const s = best.get(id)?.score ?? 0;
    if (end === null || s > endScore + 1e-12) {
      end = id;
      endScore = s;
    }
  }
  if (end === null) return { ...empty, spc };

  const pathEdges: E[] = [];
  const nodeIds: string[] = [end];
  let cursor: string = end;
  for (let guard = 0; guard <= touched.length; guard += 1) {
    const via: Oriented | null = best.get(cursor)?.via ?? null;
    if (!via) break;
    pathEdges.push(edges[via.index] as E);
    cursor = via.from;
    nodeIds.push(cursor);
  }
  pathEdges.reverse();
  nodeIds.reverse();
  return { edges: pathEdges, nodeIds, spc };
}
