/**
 * R4-3 (design 48 P1-1): per-theme "new papers" feed.
 *
 * For a published theme lineage, ask OpenAlex for works published in the
 * last N days that cite ANY lineage node (`filter=cites:W1|W2|…` — one OR
 * filter of up to 100 ids per request, cursor-paginated, 1 list credit
 * per page), keep the ones whose `referenced_works` contain at least
 * `minLineageCites` (default 2) lineage nodes, then apply the theme topic
 * gate (design 41 D7: embedding z-score + theme terms, the same
 * `TopicScope.admitsDescendant` rule the BFS uses for citing papers) to
 * drop off-topic citers. The result is a small `theme-new-papers-v1`
 * document; `atom.ts` renders the same items as an Atom feed.
 *
 * New papers never enter the lineage graph (design 48 §6: edges carry only
 * evidence-backed relations); they are a separate "新着" list and
 * candidates for the next regeneration.
 *
 * Failure policy: any failed OpenAlex page (network, 5xx, budget breaker)
 * aborts the theme with {@link NewPapersFetchError} — a partial list is
 * never written, the previous file stays (LIN-20 spirit).
 */

import type { FetchLike } from "../../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../../collect/http/requestWithRetry.js";
import { OPENALEX_WORK_SELECT, OPENALEX_WORKS_URL } from "../openalexFetch.js";
import {
  OPENALEX_PAPER_ID_PREFIX,
  openalexShortId,
  type ThemePaper,
  workToPaperDict,
} from "../openalexWork.js";
import { prepareTopicGate, type TopicEmbedder, type TopicGateMeta } from "../topicEmbedding.js";
import type { TopicScope } from "../topicScope.js";

export const NEW_PAPERS_SCHEMA_VERSION = "theme-new-papers-v1";
export const NEW_PAPERS_FILENAME = "new-papers.json";
export const FEED_FILENAME = "feed.xml";
/** OpenAlex's OR-filter maximum (`OPENALEX_MAX_OR_VALUES`). */
export const ANCHORS_PER_QUERY = 100;
export const OPENALEX_PAGE_SIZE = 200;
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_MIN_LINEAGE_CITES = 2;
export const DEFAULT_MAX_PAGES = 5;
export const DEFAULT_MAX_ITEMS = 50;
export const MAX_AUTHORS = 5;
/** OpenAlex Work types that can be a "new paper" (paratext, errata,
 * editorials, peer reviews, datasets, … are dropped). OpenAlex types
 * proceedings papers `conference-paper` (29 % of a recorded 2026 citing
 * page, e.g. NeurIPS/ICLR papers): without it every conference paper was
 * silently counted as `excluded_type`. */
export const ALLOWED_WORK_TYPES: ReadonlySet<string> = new Set([
  "article",
  "conference-paper",
  "preprint",
  "review",
  "book-chapter",
  "dissertation",
  "report",
]);
/** Fields of a citing Work: the theme-pipeline fields plus the date and
 * the reference list the ">= 2 lineage papers" test needs. */
export const NEW_PAPERS_SELECT = `${OPENALEX_WORK_SELECT},publication_date,referenced_works`;

export class NewPapersFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewPapersFetchError";
  }
}

export interface NewPapersDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

// ---- lineage input ----

export interface LineageNodeLike {
  id: string;
  title?: unknown;
  short_abstract?: unknown;
  tldr?: unknown;
  aliases?: unknown;
}

export interface LineageArtifactLike {
  nodes: LineageNodeLike[];
  meta: {
    theme?: unknown;
    slug?: unknown;
    seeds?: unknown;
    generated_at?: unknown;
    [k: string]: unknown;
  };
}

/** OpenAlex short ids of every lineage node (node id and `openalex`
 * aliases), sorted and deduplicated. */
export function lineageAnchors(artifact: LineageArtifactLike): string[] {
  const out = new Set<string>();
  for (const node of artifact.nodes) {
    if (typeof node.id === "string" && node.id.startsWith(OPENALEX_PAPER_ID_PREFIX)) {
      const sid = openalexShortId(node.id.slice(OPENALEX_PAPER_ID_PREFIX.length));
      if (sid) out.add(sid);
    }
    if (Array.isArray(node.aliases)) {
      for (const alias of node.aliases) {
        if (Array.isArray(alias) && alias[0] === "openalex") {
          const sid = openalexShortId(alias[1]);
          if (sid) out.add(sid);
        }
      }
    }
  }
  return [...out].sort();
}

/** Map anchor short id -> lineage node id (aliases resolve to their node). */
export function anchorToNodeId(artifact: LineageArtifactLike): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of artifact.nodes) {
    if (typeof node.id !== "string") continue;
    if (node.id.startsWith(OPENALEX_PAPER_ID_PREFIX)) {
      const sid = openalexShortId(node.id.slice(OPENALEX_PAPER_ID_PREFIX.length));
      if (sid) map.set(sid, node.id);
    }
    if (Array.isArray(node.aliases)) {
      for (const alias of node.aliases) {
        if (Array.isArray(alias) && alias[0] === "openalex") {
          const sid = openalexShortId(alias[1]);
          if (sid && !map.has(sid)) map.set(sid, node.id);
        }
      }
    }
  }
  return map;
}

// ---- dates ----

/** `YYYY-MM-DD` of `ms` (UTC). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `[from, to]` for a window of `days` days ending on the day of `nowMs`. */
export function windowFor(nowMs: number, days: number): { from: string; to: string } {
  const to = isoDate(nowMs);
  const from = isoDate(nowMs - (days - 1) * 86_400_000);
  return { from, to };
}

// ---- OpenAlex ----

export interface CitingWorksResult {
  works: Record<string, unknown>[];
  pages: number;
  /** True when `maxPages` stopped the pagination before the end. */
  truncated: boolean;
}

/**
 * Every Work published in `[from, to]` that cites at least one anchor.
 * One `cites:` OR filter per 100 anchors, cursor pagination, at most
 * `maxPages` pages (= credits) in total. Throws {@link NewPapersFetchError}
 * on any failed page.
 */
export async function fetchCitingWorks(
  opts: {
    anchors: readonly string[];
    from: string;
    to: string;
    maxPages: number;
    perPage?: number;
  },
  deps: NewPapersDeps,
): Promise<CitingWorksResult> {
  const perPage = opts.perPage ?? OPENALEX_PAGE_SIZE;
  const byId = new Map<string, Record<string, unknown>>();
  let pages = 0;
  let truncated = false;
  for (let i = 0; i < opts.anchors.length; i += ANCHORS_PER_QUERY) {
    const chunk = opts.anchors.slice(i, i + ANCHORS_PER_QUERY);
    let cursor: string | null = "*";
    while (cursor !== null) {
      if (pages >= opts.maxPages) {
        truncated = true;
        break;
      }
      const resp = await requestWithRetry(
        {
          method: "GET",
          url: OPENALEX_WORKS_URL,
          params: {
            filter: `cites:${chunk.join("|")},from_publication_date:${opts.from},to_publication_date:${opts.to}`,
            "per-page": perPage,
            select: NEW_PAPERS_SELECT,
            cursor,
          },
          headers: { "User-Agent": "PaperPilot/0.1" },
          timeoutMs: 30_000,
        },
        deps,
      );
      pages += 1;
      if (resp === null || resp.status !== 200) {
        throw new NewPapersFetchError(
          `openalex cites query failed (status=${resp ? resp.status : "none"}, page ${pages}); nothing written`,
        );
      }
      let payload: unknown;
      try {
        payload = await resp.json();
      } catch {
        throw new NewPapersFetchError(
          `openalex cites query returned a malformed body (page ${pages})`,
        );
      }
      const obj = (payload && typeof payload === "object" ? payload : {}) as Record<
        string,
        unknown
      >;
      const results = obj.results;
      if (!Array.isArray(results)) {
        throw new NewPapersFetchError(
          `openalex cites query returned no results array (page ${pages})`,
        );
      }
      for (const w of results) {
        if (w && typeof w === "object") {
          const sid = openalexShortId((w as Record<string, unknown>).id);
          if (sid && !byId.has(sid)) byId.set(sid, w as Record<string, unknown>);
        }
      }
      const meta = (obj.meta && typeof obj.meta === "object" ? obj.meta : {}) as Record<
        string,
        unknown
      >;
      const next = meta.next_cursor;
      cursor = typeof next === "string" && next && results.length > 0 ? next : null;
    }
    if (truncated) break;
  }
  return { works: [...byId.values()], pages, truncated };
}

// ---- selection ----

export interface Candidate {
  paper: ThemePaper;
  publicationDate: string;
  type: string | null;
  citesLineage: string[];
}

export interface SelectionStats {
  fetched: number;
  in_lineage: number;
  excluded_type: number;
  below_min_cites: number;
}

function normTitle(t: string): string {
  return t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Keep the works that (a) are not lineage nodes, (b) have an allowed type
 * and a publication date inside the window, and (c) cite at least
 * `minLineageCites` distinct lineage nodes. Duplicate titles (a preprint
 * and its published version) keep the first after sorting.
 */
export function selectCandidates(
  works: readonly Record<string, unknown>[],
  artifact: LineageArtifactLike,
  opts: { minLineageCites: number; from: string; to: string },
): { candidates: Candidate[]; stats: SelectionStats } {
  const anchorMap = anchorToNodeId(artifact);
  const lineageIds = new Set(artifact.nodes.map((n) => n.id));
  const stats: SelectionStats = {
    fetched: works.length,
    in_lineage: 0,
    excluded_type: 0,
    below_min_cites: 0,
  };
  const out: Candidate[] = [];
  for (const work of works) {
    const sid = openalexShortId(work.id);
    if (!sid) continue;
    if (anchorMap.has(sid) || lineageIds.has(`${OPENALEX_PAPER_ID_PREFIX}${sid}`)) {
      stats.in_lineage += 1;
      continue;
    }
    const type = typeof work.type === "string" ? work.type : null;
    const date = typeof work.publication_date === "string" ? work.publication_date : "";
    if (
      (type !== null && !ALLOWED_WORK_TYPES.has(type)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < opts.from ||
      date > opts.to
    ) {
      stats.excluded_type += 1;
      continue;
    }
    const refs = Array.isArray(work.referenced_works) ? work.referenced_works : [];
    const cited = new Set<string>();
    for (const r of refs) {
      const rid = openalexShortId(r);
      const node = rid ? anchorMap.get(rid) : undefined;
      if (node) cited.add(node);
    }
    if (cited.size < opts.minLineageCites) {
      stats.below_min_cites += 1;
      continue;
    }
    const paper = workToPaperDict(work);
    if (paper === null) {
      stats.excluded_type += 1;
      continue;
    }
    out.push({ paper, publicationDate: date, type, citesLineage: [...cited].sort() });
  }
  out.sort(compareCandidates);
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of out) {
    const key = normTitle(c.paper.title);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return { candidates: deduped, stats };
}

/** More lineage papers cited first, then newest, then id. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.citesLineage.length !== a.citesLineage.length) {
    return b.citesLineage.length - a.citesLineage.length;
  }
  if (a.publicationDate !== b.publicationDate)
    return a.publicationDate < b.publicationDate ? 1 : -1;
  return a.paper.paperId < b.paper.paperId ? -1 : a.paper.paperId > b.paper.paperId ? 1 : 0;
}

// ---- topic gate ----

/** A lineage node as a topic-gate paper (`short_abstract`, else TL;DR, as
 * the abstract — the published artifact carries no full abstract). */
export function nodeAsPaper(node: LineageNodeLike): ThemePaper {
  const abstract =
    typeof node.short_abstract === "string" && node.short_abstract
      ? node.short_abstract
      : typeof node.tldr === "string"
        ? node.tldr
        : "";
  return {
    paperId: node.id,
    title: typeof node.title === "string" ? node.title : "",
    year: null,
    venue: "",
    citationCount: 0,
    abstract,
    authors: [],
    externalIds: {},
  };
}

export interface GatedCandidate extends Candidate {
  z: number | null;
  admittedBy: "topic" | "gate_off";
}

/**
 * Topic gate for citing papers: `TopicScope.admitsDescendant` with the
 * embedding z-score. The z-scores are standardised over the lineage nodes
 * plus every fetched work (also those citing only one lineage paper), the
 * analogue of the BFS's seeds + citing-papers pool; the theme query uses
 * the lineage seeds' centroid. When the embedder is unavailable the
 * term-only rule decides (recorded in `meta`).
 */
export async function applyTopicGate(args: {
  scope: TopicScope;
  artifact: LineageArtifactLike;
  candidates: readonly Candidate[];
  /** Every fetched work as a paper (the z-score pool). */
  pool: readonly ThemePaper[];
  embedder: TopicEmbedder | null;
  logger?: { warn?: (msg: string) => void };
}): Promise<{ kept: GatedCandidate[]; offTopic: number; meta: TopicGateMeta }> {
  const { scope, artifact, candidates } = args;
  if (!scope.options.gate) {
    return {
      kept: candidates.map((c) => ({ ...c, z: null, admittedBy: "gate_off" as const })),
      offTopic: 0,
      meta: {
        method: "terms",
        model: null,
        revision: null,
        thresholds: null,
        pool_size: 0,
        fallback_reason: "topic gate disabled",
      },
    };
  }
  const nodes = artifact.nodes.map(nodeAsPaper);
  const seedIds = new Set(
    Array.isArray(artifact.meta.seeds)
      ? (artifact.meta.seeds as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  );
  const seeds = nodes.filter((n) => seedIds.has(n.paperId));
  const { relevance, meta } = await prepareTopicGate({
    scope,
    seeds: seeds.length > 0 ? seeds : nodes,
    pool: [...nodes, ...args.pool],
    embedder: args.embedder,
    logger: args.logger,
  });
  if (relevance !== null) await relevance.ensure(candidates.map((c) => c.paper));
  const kept: GatedCandidate[] = [];
  let offTopic = 0;
  for (const c of candidates) {
    const z = relevance?.z(c.paper.paperId);
    const verdict = scope.admitsDescendant(c.paper, typeof z === "number" ? z : null);
    if (verdict === "topic") {
      kept.push({
        ...c,
        z: typeof z === "number" ? Math.round(z * 1000) / 1000 : null,
        admittedBy: "topic",
      });
    } else {
      offTopic += 1;
    }
  }
  if (relevance !== null && relevance.unscored > 0) meta.unscored = relevance.unscored;
  return { kept, offTopic, meta };
}

// ---- document ----

export interface NewPapersItem {
  id: string;
  title: string;
  publication_date: string;
  year: number | null;
  authors: string[];
  authors_truncated: boolean;
  venue: string;
  type: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string;
  cites_lineage: string[];
  topic: { admitted_by: "topic" | "gate_off"; z: number | null };
}

export interface NewPapersDoc {
  schema_version: typeof NEW_PAPERS_SCHEMA_VERSION;
  kind: "theme-new-papers";
  theme: string;
  slug: string;
  generated_at: string;
  source: "openalex";
  window: { from: string; to: string; days: number };
  lineage_generated_at: string | null;
  anchor_count: number;
  min_lineage_cites: number;
  topic_gate: TopicGateMeta;
  stats: SelectionStats & {
    pages: number;
    truncated: boolean;
    off_topic: number;
    kept: number;
    capped: number;
  };
  items: NewPapersItem[];
}

/** Landing URL: DOI, else arXiv abs page, else the OpenAlex page. */
export function itemUrl(paper: ThemePaper): string {
  const doi = paper.externalIds.DOI;
  if (doi) return `https://doi.org/${doi}`;
  const arxiv = paper.externalIds.ArXiv;
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  return `https://openalex.org/${paper.paperId.slice(OPENALEX_PAPER_ID_PREFIX.length)}`;
}

export function toItem(c: GatedCandidate): NewPapersItem {
  const names = c.paper.authors.map((a) => a.name).filter(Boolean);
  return {
    id: c.paper.paperId,
    title: c.paper.title.replace(/\s+/g, " ").trim(),
    publication_date: c.publicationDate,
    year: c.paper.year,
    authors: names.slice(0, MAX_AUTHORS),
    authors_truncated: names.length > MAX_AUTHORS,
    venue: c.paper.venue ?? "",
    type: c.type,
    doi: c.paper.externalIds.DOI ?? null,
    arxiv_id: c.paper.externalIds.ArXiv ?? null,
    url: itemUrl(c.paper),
    cites_lineage: c.citesLineage,
    topic: { admitted_by: c.admittedBy, z: c.z },
  };
}

export interface BuildNewPapersOptions {
  slug: string;
  nowMs: number;
  days?: number;
  minLineageCites?: number;
  maxPages?: number;
  maxItems?: number;
}

/** Full pipeline for one theme: fetch, select, gate, document. */
export async function buildNewPapers(
  artifact: LineageArtifactLike,
  scope: TopicScope,
  embedder: TopicEmbedder | null,
  opts: BuildNewPapersOptions,
  deps: NewPapersDeps,
): Promise<NewPapersDoc> {
  const days = opts.days ?? DEFAULT_WINDOW_DAYS;
  const minLineageCites = opts.minLineageCites ?? DEFAULT_MIN_LINEAGE_CITES;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const { from, to } = windowFor(opts.nowMs, days);
  const anchors = lineageAnchors(artifact);
  const fetched =
    anchors.length === 0
      ? { works: [], pages: 0, truncated: false }
      : await fetchCitingWorks(
          { anchors, from, to, maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES },
          deps,
        );
  const { candidates, stats } = selectCandidates(fetched.works, artifact, {
    minLineageCites,
    from,
    to,
  });
  const pool = fetched.works
    .map((w) => workToPaperDict(w))
    .filter((p): p is ThemePaper => p !== null);
  const gated = await applyTopicGate({
    scope,
    artifact,
    candidates,
    pool,
    embedder,
    logger: deps.logger,
  });
  const items = gated.kept.slice(0, maxItems).map(toItem);
  return {
    schema_version: NEW_PAPERS_SCHEMA_VERSION,
    kind: "theme-new-papers",
    theme: typeof artifact.meta.theme === "string" ? artifact.meta.theme : opts.slug,
    slug: opts.slug,
    generated_at: new Date(opts.nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: "openalex",
    window: { from, to, days },
    lineage_generated_at:
      typeof artifact.meta.generated_at === "string" ? artifact.meta.generated_at : null,
    anchor_count: anchors.length,
    min_lineage_cites: minLineageCites,
    topic_gate: gated.meta,
    stats: {
      ...stats,
      pages: fetched.pages,
      truncated: fetched.truncated,
      off_topic: gated.offTopic,
      kept: gated.kept.length,
      capped: Math.max(0, gated.kept.length - items.length),
    },
    items,
  };
}
