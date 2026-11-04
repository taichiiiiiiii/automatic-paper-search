/**
 * #483: a theme name with two senses inside ML ("State Space Models":
 * deep SSMs such as Mamba vs probabilistic state-space models / particle
 * filters) yields two citation communities joined only through one seed.
 * Measured on the 12 published themes: removing any single seed splits off
 * at most 1 paper in 11 of them and 29 papers in State Space Models, so a
 * structural test separates "one family" from "two families" without any
 * field-specific rule. Nothing is deleted: the page lets the reader switch
 * between the families or see everything.
 */

export interface FamilyNode {
  id: string;
  title?: string;
  year?: number | null;
  citation_count?: number | null;
}

export interface FamilyEdge {
  src: string;
  dst: string;
}

export interface LineageFamily {
  /** 1-based, ordered by size (largest first). */
  index: number;
  nodeIds: Set<string>;
  size: number;
  yearMin: number | null;
  yearMax: number | null;
  /** Most-cited paper of the family, used as its label. */
  anchorTitle: string;
}

/** A split-off community counts as a family from this many papers… */
export const FAMILY_MIN_NODES = 5;
/** …and this share of the whole graph. */
export const FAMILY_MIN_SHARE = 0.1;

function components(ids: readonly string[], adj: Map<string, Set<string>>, removed: string) {
  const seen = new Set<string>();
  const out: Set<string>[] = [];
  for (const start of ids) {
    if (start === removed || seen.has(start)) continue;
    const comp = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const x = stack.pop() as string;
      if (x === removed || seen.has(x)) continue;
      seen.add(x);
      comp.add(x);
      for (const y of adj.get(x) ?? []) if (!seen.has(y)) stack.push(y);
    }
    out.push(comp);
  }
  return out.sort((a, b) => b.size - a.size);
}

/**
 * Returns two or more families when removing one seed splits the graph
 * into communities that each reach {@link FAMILY_MIN_NODES} papers and
 * {@link FAMILY_MIN_SHARE} of the graph; otherwise null (one family).
 * The bridging seed joins the family it has the most edges into; smaller
 * leftovers join the largest family.
 */
export function detectFamilies(
  nodes: readonly FamilyNode[],
  edges: readonly FamilyEdge[],
  seeds: readonly string[],
): LineageFamily[] | null {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  if (ids.length < FAMILY_MIN_NODES * 2) return null;
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set());
  for (const e of edges) {
    if (!idSet.has(e.src) || !idSet.has(e.dst) || e.src === e.dst) continue;
    adj.get(e.src)?.add(e.dst);
    adj.get(e.dst)?.add(e.src);
  }
  const threshold = Math.max(FAMILY_MIN_NODES, Math.ceil(ids.length * FAMILY_MIN_SHARE));
  let best: { seed: string; comps: Set<string>[] } | null = null;
  for (const seed of [...seeds].sort()) {
    if (!idSet.has(seed)) continue;
    const comps = components(ids, adj, seed);
    if (comps.length < 2 || (comps[1]?.size ?? 0) < threshold) continue;
    if (best === null || (comps[1]?.size ?? 0) > (best.comps[1]?.size ?? 0)) best = { seed, comps };
  }
  if (best === null) return null;

  const big = best.comps.filter((c) => c.size >= threshold);
  const rest = best.comps.filter((c) => c.size < threshold);
  for (const c of rest) for (const id of c) big[0]?.add(id);
  // The bridging seed goes where most of its edges go (ties: the larger family).
  const bridgeNbrs = adj.get(best.seed) ?? new Set<string>();
  let home = big[0] as Set<string>;
  let homeLinks = -1;
  for (const c of big) {
    let links = 0;
    for (const y of bridgeNbrs) if (c.has(y)) links += 1;
    if (links > homeLinks) {
      home = c;
      homeLinks = links;
    }
  }
  home.add(best.seed);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return big
    .sort((a, b) => b.size - a.size)
    .map((c, i) => {
      const members = [...c].map((id) => byId.get(id)).filter((n): n is FamilyNode => !!n);
      const years = members
        .map((n) => n.year)
        .filter((y): y is number => typeof y === "number" && Number.isFinite(y));
      const anchor = [...members].sort(
        (a, b) =>
          (Number(b.citation_count) || 0) - (Number(a.citation_count) || 0) ||
          String(a.title ?? a.id).localeCompare(String(b.title ?? b.id)),
      )[0];
      return {
        index: i + 1,
        nodeIds: c,
        size: c.size,
        yearMin: years.length > 0 ? Math.min(...years) : null,
        yearMax: years.length > 0 ? Math.max(...years) : null,
        anchorTitle: String(anchor?.title ?? anchor?.id ?? ""),
      };
    });
}

/** `?fam=` → 0 (everything) or a family index; unknown values → null. */
export function readFamilyParam(search: string, familyCount: number): number | null {
  const raw = new URLSearchParams(search).get("fam");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= familyCount ? n : null;
}

/** Initial family: the URL's, else the family holding the permalinked
 * paper (`?node=`), else the largest family. */
export function initialFamily(families: readonly LineageFamily[], search: string): number {
  const fromUrl = readFamilyParam(search, families.length);
  if (fromUrl !== null) return fromUrl;
  const node = new URLSearchParams(search).get("node");
  if (node) {
    const f = families.find((x) => x.nodeIds.has(node));
    if (f) return f.index;
  }
  return 1;
}

export function familyLabel(f: LineageFamily): string {
  const span =
    f.yearMin !== null && f.yearMax !== null
      ? f.yearMin === f.yearMax
        ? `${f.yearMin}`
        : `${f.yearMin}–${f.yearMax}`
      : "";
  return `系統 ${f.index}: 「${f.anchorTitle}」ほか ${f.size} 本${span ? `（${span}）` : ""}`;
}
