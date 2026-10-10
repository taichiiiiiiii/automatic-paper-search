/**
 * R2-14: Semantic Scholar fallback for theme BFS expansion.
 *
 * OpenAlex has no `referenced_works` for many arXiv / NeurIPS records
 * (FlashAttention W4281758439 and its NeurIPS version W7133227460 both
 * list 0; Crossref, OpenCitations and DataCite have nothing either), so
 * an OpenAlex-only ancestor expansion stops at the seeds. Semantic
 * Scholar does have those reference lists (with citation contexts and
 * intents) and the generator already fetches them for relation
 * classification (`S2CitationSource`, cached in `s2_references.json`).
 *
 * {@link S2Expansion.expand} wraps the OpenAlex fetch (`fetchRelated`):
 *  - references: when OpenAlex returns fewer than `minOpenalexReferences`
 *    (default 3) parents, the citing paper's S2 reference list is used
 *    (the same in-run memo as relation classification, so no extra
 *    request when the pair lookups follow);
 *  - citations: when OpenAlex returns no citing paper (outage or empty),
 *    one page of S2 `/citations` is used;
 *  - a node whose id is not an OpenAlex id (an S2 paper kept under its S2
 *    id, see below) is expanded from S2 directly; the old `fetchRelated`
 *    S2 path is only the last resort for it.
 * The OpenAlex candidates come first; S2 adds the ones OpenAlex lacks.
 * Candidates then go through the BFS unchanged: abstract filter,
 * off-topic citation ceiling, title identity, topic gate, width limit.
 *
 * Node ids (contract v1 only requires a non-empty, unique graph-local id;
 * aliases are deduplicated later by `dedupNodesByStrongAlias`):
 *  - an S2 paper is mapped to its OpenAlex Work with ONE batched OpenAlex
 *    request per expansion (`filter=doi:…`, the DOI or the arXiv DataCite
 *    DOI `10.48550/arxiv.<id>`), so it gets the same `openalex:W…` id
 *    every other node has and is folded into an existing node when it is
 *    one; the OpenAlex record is used, with S2's abstract/venue/year
 *    filling gaps and S2's intents/isInfluential kept for ranking;
 *  - an S2 paper OpenAlex does not know (or when that lookup fails) keeps
 *    its 40-hex S2 paperId — the id scheme the S2-primary path and the
 *    deep/conference artifacts already use, which `fetchRelated`,
 *    `S2CitationSource` and the site's Semantic Scholar link understand.
 * The mapped candidate list is cached per node and kind in the lineage
 * cache dir (`s2expand_<kind>_<id>.json`, versioned) only when both S2 and
 * the OpenAlex mapping answered; a failure is never cached (LIN-20).
 *
 * Completeness (LIN-02): the OpenAlex fetch reports into a scratch
 * ledger; its attempt is always forwarded, its failure only when S2 did
 * not recover the list.
 */

import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import type { BuildCompletenessForExpansion } from "../shared/fetchRelated.js";
import { OPENALEX_WORKS_URL, splitByFoundationalPriority } from "./openalexFetch.js";
import {
  arxivIdFromWork,
  extractDoi,
  OPENALEX_PAPER_ID_PREFIX,
  type ThemePaper,
  workToPaperDict,
} from "./openalexWork.js";
import type { RawRef, S2CitationSource, S2EdgePaper } from "./s2Citations.js";
import { readVersionedCache, writeVersionedCache } from "./versionedCache.js";

export const S2_EXPANSION_CACHE_VERSION = "s2-expansion-cache-v1";
/** OpenAlex reference lists shorter than this get the S2 fallback. */
export const DEFAULT_MIN_OPENALEX_REFERENCES = 3;
/** DOIs per OpenAlex `filter=doi:a|b|…` request. */
const OPENALEX_DOI_CHUNK = 40;
const S2_SHA = /^[0-9a-f]{40}$/;
/** S2 `externalIds` kept on a candidate (see {@link s2EdgeToPaper}). */
export const S2_KEPT_EXTERNAL_IDS: readonly string[] = ["DOI", "ArXiv", "MAG"];

export type ExpansionKind = "references" | "citations";

export interface OpenalexLookupDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  email?: string | null;
}

export interface S2ExpansionOptions {
  source: S2CitationSource;
  /** OpenAlex access for the S2 -> OpenAlex id mapping; `null` keeps S2 ids. */
  openalex?: OpenalexLookupDeps | null;
  /** Where the mapped candidate lists are cached; `null` = no cache. */
  cacheDir?: string | null;
  minOpenalexReferences?: number;
  logger?: { warn: (msg: string) => void };
}

export interface S2ExpansionStats {
  /** Expansions (one node, one direction) answered by OpenAlex alone. */
  openalex: number;
  /** Expansions where S2 supplied candidates (fallback). */
  s2: number;
  /** Expansions where OpenAlex was short and S2 had nothing either. */
  neither: number;
  /** S2-supplied candidates: total, mapped to an OpenAlex id, kept as S2 ids. */
  s2Candidates: number;
  mappedToOpenalex: number;
  keptS2Ids: number;
  /** OpenAlex id-mapping requests that failed (S2 ids kept, nothing cached). */
  mappingFailed: number;
  cacheHits: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/** An S2 `citedPaper` / `citingPaper` as the BFS paper dict, keyed by
 * its S2 paperId; `null` when it has no S2 id or title. */
export function s2EdgeToPaper(
  entry: RawRef,
  paper: S2EdgePaper | null | undefined,
): ThemePaper | null {
  if (!paper) return null;
  const pid = str(paper.paperId);
  const title = str(paper.title);
  if (pid === null || !S2_SHA.test(pid) || title === null) return null;
  const externalIds: Record<string, string> = {};
  const ext = paper.externalIds && typeof paper.externalIds === "object" ? paper.externalIds : {};
  // Only the identifiers OpenAlex-derived papers carry too. S2 also lists
  // ACL / DBLP ids; an ACL id next to an arXiv id is two canonical
  // identities for one node, which `dedupNodesByStrongAlias` rejects.
  for (const key of S2_KEPT_EXTERNAL_IDS) {
    const v = ext[key];
    if (typeof v === "string" && v.trim()) externalIds[key] = v.trim();
    else if (typeof v === "number") externalIds[key] = String(v);
  }
  const authors = Array.isArray(paper.authors)
    ? paper.authors
        .map((a) => (a && typeof a === "object" ? str((a as Record<string, unknown>).name) : null))
        .filter((n): n is string => n !== null)
        .map((name) => ({ name }))
    : [];
  const year = typeof paper.year === "number" && Number.isInteger(paper.year) ? paper.year : null;
  return {
    paperId: pid,
    title,
    year,
    venue: str(paper.venue) ?? "",
    citationCount: Number(paper.citationCount) || 0,
    abstract: str(paper.abstract) ?? "",
    authors,
    externalIds,
    _intents: strings(entry.intents),
    _is_influential: typeof entry.isInfluential === "boolean" ? entry.isInfluential : null,
    _contexts: [],
  };
}

/** DOIs under which OpenAlex may know an S2 paper (lower-cased): its DOI
 * and the arXiv DataCite DOI. */
function doisOf(paper: ThemePaper): string[] {
  const out: string[] = [];
  const doi = str(paper.externalIds.DOI);
  if (doi) out.push(doi.toLowerCase());
  const arxiv = str(paper.externalIds.ArXiv);
  if (arxiv) out.push(`10.48550/arxiv.${arxiv.replace(/v\d+$/, "").toLowerCase()}`);
  return out;
}

/**
 * Map S2 papers (keyed by S2 id) to OpenAlex paper dicts with one
 * `filter=doi:…` request per 40 DOIs. Returns `null` when any request
 * failed (callers keep the S2 ids and must not cache the result).
 */
export async function mapS2PapersToOpenalex(
  papers: readonly ThemePaper[],
  deps: OpenalexLookupDeps,
): Promise<Map<string, ThemePaper> | null> {
  const byDoi = new Map<string, string[]>();
  for (const p of papers) {
    for (const doi of doisOf(p)) {
      const list = byDoi.get(doi) ?? [];
      if (!list.includes(p.paperId)) list.push(p.paperId);
      byDoi.set(doi, list);
    }
  }
  const out = new Map<string, ThemePaper>();
  const dois = [...byDoi.keys()];
  for (let i = 0; i < dois.length; i += OPENALEX_DOI_CHUNK) {
    const chunk = dois.slice(i, i + OPENALEX_DOI_CHUNK);
    const params: Record<string, string | number> = {
      filter: `doi:${chunk.join("|")}`,
      "per-page": 200,
    };
    if (deps.email) params.mailto = deps.email;
    const resp = await requestWithRetry(
      {
        method: "GET",
        url: OPENALEX_WORKS_URL,
        params,
        headers: { "User-Agent": "PaperPilot/0.1" },
        timeoutMs: 20_000,
        retry429: { maxRetries: 2, giveUpIfHintAboveMs: 60_000 },
      },
      deps,
    );
    if (resp === null || resp.status !== 200) {
      deps.logger?.warn(
        `s2 expansion: openalex DOI lookup failed (status=${resp ? resp.status : null}); keeping S2 ids`,
      );
      return null;
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return null;
    }
    const results =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).results
        : undefined;
    if (!Array.isArray(results)) return null;
    for (const work of results) {
      if (!work || typeof work !== "object") continue;
      const w = work as Record<string, unknown>;
      const paper = workToPaperDict(w);
      if (paper === null) continue;
      const keys = new Set<string>();
      const doi = extractDoi(w);
      if (doi) keys.add(doi.toLowerCase());
      const arxiv = arxivIdFromWork(w, { allowDataciteDoi: true });
      if (arxiv) keys.add(`10.48550/arxiv.${arxiv.toLowerCase()}`);
      for (const key of keys) {
        for (const s2Id of byDoi.get(key) ?? []) if (!out.has(s2Id)) out.set(s2Id, paper);
      }
    }
  }
  return out;
}

/** The OpenAlex record of an S2 paper, with S2 filling its gaps and
 * S2's edge signals (intents, isInfluential) kept. */
function mergeMapped(oa: ThemePaper, s2: ThemePaper): ThemePaper {
  return {
    ...oa,
    year: oa.year ?? s2.year,
    venue: oa.venue || s2.venue,
    abstract: oa.abstract || s2.abstract,
    authors: oa.authors.length > 0 ? oa.authors : s2.authors,
    externalIds: { ...s2.externalIds, ...oa.externalIds },
    _intents: s2._intents ?? null,
    _is_influential: s2._is_influential ?? null,
    _contexts: [],
  };
}

function isUsableCached(list: unknown): list is ThemePaper[] {
  return (
    Array.isArray(list) &&
    list.every(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        typeof (p as Record<string, unknown>).paperId === "string" &&
        typeof (p as Record<string, unknown>).title === "string",
    )
  );
}

/** Rank S2 candidates like the BFS will (influential first, then by
 * citations), keep foundational-allowlist papers ahead of the cut. */
function rankAndCap(papers: ThemePaper[], limit: number): ThemePaper[] {
  const ranked = papers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const fa = a.p._is_influential === true ? 0 : 1;
      const fb = b.p._is_influential === true ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const d = b.p.citationCount - a.p.citationCount;
      return d !== 0 ? d : a.i - b.i;
    })
    .map(({ p }) => p);
  return splitByFoundationalPriority(ranked, limit);
}

/** Scratch completeness ledger: forwarded to the real one afterwards. */
class ScratchLedger implements BuildCompletenessForExpansion {
  attempted = 0;
  failed = 0;
  expansionAttempted(): void {
    this.attempted += 1;
  }
  expansionFailed(): void {
    this.failed += 1;
  }
  forward(to: BuildCompletenessForExpansion | null | undefined, recovered: boolean): void {
    if (!to) return;
    for (let i = 0; i < this.attempted; i++) to.expansionAttempted();
    if (!recovered) for (let i = 0; i < this.failed; i++) to.expansionFailed();
  }
}

export class S2Expansion {
  readonly stats: S2ExpansionStats = {
    openalex: 0,
    s2: 0,
    neither: 0,
    s2Candidates: 0,
    mappedToOpenalex: 0,
    keptS2Ids: 0,
    mappingFailed: 0,
    cacheHits: 0,
  };
  private readonly opts: S2ExpansionOptions;
  /** (id, kind) pairs already counted: the topic-gate prefetch and the
   * BFS ask for the same seed lists. */
  private readonly counted = new Set<string>();
  readonly minOpenalexReferences: number;

  constructor(options: S2ExpansionOptions) {
    this.opts = options;
    this.minOpenalexReferences = options.minOpenalexReferences ?? DEFAULT_MIN_OPENALEX_REFERENCES;
  }

  /**
   * Candidates for `paper` in direction `kind`: `primary` (the OpenAlex
   * `fetchRelated` call, given a scratch ledger) first, S2 when OpenAlex
   * is short (see module doc). Never throws for an S2 problem.
   */
  async expand(
    paper: ThemePaper,
    kind: ExpansionKind,
    limit: number,
    primary: (ledger: BuildCompletenessForExpansion) => Promise<ThemePaper[]>,
    completeness?: BuildCompletenessForExpansion | null,
  ): Promise<ThemePaper[]> {
    const isOpenalex = paper.paperId.startsWith(OPENALEX_PAPER_ID_PREFIX);
    const key = `${kind}\u0000${paper.paperId}`;
    const first = !this.counted.has(key);
    this.counted.add(key);
    const count = (field: "openalex" | "s2" | "neither", candidates = 0) => {
      if (!first) return;
      this.stats[field] += 1;
      this.stats.s2Candidates += candidates;
    };
    if (!isOpenalex) {
      // An S2-id node: S2 first, the generic fetchRelated S2 path last.
      const fromS2 = await this.related(paper, kind, limit);
      if (fromS2 !== null) {
        count("s2", fromS2.length);
        return fromS2;
      }
      return primary(completeness ?? new ScratchLedger());
    }
    const scratch = new ScratchLedger();
    const got = await primary(scratch);
    const enough = kind === "references" ? this.minOpenalexReferences : 1;
    if (got.length >= enough) {
      scratch.forward(completeness, false);
      count("openalex");
      return got;
    }
    const fromS2 = await this.related(paper, kind, limit);
    const have = new Set(got.map((p) => p.paperId));
    const extra = (fromS2 ?? []).filter((p) => !have.has(p.paperId));
    if (extra.length === 0) {
      scratch.forward(completeness, false);
      count(got.length > 0 ? "openalex" : "neither");
      return got;
    }
    scratch.forward(completeness, true);
    count("s2", extra.length);
    if (scratch.failed > 0) {
      this.opts.logger?.warn(
        `s2 expansion: openalex ${kind} for ${paper.paperId} failed; recovered ${extra.length} candidate(s) from Semantic Scholar`,
      );
    }
    return [...got, ...extra];
  }

  /** S2 candidates for `paper` (mapped to OpenAlex ids where possible),
   * or `null` when S2 has nothing / could not be reached. */
  async related(
    paper: ThemePaper,
    kind: ExpansionKind,
    limit: number,
  ): Promise<ThemePaper[] | null> {
    const cachePath = this.cachePath(paper.paperId, kind);
    if (cachePath !== null) {
      const cached = readVersionedCache(cachePath, S2_EXPANSION_CACHE_VERSION);
      if (isUsableCached(cached)) {
        this.stats.cacheHits += 1;
        return cached;
      }
    }
    const asRecord = paper as unknown as Record<string, unknown>;
    const raw =
      kind === "references"
        ? await this.opts.source.referenceList(asRecord)
        : await this.opts.source.citationList(asRecord);
    if (raw === null) return null;
    const seen = new Set<string>();
    const s2Papers: ThemePaper[] = [];
    for (const entry of raw) {
      const p = s2EdgeToPaper(entry, kind === "references" ? entry.citedPaper : entry.citingPaper);
      if (p === null || seen.has(p.paperId)) continue;
      seen.add(p.paperId);
      s2Papers.push(p);
    }
    const kept = rankAndCap(s2Papers, limit);
    let mapped: Map<string, ThemePaper> | null = new Map();
    if (this.opts.openalex && kept.length > 0) {
      mapped = await mapS2PapersToOpenalex(kept, this.opts.openalex);
      if (mapped === null) this.stats.mappingFailed += 1;
    }
    const out: ThemePaper[] = [];
    const outIds = new Set<string>();
    for (const p of kept) {
      const oa = mapped?.get(p.paperId);
      const candidate = oa ? mergeMapped(oa, p) : p;
      if (candidate.paperId === paper.paperId || outIds.has(candidate.paperId)) continue;
      outIds.add(candidate.paperId);
      out.push(candidate);
      if (oa) this.stats.mappedToOpenalex += 1;
      else this.stats.keptS2Ids += 1;
    }
    if (cachePath !== null && mapped !== null) {
      writeVersionedCache(cachePath, S2_EXPANSION_CACHE_VERSION, out);
    }
    return out;
  }

  private cachePath(id: string, kind: ExpansionKind): string | null {
    const dir = this.opts.cacheDir ?? null;
    if (dir === null) return null;
    return `${dir}/s2expand_${kind}_${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  }

  /** `expansion sources: openalex=N s2=M …` (one line for the CI log). */
  summary(): string {
    const s = this.stats;
    return (
      `expansion sources: openalex=${s.openalex} s2=${s.s2} (neither=${s.neither}; ` +
      `s2 candidates=${s.s2Candidates}, mapped to openalex ids=${s.mappedToOpenalex}, ` +
      `kept s2 ids=${s.keptS2Ids}, id-mapping failures=${s.mappingFailed}, cache hits=${s.cacheHits})`
    );
  }
}
