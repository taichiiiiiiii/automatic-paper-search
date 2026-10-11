/**
 * Per-paper views over a published theme lineage — design doc 48 P0-5
 * (Prior / Derivative panel, first step: papers already in the lineage)
 * and P1-5 (path between two papers).
 *
 * An edge `src → dst` means "dst cites / builds on src" (the generator
 * writes `src` = the cited, older paper). So for a selected paper P:
 *   - Prior (土台): papers P builds on = edges whose `dst` is P, plus the
 *     ancestors reached through a chain of strong relations.
 *   - Derivative (発展): papers building on P = edges whose `src` is P,
 *     plus descendants reached through strong relations.
 * Strong relations (置換・後継・拡張・分析・対立) are listed first, then
 * the plain references (`baseline_only`, 参照（背景）).
 *
 * Computed client-side from `lineage.json` — no schema change. Pure and
 * deterministic.
 */

export interface NeighborNode {
  id: string;
  title?: string;
  year?: number | null;
  citation_count?: number | null;
}

export interface NeighborEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
}

/** `baseline_only` is a background citation; every other relation is a
 * claim backed by a citation sentence or rule (design doc 41 R2-22). */
export function isStrongRelation(relation: string): boolean {
  return relation !== "baseline_only";
}

export type NeighborKind = "strong" | "strong-indirect" | "reference";

export interface NeighborItem<E extends NeighborEdge> {
  /** The other paper. */
  id: string;
  kind: NeighborKind;
  /** Hops from the selected paper (1 = direct). */
  hops: number;
  /** The relation shown for the item: the direct edge, or for an indirect
   * ancestor/descendant the edge that touches the listed paper. */
  edge: E;
  /** Edges from the listed paper to the selected one (Prior) or from the
   * selected one to the listed paper (Derivative), in reading order. */
  chain: E[];
}

export interface PriorDerivative<E extends NeighborEdge> {
  prior: NeighborItem<E>[];
  derivative: NeighborItem<E>[];
}

/** How far the strong-relation closure reaches. Deep chains are better
 * read on the main path / tree; the panel stays short. */
export const MAX_STRONG_HOPS = 3;

function yearOf(nodes: ReadonlyMap<string, NeighborNode>, id: string): number {
  const y = nodes.get(id)?.year;
  return typeof y === "number" && Number.isFinite(y) ? y : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lists Prior / Derivative papers of `id` inside the lineage. Each other
 * paper appears at most once per side, under its strongest reason:
 * a direct strong relation, then an indirect strong chain (≤
 * `MAX_STRONG_HOPS`), then a direct reference.
 */
export function priorDerivative<E extends NeighborEdge>(
  nodes: readonly NeighborNode[],
  edges: readonly E[],
  id: string,
  maxHops: number = MAX_STRONG_HOPS,
): PriorDerivative<E> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeById.has(id)) return { prior: [], derivative: [] };

  const valid = edges.filter((e) => e.src !== e.dst && nodeById.has(e.src) && nodeById.has(e.dst));
  const intoNode = new Map<string, E[]>();
  const outOfNode = new Map<string, E[]>();
  for (const e of valid) {
    if (!intoNode.has(e.dst)) intoNode.set(e.dst, []);
    if (!outOfNode.has(e.src)) outOfNode.set(e.src, []);
    intoNode.get(e.dst)?.push(e);
    outOfNode.get(e.src)?.push(e);
  }
  // Deterministic edge order: strongest claim first.
  const byStrength = (a: E, b: E): number =>
    Number(isStrongRelation(b.relation)) - Number(isStrongRelation(a.relation)) ||
    b.confidence - a.confidence ||
    cmpStr(a.src, b.src) ||
    cmpStr(a.dst, b.dst) ||
    cmpStr(a.relation, b.relation);

  function side(direction: "prior" | "derivative"): NeighborItem<E>[] {
    const step = direction === "prior" ? intoNode : outOfNode;
    const other = (e: E): string => (direction === "prior" ? e.src : e.dst);
    const found = new Map<string, NeighborItem<E>>();

    // BFS over strong relations (hop 1 = direct strong).
    let frontier: Array<{ at: string; chain: E[] }> = [{ at: id, chain: [] }];
    const seen = new Set<string>([id]);
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
      const next: Array<{ at: string; chain: E[] }> = [];
      for (const f of frontier) {
        for (const e of [...(step.get(f.at) ?? [])].sort(byStrength)) {
          if (!isStrongRelation(e.relation)) continue;
          const o = other(e);
          if (seen.has(o)) continue;
          seen.add(o);
          // Chain in reading order: for Prior the listed (older) paper's
          // edge comes first; for Derivative the selected paper's edge.
          const chain = direction === "prior" ? [e, ...f.chain] : [...f.chain, e];
          found.set(o, {
            id: o,
            kind: hop === 1 ? "strong" : "strong-indirect",
            hops: hop,
            edge: e,
            chain,
          });
          next.push({ at: o, chain });
        }
      }
      frontier = next;
    }
    // Direct references not already listed.
    for (const e of [...(step.get(id) ?? [])].sort(byStrength)) {
      const o = other(e);
      if (found.has(o) || o === id) continue;
      found.set(o, { id: o, kind: "reference", hops: 1, edge: e, chain: [e] });
    }

    const rank: Record<NeighborKind, number> = { strong: 0, "strong-indirect": 1, reference: 2 };
    return [...found.values()].sort(
      (a, b) =>
        rank[a.kind] - rank[b.kind] ||
        a.hops - b.hops ||
        b.edge.confidence - a.edge.confidence ||
        // Prior: newest ancestors first (closest); Derivative: oldest first.
        (direction === "prior"
          ? yearOf(nodeById, b.id) - yearOf(nodeById, a.id)
          : yearOf(nodeById, a.id) - yearOf(nodeById, b.id)) ||
        cmpStr(a.id, b.id),
    );
  }

  return { prior: side("prior"), derivative: side("derivative") };
}

// ---- Path between two papers (P1-5) --------------------------------------

/** Cost of one hop: strong relations are preferred over references. */
export const PATH_COST_STRONG = 1;
export const PATH_COST_REFERENCE = 2;

export interface PathStep<E extends NeighborEdge> {
  /** Paper the step starts from (in path order, from `a` to `b`). */
  from: string;
  to: string;
  edge: E;
  /** `forward` = `to` builds on `from` (edge from → to); `backward` = the
   * reverse (`from` builds on `to`). */
  direction: "forward" | "backward";
}

export interface LineagePath<E extends NeighborEdge> {
  steps: PathStep<E>[];
  /** Node ids from `a` to `b`. */
  nodeIds: string[];
  cost: number;
  strongCount: number;
}

/**
 * Shortest path between two papers over lineage edges, ignoring edge
 * direction (a path may go up to a common ancestor and down again).
 * Strong relations cost 1, references 2, so a path through strong
 * relations wins unless it is much longer. Ties break on fewer hops and
 * then ids, so the result does not depend on edge order. `null` when
 * the papers are not connected (or either id is unknown).
 */
export function shortestLineagePath<E extends NeighborEdge>(
  nodes: readonly NeighborNode[],
  edges: readonly E[],
  a: string,
  b: string,
): LineagePath<E> | null {
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(a) || !ids.has(b)) return null;
  if (a === b) return { steps: [], nodeIds: [a], cost: 0, strongCount: 0 };

  type Adj = { to: string; edge: E; direction: "forward" | "backward"; cost: number };
  const adj = new Map<string, Adj[]>();
  for (const e of edges) {
    if (e.src === e.dst || !ids.has(e.src) || !ids.has(e.dst)) continue;
    const cost = isStrongRelation(e.relation) ? PATH_COST_STRONG : PATH_COST_REFERENCE;
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src)?.push({ to: e.dst, edge: e, direction: "forward", cost });
    adj.get(e.dst)?.push({ to: e.src, edge: e, direction: "backward", cost });
  }

  // Dijkstra with a (cost, hops, id) key; the graphs are small (≤ a few
  // hundred nodes), so a linear scan for the minimum is enough.
  type Label = { cost: number; hops: number; prev: string | null; via: Adj | null };
  const label = new Map<string, Label>([[a, { cost: 0, hops: 0, prev: null, via: null }]]);
  const done = new Set<string>();
  const better = (x: Label, y: Label): boolean =>
    x.cost < y.cost || (x.cost === y.cost && x.hops < y.hops);
  for (;;) {
    let cur: string | null = null;
    let curLabel: Label | null = null;
    for (const [id, l] of label) {
      if (done.has(id)) continue;
      if (
        curLabel === null ||
        better(l, curLabel) ||
        (!better(curLabel, l) && cur !== null && id < cur)
      ) {
        cur = id;
        curLabel = l;
      }
    }
    if (cur === null || curLabel === null) return null;
    if (cur === b) break;
    done.add(cur);
    const outs = [...(adj.get(cur) ?? [])].sort(
      (x, y) =>
        x.cost - y.cost ||
        cmpStr(x.to, y.to) ||
        y.edge.confidence - x.edge.confidence ||
        cmpStr(x.edge.relation, y.edge.relation),
    );
    for (const o of outs) {
      if (done.has(o.to)) continue;
      const cand: Label = {
        cost: curLabel.cost + o.cost,
        hops: curLabel.hops + 1,
        prev: cur,
        via: o,
      };
      const old = label.get(o.to);
      if (!old || better(cand, old)) label.set(o.to, cand);
    }
  }

  const steps: PathStep<E>[] = [];
  let cursor = b;
  for (let guard = 0; guard <= ids.size; guard += 1) {
    const l = label.get(cursor);
    if (!l || l.prev === null || l.via === null) break;
    steps.push({ from: l.prev, to: cursor, edge: l.via.edge, direction: l.via.direction });
    cursor = l.prev;
  }
  steps.reverse();
  const nodeIds = [a, ...steps.map((s) => s.to)];
  return {
    steps,
    nodeIds,
    cost: label.get(b)?.cost ?? 0,
    strongCount: steps.filter((s) => isStrongRelation(s.edge.relation)).length,
  };
}
