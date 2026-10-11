/**
 * "系譜での位置" on catalog paper details — design doc 48 P1-3 (I4).
 *
 * A catalog paper and a theme-lineage node are the same paper when they
 * share an identifier: arXiv id (version stripped), DOI (lower-cased),
 * OpenAlex work id, or an identity-alias tuple `[namespace, value]`
 * (`openreview`, `acl_anthology`, `cvf`, … — the catalog row's own
 * `source` / `source_id` is its identity alias, the same tuple
 * `identity-aliases-v1.json` records). Derived DOIs are added for the
 * two id families that have one by construction: arXiv
 * (`10.48550/arxiv.<id>`) and the ACL Anthology (`10.18653/v1/<id>`).
 *
 * The catalog never loads the 4 MB `identity-aliases-v1.json`: every
 * alias tuple it holds for a paper is already on the catalog row
 * (`arxiv_id`, `source`/`source_id`), so fetching it would add no key.
 *
 * Pure; the loader (lib/data-themes.ts `loadThemePositionIndex`) only
 * feeds artifacts that passed the theme publication gate.
 */
import { computeMainPath } from "./main-path";
import { isStrongRelation } from "./paper-neighbors";

export interface PositionNode {
  id: string;
  title?: string;
  year?: number | null;
  aliases?: unknown[];
  arxiv_id?: string;
  doi?: string;
  openalex_id?: unknown;
  [key: string]: unknown;
}

export interface PositionEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
}

export interface PositionArtifact {
  nodes: PositionNode[];
  edges: PositionEdge[];
}

export interface PositionTheme {
  slug: string;
  theme: string;
  tier?: string | null;
  artifact: PositionArtifact;
}

export interface ThemePosition {
  slug: string;
  theme: string;
  tier: string | null;
  nodeId: string;
  title: string;
  year: number | null;
  /** Papers in the lineage that build on this one, by relation. */
  derivedBy: Record<string, number>;
  /** Papers in the lineage this one builds on, by relation. */
  buildsOn: Record<string, number>;
  derivativeCount: number;
  priorCount: number;
  strongDerivativeCount: number;
  onMainPath: boolean;
}

const ARXIV_NEW_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_OLD_RE = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;

/** Normalises an arXiv id (`arXiv:1706.03762v5` → `1706.03762`). */
export function normalizeArxivId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, "")
    .replace(/\.pdf$/i, "");
  const m = ARXIV_NEW_RE.exec(s) ?? ARXIV_OLD_RE.exec(s);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Normalises a DOI (`https://doi.org/10.1/X` → `10.1/x`). */
export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
}

/** Normalises an OpenAlex work id (`https://openalex.org/W123` → `w123`). */
export function normalizeOpenAlexId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .replace(/^openalex:/i, "");
  return /^w\d+$/i.test(s) ? s.toLowerCase() : null;
}

function addArxiv(keys: Set<string>, raw: unknown): void {
  const a = normalizeArxivId(raw);
  if (!a) return;
  keys.add(`arxiv:${a}`);
  keys.add(`doi:10.48550/arxiv.${a}`);
}

function addDoi(keys: Set<string>, raw: unknown): void {
  const d = normalizeDoi(raw);
  if (!d) return;
  keys.add(`doi:${d}`);
  const m = /^10\.48550\/arxiv\.(.+)$/.exec(d);
  if (m) addArxiv(keys, m[1]);
}

function addAlias(keys: Set<string>, ns: unknown, value: unknown): void {
  if (typeof ns !== "string" || typeof value !== "string" || !value) return;
  const n = ns.toLowerCase();
  if (n === "arxiv") {
    addArxiv(keys, value);
  } else if (n === "doi") {
    addDoi(keys, value);
  } else if (n === "openalex") {
    const o = normalizeOpenAlexId(value);
    if (o) keys.add(`openalex:${o}`);
  } else {
    keys.add(`${n}:${value}`);
    if (n === "acl_anthology") addDoi(keys, `10.18653/v1/${value}`);
  }
}

/** Identifier keys of a catalog row (`CatalogPaper`). */
export function catalogPaperKeys(paper: {
  arxiv_id?: unknown;
  arxiv_url?: unknown;
  doi?: unknown;
  openalex_id?: unknown;
  source?: unknown;
  source_id?: unknown;
}): Set<string> {
  const keys = new Set<string>();
  addArxiv(keys, paper.arxiv_id);
  if (typeof paper.arxiv_url === "string" && /arxiv\.org\//i.test(paper.arxiv_url)) {
    addArxiv(keys, paper.arxiv_url);
  }
  addDoi(keys, paper.doi);
  addAlias(keys, "openalex", paper.openalex_id);
  addAlias(keys, paper.source, paper.source_id);
  return keys;
}

/** Identifier keys of a theme-lineage node. */
export function lineageNodeKeys(node: PositionNode): Set<string> {
  const keys = new Set<string>();
  const m = /^([a-z_]+):(.+)$/i.exec(node.id);
  if (m) addAlias(keys, m[1], m[2]);
  addArxiv(keys, node.arxiv_id);
  addDoi(keys, node.doi);
  addAlias(keys, "openalex", node.openalex_id);
  if (Array.isArray(node.aliases)) {
    for (const a of node.aliases) {
      if (Array.isArray(a)) addAlias(keys, a[0], a[1]);
    }
  }
  return keys;
}

export type ThemePositionIndex = ReadonlyMap<string, readonly ThemePosition[]>;

function positionOf(t: PositionTheme, node: PositionNode, mainNodes: Set<string>): ThemePosition {
  const ids = new Set(t.artifact.nodes.map((n) => n.id));
  const derivedBy: Record<string, number> = {};
  const buildsOn: Record<string, number> = {};
  const derivative = new Set<string>();
  const prior = new Set<string>();
  const strongDerivative = new Set<string>();
  for (const e of t.artifact.edges) {
    if (e.src === e.dst || !ids.has(e.src) || !ids.has(e.dst)) continue;
    if (e.src === node.id) {
      derivedBy[e.relation] = (derivedBy[e.relation] ?? 0) + 1;
      derivative.add(e.dst);
      if (isStrongRelation(e.relation)) strongDerivative.add(e.dst);
    } else if (e.dst === node.id) {
      buildsOn[e.relation] = (buildsOn[e.relation] ?? 0) + 1;
      prior.add(e.src);
    }
  }
  return {
    slug: t.slug,
    theme: t.theme,
    tier: t.tier ?? null,
    nodeId: node.id,
    title: typeof node.title === "string" && node.title ? node.title : node.id,
    year: typeof node.year === "number" ? node.year : null,
    derivedBy,
    buildsOn,
    derivativeCount: derivative.size,
    priorCount: prior.size,
    strongDerivativeCount: strongDerivative.size,
    onMainPath: mainNodes.has(node.id),
  };
}

/** Key → positions of the paper in every published theme it belongs to. */
export function buildThemePositionIndex(themes: readonly PositionTheme[]): ThemePositionIndex {
  const index = new Map<string, ThemePosition[]>();
  for (const t of themes) {
    const main = computeMainPath(t.artifact.nodes, t.artifact.edges);
    const mainNodes = new Set(main.nodeIds);
    for (const node of t.artifact.nodes) {
      const pos = positionOf(t, node, mainNodes);
      for (const k of lineageNodeKeys(node)) {
        const list = index.get(k) ?? [];
        if (!list.some((p) => p.slug === pos.slug && p.nodeId === pos.nodeId)) list.push(pos);
        index.set(k, list);
      }
    }
  }
  return index;
}

/** Positions of one catalog paper (deduplicated, sorted by theme name). */
export function lookupThemePositions(
  index: ThemePositionIndex | null,
  paper: Parameters<typeof catalogPaperKeys>[0],
): ThemePosition[] {
  if (!index) return [];
  const out = new Map<string, ThemePosition>();
  for (const k of catalogPaperKeys(paper)) {
    for (const p of index.get(k) ?? []) out.set(`${p.slug}\u0000${p.nodeId}`, p);
  }
  return [...out.values()].sort((a, b) =>
    a.theme < b.theme ? -1 : a.theme > b.theme ? 1 : a.slug < b.slug ? -1 : 1,
  );
}

/** `/themes/?theme=<slug>&focus=<node id>` (BASE_PATH prepended by caller). */
export function themeFocusPath(slug: string, nodeId: string): string {
  const params = new URLSearchParams({ theme: slug, focus: nodeId });
  return `/themes/?${params.toString()}`;
}
