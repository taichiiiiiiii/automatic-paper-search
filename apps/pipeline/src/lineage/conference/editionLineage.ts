/**
 * R2-32 (design 41): LLM-free conference ("edition") lineage.
 *
 * A conference lineage shows where the edition's most influential papers
 * come from and what they led to:
 *
 *  1. Seeds — the catalog papers of the edition ranked by Semantic Scholar
 *     citation count. One S2 bulk search (`venue=<venue>&year=<year>`,
 *     citation count descending) ranks the edition; each hit is matched to
 *     exactly one catalog row by arXiv id, else by normalized title (an
 *     ambiguous title on either side matches nothing). Surveys are skipped.
 *     The ranking is cached (`conference_seeds.json`, {@link SEED_TTL_DAYS})
 *     so a rebuild inside the window picks the same seeds.
 *  2. Ancestors — each seed's S2 reference list (contexts / intents /
 *     isInfluential): influential references first, then by citation count.
 *  3. Descendants — each seed's S2 citing papers (one page), by citation
 *     count.
 *  4. A cross-node pass over the reference lists already read in this run
 *     (seeds and descendants): in-graph citations not seen above.
 *
 * Every pair is classified by the theme pipeline's no-LLM classifier
 * (`theme/noLlmRelation.ts::classifyPairApiOnly`: title versions, S2
 * citation-context rules with optional arXiv HTML contexts, the LLM-free
 * rules, else `api_citation`), so the evidence rules and the strong-claim
 * policy (design 41 D5) are the theme rules. Identity: a focus node carries
 * the catalog `paper_id` as `seed_paper_id` and the catalog's OpenReview /
 * arXiv / DOI aliases; every node id is the S2 paper id.
 *
 * Network access goes through one `S2CitationSource` (paced, cached in
 * `s2_references.json`, failures distinct from "no such paper"), so the
 * build is deterministic for a given cache and fails closed: a failed
 * venue search is an incomplete subject (CLI exit 4), a failed seed list an
 * incomplete expansion (shrink guard), a failed citing-paper lookup a
 * `citation_heuristic` edge (evidence-rate gate, exit 5).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IdentityError, normalizeAlias } from "@paperpilot/core/identity";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import { atomicWriteText } from "../../collect/state/atomic.js";
import {
  LINEAGE_ARTIFACT_VERSION,
  requirePaperId,
  requireValidLineageArtifact,
} from "../contract/v1.js";
import type { BuildCompleteness } from "../fetch-state/completeness.js";
import { type ThemeGraphNode, toNode } from "../shared/node.js";
import { isSurveyLike } from "../shared/surveyLike.js";
import type { ArxivHtmlContextSource } from "../theme/arxivHtmlSource.js";
import { classifyPairApiOnly, newNoLlmCounters, noLlmProvenance } from "../theme/noLlmRelation.js";
import {
  normTitle,
  type RawRef,
  type S2CitationSource,
  type S2EdgePaper,
} from "../theme/s2Citations.js";
import { newS2RelationStats, type S2RelationContext } from "../theme/s2Relations.js";
import { buildClusters } from "./buildLineage.js";

export const PRODUCER_NAME = "paperpilot.lineage.conference.edition";
export const PRODUCER_VERSION = "1";
export const CLASSIFICATION_SCHEMA_VERSION = "edition-lineage-v1";
/** Default seeds / ancestors per seed / descendants per seed. */
export const DEFAULT_SEEDS = 12;
export const DEFAULT_PARENTS = 6;
export const DEFAULT_CHILDREN = 6;
/** Rows read from the ranked venue search (one S2 page). */
export const VENUE_RANK_LIMIT = 1000;
/** Ranked hits kept (and cached): enough to fill the seeds after catalog
 * matching (>= 90% of hits match on ICML 2025), small enough for git. */
export const RANKED_HITS_KEPT = 300;
export const SEED_CACHE_FILENAME = "conference_seeds.json";
export const SEED_CACHE_SCHEMA = "conference-seeds-v1";
export const SEED_TTL_DAYS = 30;
const DAY_MS = 86_400_000;
const S2_ID_RE = /^[0-9a-f]{40}$/;

/** S2 `venue=` filter per conference family (slug prefix). */
export const S2_VENUES: Readonly<Record<string, string>> = {
  aaai: "AAAI",
  acl: "ACL",
  cvpr: "CVPR",
  eccv: "ECCV",
  emnlp: "EMNLP",
  iccv: "ICCV",
  iclr: "ICLR",
  icml: "ICML",
  neurips: "NeurIPS",
};

type PaperLike = Record<string, unknown>;

export interface EditionLineageOptions {
  conference: string;
  docsRoot: string;
  seeds?: number;
  parents?: number;
  children?: number;
  /** Overrides {@link S2_VENUES}. */
  s2Venue?: string | null;
  completeness: BuildCompleteness;
}

export interface EditionLineageDeps {
  s2: S2CitationSource;
  arxivHtml?: ArxivHtmlContextSource | null;
  /** Seed-ranking cache file (`null` = no cache). */
  seedCachePath: string | null;
  now: () => Date;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

/** `iclr-2026` -> family `iclr`, year 2026. */
export function editionOf(conference: string): { family: string; year: number } {
  validateConferenceSlug(conference);
  const m = /^([a-z0-9-]+?)-(\d{4})$/.exec(conference);
  if (!m) throw new Error(`conference slug must end in a year: ${conference}`);
  return { family: m[1]!, year: Number(m[2]) };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Normalized arXiv id or null (never throws). */
function arxivOf(raw: unknown): string | null {
  const s = str(raw);
  if (s === null) return null;
  try {
    return normalizeAlias("arxiv", s)[1];
  } catch (e) {
    if (e instanceof IdentityError) return null;
    throw e;
  }
}

function aliasIfValid(ns: string, raw: unknown): [string, string] | null {
  const s = str(raw);
  if (s === null) return null;
  try {
    const [n, v] = normalizeAlias(ns, s);
    return n === ns && v === s ? [n, v] : null;
  } catch (e) {
    if (e instanceof IdentityError) return null;
    throw e;
  }
}

// ---- seed ranking -------------------------------------------------------

export interface RankedHit {
  paperId: string;
  title: string;
  year: number | null;
  citationCount: number;
  arxiv: string | null;
  doi: string | null;
  venue: string | null;
  authors: string[];
}

export interface SeedCacheEntry {
  fetched_at: string;
  venue: string;
  year: number;
  hits: RankedHit[];
}

function readSeedCache(path: string | null): Record<string, SeedCacheEntry> {
  if (path === null || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.schema_version !== SEED_CACHE_SCHEMA) return {};
    const entries = raw.entries;
    return entries && typeof entries === "object" && !Array.isArray(entries)
      ? (entries as Record<string, SeedCacheEntry>)
      : {};
  } catch {
    return {};
  }
}

function writeSeedCache(path: string, entries: Record<string, SeedCacheEntry>): void {
  if (!existsSync(dirname(path))) return;
  const keys = Object.keys(entries).sort();
  const lines = keys.map(
    (k, i) =>
      `    ${JSON.stringify(k)}: ${JSON.stringify(entries[k])}${i < keys.length - 1 ? "," : ""}`,
  );
  atomicWriteText(
    path,
    `{\n  "schema_version": ${JSON.stringify(SEED_CACHE_SCHEMA)},\n  "entries": {\n` +
      `${lines.join("\n")}${lines.length ? "\n" : ""}  }\n}\n`,
  );
}

function hitOf(p: S2EdgePaper): RankedHit | null {
  const id = str(p.paperId);
  const title = str(p.title);
  if (id === null || !S2_ID_RE.test(id) || title === null) return null;
  const ext = (p.externalIds ?? {}) as Record<string, unknown>;
  const authors = Array.isArray(p.authors)
    ? (p.authors as unknown[])
        .map((a) => (a && typeof a === "object" ? str((a as PaperLike).name) : null))
        .filter((x): x is string => x !== null)
    : [];
  return {
    paperId: id,
    title,
    year: typeof p.year === "number" ? p.year : null,
    citationCount: num(p.citationCount),
    arxiv: arxivOf(ext.ArXiv),
    doi: str(ext.DOI),
    venue: str(p.venue),
    authors: authors.slice(0, 5),
  };
}

/** The ranked S2 hits for the edition (cache first). `null` = S2 failed. */
export async function rankedEdition(
  conference: string,
  venue: string,
  year: number,
  deps: EditionLineageDeps,
): Promise<{ hits: RankedHit[]; fetchedAt: string; cached: boolean } | null> {
  const cache = readSeedCache(deps.seedCachePath);
  const entry = cache[conference];
  const nowMs = deps.now().getTime();
  if (
    entry &&
    entry.venue === venue &&
    entry.year === year &&
    Array.isArray(entry.hits) &&
    nowMs - Date.parse(entry.fetched_at) < SEED_TTL_DAYS * DAY_MS &&
    nowMs >= Date.parse(entry.fetched_at)
  ) {
    return {
      hits: entry.hits.slice(0, RANKED_HITS_KEPT),
      fetchedAt: entry.fetched_at,
      cached: true,
    };
  }
  const raw = await deps.s2.searchVenue(venue, year, { limit: VENUE_RANK_LIMIT });
  if (raw === null) return null;
  const hits = raw
    .map(hitOf)
    .filter((h): h is RankedHit => h !== null)
    .sort((a, b) => b.citationCount - a.citationCount || (a.paperId < b.paperId ? -1 : 1))
    .slice(0, RANKED_HITS_KEPT);
  const fetchedAt = `${deps.now().toISOString().slice(0, 19)}Z`;
  if (deps.seedCachePath !== null && hits.length > 0) {
    writeSeedCache(deps.seedCachePath, {
      ...readSeedCache(deps.seedCachePath),
      [conference]: { fetched_at: fetchedAt, venue, year, hits },
    });
  }
  return { hits, fetchedAt, cached: false };
}

export interface MatchedSeed {
  hit: RankedHit;
  row: PaperLike;
  paperId: string;
  matchedBy: "arxiv" | "title";
}

/**
 * Match ranked hits to catalog rows: arXiv id first, else normalized
 * title; a key shared by two catalog rows (or two hits) matches nothing.
 * Order = the ranking (citation count desc, then S2 id), deterministic.
 */
export function matchCatalog(
  hits: readonly RankedHit[],
  rows: readonly PaperLike[],
): MatchedSeed[] {
  const byArxiv = new Map<string, PaperLike | null>();
  const byTitle = new Map<string, PaperLike | null>();
  for (const row of rows) {
    const ax = arxivOf(row.arxiv_id);
    if (ax !== null) byArxiv.set(ax, byArxiv.has(ax) ? null : row);
    const t = normTitle(row.title);
    if (t.length >= 8) byTitle.set(t, byTitle.has(t) ? null : row);
  }
  const hitTitles = new Map<string, number>();
  for (const h of hits)
    hitTitles.set(normTitle(h.title), (hitTitles.get(normTitle(h.title)) ?? 0) + 1);
  const ordered = [...hits].sort(
    (a, b) => b.citationCount - a.citationCount || (a.paperId < b.paperId ? -1 : 1),
  );
  const out: MatchedSeed[] = [];
  const usedRows = new Set<PaperLike>();
  const usedIds = new Set<string>();
  for (const hit of ordered) {
    if (usedIds.has(hit.paperId)) continue;
    let row: PaperLike | null | undefined = hit.arxiv ? byArxiv.get(hit.arxiv) : undefined;
    let matchedBy: MatchedSeed["matchedBy"] = "arxiv";
    if (!row) {
      const t = normTitle(hit.title);
      row = hitTitles.get(t) === 1 ? byTitle.get(t) : undefined;
      matchedBy = "title";
    }
    if (!row || usedRows.has(row)) continue;
    let paperId: string;
    try {
      paperId = requirePaperId(row.paper_id);
    } catch {
      continue;
    }
    usedRows.add(row);
    usedIds.add(hit.paperId);
    out.push({ hit, row, paperId, matchedBy });
  }
  return out;
}

// ---- graph --------------------------------------------------------------

function paperOf(p: S2EdgePaper | RankedHit | null | undefined): PaperLike | null {
  if (!p) return null;
  const id = str((p as PaperLike).paperId);
  if (id === null || !S2_ID_RE.test(id)) return null;
  if ("citationCount" in p && Array.isArray((p as RankedHit).authors) && "arxiv" in p) {
    const h = p as RankedHit;
    const externalIds: Record<string, string> = {};
    if (h.arxiv) externalIds.ArXiv = h.arxiv;
    if (h.doi) externalIds.DOI = h.doi;
    return {
      paperId: h.paperId,
      title: h.title,
      year: h.year,
      venue: h.venue ?? "",
      citationCount: h.citationCount,
      authors: h.authors.map((name) => ({ name })),
      externalIds,
    };
  }
  const e = p as S2EdgePaper;
  return {
    paperId: id,
    title: str(e.title) ?? "",
    year: typeof e.year === "number" ? e.year : null,
    venue: str(e.venue) ?? "",
    citationCount: num(e.citationCount),
    authors: Array.isArray(e.authors) ? e.authors : [],
    externalIds: e.externalIds ?? {},
    abstract: str(e.abstract) ?? "",
  };
}

/** `fetchRelated`-style intent record for the classifier. */
function intentRecordOf(paper: PaperLike, ref: RawRef | null): PaperLike {
  return {
    ...paper,
    _is_influential: ref && typeof ref.isInfluential === "boolean" ? ref.isInfluential : null,
    _intents: ref && Array.isArray(ref.intents) ? ref.intents.map(String) : null,
  };
}

function rankRefs(refs: readonly RawRef[], side: "citedPaper" | "citingPaper"): RawRef[] {
  const usable = refs.filter((r) => paperOf(r[side]) !== null);
  return usable.sort((a, b) => {
    const fa = a.isInfluential === true ? 1 : 0;
    const fb = b.isInfluential === true ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const ca = num(a[side]?.citationCount);
    const cb = num(b[side]?.citationCount);
    if (ca !== cb) return cb - ca;
    const ia = String(a[side]?.paperId);
    const ib = String(b[side]?.paperId);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

interface EdgeOut {
  src: string;
  dst: string;
  rel: string;
  relation: string;
  conf: number;
  confidence: number;
  rationale: string;
  provenance: Record<string, unknown>;
}

export interface EditionLineageResult {
  artifact: Record<string, unknown>;
  /** Seeds dropped because no edge connected them. */
  droppedSeeds: string[];
}

/** Build the edition lineage (no write). */
export async function buildEditionLineage(
  options: EditionLineageOptions,
  deps: EditionLineageDeps,
): Promise<EditionLineageResult> {
  const { conference, docsRoot, completeness } = options;
  const seedsWanted = options.seeds ?? DEFAULT_SEEDS;
  const parentsWanted = options.parents ?? DEFAULT_PARENTS;
  const childrenWanted = options.children ?? DEFAULT_CHILDREN;
  const { family, year } = editionOf(conference);
  const venue = options.s2Venue ?? S2_VENUES[family];
  if (!venue) throw new Error(`no S2 venue known for ${conference}; pass --s2-venue`);
  const log = deps.logger ?? { warn: () => {} };
  const rows = JSON.parse(
    readFileSync(join(docsRoot, conference, "papers.json"), "utf8"),
  ) as PaperLike[];
  const catalogIds = new Set(
    rows.map((r) => r.paper_id).filter((x): x is string => typeof x === "string"),
  );

  const ranked = await rankedEdition(conference, venue, year, deps);
  if (ranked === null) {
    completeness.subjectFailed(`S2 venue search ${venue} ${year} failed`);
    throw new Error(`S2 venue search for ${venue} ${year} could not be completed`);
  }
  const matched = matchCatalog(ranked.hits, rows).filter(
    (m) => !isSurveyLike({ title: m.hit.title }),
  );
  log.warn(
    `edition ranking: venue=${venue} year=${year} hits=${ranked.hits.length} ` +
      `matched=${matched.length}/${rows.length} catalog rows (${ranked.cached ? "cached" : "fetched"} ${ranked.fetchedAt})`,
  );
  const chosen = matched.slice(0, seedsWanted);
  if (chosen.length === 0) {
    completeness.subjectFailed(`no catalog paper of ${conference} matched the S2 ranking`);
    throw new Error(`no catalog paper of ${conference} matched the S2 venue ranking`);
  }

  const s2ctx: S2RelationContext = {
    source: deps.s2,
    provider: null,
    stats: newS2RelationStats(),
    arxivHtml: deps.arxivHtml ?? null,
  };
  const counters = newNoLlmCounters();
  const papers = new Map<string, PaperLike>();
  const focusInfo = new Map<string, MatchedSeed>();
  const edges = new Map<string, EdgeOut>();
  const citingLists: PaperLike[] = [];

  const addEdge = async (parent: PaperLike, child: PaperLike, intent: PaperLike): Promise<void> => {
    const src = parent.paperId as string;
    const dst = child.paperId as string;
    if (src === dst || edges.has(`${src}\u0000${dst}`) || edges.has(`${dst}\u0000${src}`)) return;
    const derived = await classifyPairApiOnly(
      parent,
      child,
      intent,
      s2ctx,
      counters,
      "semantic_scholar",
    );
    if (derived === null || (derived.relation as string) === "unrelated") return;
    edges.set(`${src}\u0000${dst}`, {
      src,
      dst,
      rel: derived.relation,
      relation: derived.relation,
      conf: derived.confidence,
      confidence: derived.confidence,
      rationale: derived.rationale,
      provenance: noLlmProvenance(derived, {
        producerName: PRODUCER_NAME,
        producerVersion: PRODUCER_VERSION,
        classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
        srcId: src,
        dstId: dst,
        parent,
        child,
        intentRecord: intent,
      }),
    });
  };

  for (const seed of chosen) {
    const seedPaper = paperOf(seed.hit) as PaperLike;
    papers.set(seed.hit.paperId, seedPaper);
    focusInfo.set(seed.hit.paperId, seed);
  }

  for (const seed of chosen) {
    const seedPaper = papers.get(seed.hit.paperId) as PaperLike;
    completeness.expansionAttempted();
    const refs = await deps.s2.referenceList(seedPaper);
    if (refs === null && deps.s2.lastListFailed) completeness.expansionFailed("references");
    if (refs !== null) citingLists.push(seedPaper);
    for (const ref of rankRefs(refs ?? [], "citedPaper").slice(0, parentsWanted)) {
      const parent = paperOf(ref.citedPaper) as PaperLike;
      const known = papers.get(parent.paperId as string) ?? parent;
      papers.set(known.paperId as string, known);
      await addEdge(known, seedPaper, intentRecordOf(known, ref));
    }
    completeness.expansionAttempted();
    const cites = await deps.s2.citationList(seedPaper);
    if (cites === null && deps.s2.lastListFailed) completeness.expansionFailed("citations");
    for (const ref of rankRefs(cites ?? [], "citingPaper").slice(0, childrenWanted)) {
      const child = paperOf(ref.citingPaper) as PaperLike;
      const known = papers.get(child.paperId as string) ?? child;
      papers.set(known.paperId as string, known);
      await addEdge(seedPaper, known, intentRecordOf(seedPaper, ref));
      if (!citingLists.includes(known)) citingLists.push(known);
    }
  }

  // Cross-node pass: reference lists already read this run (memo; no new
  // request for the seeds, at most one per descendant whose lookup failed).
  let crossAdded = 0;
  for (const citing of citingLists) {
    const refs = await deps.s2.referenceList(citing);
    if (refs === null) continue;
    for (const ref of refs) {
      const cited = paperOf(ref.citedPaper);
      if (cited === null || !papers.has(cited.paperId as string)) continue;
      const before = edges.size;
      const known = papers.get(cited.paperId as string) as PaperLike;
      await addEdge(known, citing, intentRecordOf(known, ref));
      if (edges.size > before) crossAdded += 1;
    }
  }
  if (crossAdded > 0) log.warn(`cross-node pass added ${crossAdded} edge(s)`);

  // Nodes: keep everything an edge touches; a seed with no edge is dropped.
  const degree = new Map<string, number>();
  for (const e of edges.values()) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const droppedSeeds = chosen
    .filter((s) => !degree.has(s.hit.paperId))
    .map((s) => s.paperId)
    .sort();
  const venueLabel = `${S2_VENUES[family] ?? family.toUpperCase()} ${year}`;
  const usedAliases = new Set<string>();
  const nodes: ThemeGraphNode[] = [];
  for (const id of [...degree.keys()].sort()) {
    const paper = papers.get(id) as PaperLike;
    const seed = focusInfo.get(id);
    const aliases: [string, string][] = [];
    const ext = (paper.externalIds ?? {}) as Record<string, unknown>;
    const candidates: ([string, string] | null)[] = [
      seed && seed.row.source === "openreview"
        ? aliasIfValid("openreview", seed.row.source_id)
        : null,
      aliasIfValid("arxiv", arxivOf(ext.ArXiv) ?? (seed ? arxivOf(seed.row.arxiv_id) : null)),
      (() => {
        const d = str(ext.DOI);
        if (d === null) return null;
        try {
          return normalizeAlias("doi", d) as [string, string];
        } catch (e) {
          if (e instanceof IdentityError) return null;
          throw e;
        }
      })(),
    ];
    for (const a of candidates) {
      if (a === null) continue;
      const key = `${a[0]}\u0000${a[1]}`;
      if (usedAliases.has(key)) continue;
      usedAliases.add(key);
      aliases.push(a);
    }
    // Only catalog abstracts with an open licence are published; S2
    // abstracts are read for classification but never written.
    const license = seed ? str(seed.row.abstract_license) : null;
    const openAbstract =
      seed && license !== null && /^(CC0|CC-BY)/i.test(license)
        ? (str(seed.row.abstract) ?? "")
        : "";
    const node = toNode({ ...paper, abstract: openAbstract } as never, {
      focus: seed !== undefined,
      kinds:
        seed && Array.isArray(seed.row.tags) && seed.row.tags.length > 0
          ? (seed.row.tags as string[]).slice(0, 3)
          : [],
      ...(seed ? { overrideVenue: venueLabel, overrideTier: "A+" } : {}),
    });
    node.is_focus = seed !== undefined;
    if (seed) (node as Record<string, unknown>).seed_paper_id = seed.paperId;
    if (aliases.length > 0) node.aliases = aliases;
    nodes.push(node);
  }

  const orderedEdges = [...edges.values()].sort((a, b) =>
    a.src !== b.src ? (a.src < b.src ? -1 : 1) : a.dst !== b.dst ? (a.dst < b.dst ? -1 : 1) : 0,
  );
  const focusIds = nodes
    .filter((n) => n.is_focus)
    .map((n) => n.id)
    .sort();
  const root =
    focusIds.length === 0
      ? null
      : focusIds.reduce((best, c) => {
          const d = (degree.get(c) ?? 0) - (degree.get(best) ?? 0);
          return d > 0 || (d === 0 && c < best) ? c : best;
        }, focusIds[0]!);
  const breakdown: Record<string, number> = {};
  for (const e of orderedEdges) {
    const method = String(
      ((e.provenance.classification ?? {}) as Record<string, unknown>).method ?? "unknown",
    );
    breakdown[method] = (breakdown[method] ?? 0) + 1;
  }
  const sortedBreakdown = Object.fromEntries(
    Object.keys(breakdown)
      .sort()
      .map((k) => [k, breakdown[k]]),
  );
  log.warn(
    `lineage-llm: off (API evidence only) — api_citation=${counters.apiCitationEdges}, ` +
      `s2_unreachable=${counters.s2Unreachable}, rule=${s2ctx.stats.rule}`,
  );
  const artifact: Record<string, unknown> = {
    schema_version: LINEAGE_ARTIFACT_VERSION,
    root,
    nodes,
    edges: orderedEdges,
    clusters: buildClusters(nodes),
    meta: {
      kind: "conference",
      conference,
      generator: PRODUCER_NAME,
      generated_at: `${deps.now().toISOString().slice(0, 19)}Z`,
      lineage_llm: "off",
      seed_policy: {
        method: "s2_venue_citation_rank",
        venue,
        year,
        ranking_fetched_at: ranked.fetchedAt,
        ranked_hits: ranked.hits.length,
        matched_catalog_rows: matched.length,
        seeds: seedsWanted,
        parents_per_seed: parentsWanted,
        children_per_seed: childrenWanted,
      },
      seeds: chosen.map((s) => s.paperId),
      ...(droppedSeeds.length > 0 ? { dropped_seeds: droppedSeeds } : {}),
      provenance_breakdown: sortedBreakdown,
    },
  };
  requireValidLineageArtifact(artifact, { kind: "conference", catalogIds });
  return { artifact, droppedSeeds };
}
