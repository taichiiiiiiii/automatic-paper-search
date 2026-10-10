/**
 * Theme seed discovery — TS port of the orchestration layer in
 * `paperpilot/scripts/build_theme_lineage.py`: `_resolve_openalex_to_s2`,
 * `_apply_seed_filters`, `_openalex_search_per_keyword`,
 * `_discover_seeds_openalex_primary`, `_search_one_keyword_via_s2`,
 * `_top_up_via_openalex`, `discover_seeds`, `_is_survey`,
 * `_compute_seed_score`, `_rank_and_truncate`.
 *
 * Safety contracts: LIN-15 (seed-search failures record a subject
 * failure rather than collapsing to a plain empty seed set), LIN-20
 * (S2's own transient failures — non-200, malformed body — must not be
 * cached as a genuine empty answer), LIN-21 (S2 `/paper/batch`
 * `allow_none=true`: a `null` entry is an accepted non-match; a broken
 * non-null entry or a short page is a subject failure), LIN-27
 * (`fieldsOfStudy` API-level gate on the S2 search).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import { firstUnusable } from "../../collect/signals/payload.js";
import { isSurveyLike, type SurveyPaperLike } from "../shared/surveyLike.js";
import {
  type BuildCompletenessLike,
  discoverSeedsViaOpenalex,
  type OpenAlexDeps,
} from "./openalexFetch.js";
import { extractDoi, openalexShortId, type ThemePaper, workToPaperDict } from "./openalexWork.js";
import { s2PaperShape } from "./payloadShape.js";
import {
  filterDenylistedSeeds,
  filterThemeBlacklist,
  filterTopicRelevantSeeds,
  type ThemeSeedLike,
} from "./seedFilters.js";
import { TopicScope } from "./topicScope.js";
import { readVersionedCache, writeVersionedCache } from "./versionedCache.js";

// ---- S2 endpoints (seed discovery only; BFS over S2 is out of this
// port's scope — see the brief's "legacy S2-primary path" note) ----

const S2_FIELDS_SEARCH = "paperId,title,year,venue,citationCount,authors,abstract,externalIds";
const S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_SEARCH_LIMIT = 50;
/** LIN-27: scope S2 search to AI/CS-adjacent fields so the topic filter
 * isn't the only thing standing between us and medical/biology papers
 * sharing generic theme words. */
const S2_FIELDS_OF_STUDY = "Computer Science,Mathematics,Linguistics";
const S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch";
/** `/paper/batch` caps at 500 ids per call; cap our send to half of that
 * so even a wide OpenAlex page can never overflow. */
const S2_BATCH_MAX_IDS = 250;

export const SEARCH_CACHE_VERSION = "s2-search-cache-v1";

export interface DiscoverSeedsDeps extends OpenAlexDeps {
  fetchImpl: FetchLike;
  cacheDir: string;
}

interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

async function s2Get(
  method: "GET" | "POST",
  url: string,
  options: { params?: Record<string, string | number>; jsonBody?: unknown; timeoutMs: number },
  deps: DiscoverSeedsDeps,
): Promise<HttpResponseLike | null> {
  return (await requestWithRetry(
    {
      method,
      url,
      params: options.params,
      jsonBody: options.jsonBody,
      headers: { "User-Agent": "PaperPilot/0.1" },
      timeoutMs: options.timeoutMs,
    },
    deps,
  )) as HttpResponseLike | null;
}

// ---- _resolve_openalex_to_s2 ----

/** POST OpenAlex DOIs to S2 `/paper/batch`; return S2-shape dicts.
 * Returns `[]` on error (never `null`) so callers fall through to
 * whatever S2 search managed to surface; the failure is recorded in
 * `completeness` (LIN-15/21) when one is supplied. */
export async function resolveOpenalexToS2(
  works: readonly Record<string, unknown>[],
  deps: DiscoverSeedsDeps,
  completeness?: BuildCompletenessLike | null,
): Promise<ThemePaper[]> {
  const ids: string[] = [];
  for (const work of works) {
    const doi = extractDoi(work);
    if (!doi) continue;
    ids.push(`DOI:${doi}`);
    if (ids.length >= S2_BATCH_MAX_IDS) break;
  }
  if (ids.length === 0) return [];

  const resp = await s2Get(
    "POST",
    S2_BATCH_URL,
    { params: { fields: S2_FIELDS_SEARCH }, jsonBody: { ids }, timeoutMs: 30_000 },
    deps,
  );
  if (resp === null || resp.status !== 200) {
    const status = resp ? resp.status : null;
    deps.logger?.warn(`S2 /paper/batch failed (status=${status}) — OpenAlex DOIs unresolved`);
    completeness?.subjectFailed(
      `s2 /paper/batch failed while resolving ${ids.length} OpenAlex DOI(s) (status=${status})`,
    );
    return [];
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch (exc) {
    deps.logger?.warn(`S2 /paper/batch JSON parse failed: ${String(exc)}`);
    completeness?.subjectFailed("s2 /paper/batch returned a malformed body");
    return [];
  }
  if (!Array.isArray(data)) {
    completeness?.subjectFailed("s2 /paper/batch returned a non-array body");
    return [];
  }
  if (data.length !== ids.length) {
    completeness?.subjectFailed(
      `s2 /paper/batch returned ${data.length} entries for ${ids.length} ids`,
    );
    return [];
  }
  const bad = firstUnusable(data, (e) => Boolean(s2PaperShape(e)), { allowNone: true });
  if (bad !== null) {
    const [index, item] = bad;
    completeness?.subjectFailed(
      `s2 /paper/batch returned a malformed entry at index ${index} (type=${typeOf(item)})`,
    );
    return [];
  }
  const resolved: ThemePaper[] = [];
  for (const entry of data) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (e.paperId && e.title) resolved.push(e as unknown as ThemePaper);
    }
  }
  return resolved;
}

function typeOf(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

// ---- _is_survey / _compute_seed_score / _rank_and_truncate (#209 Tier 1) ----

const SEED_VELOCITY_AGE_FLOOR_YEARS = 0.5;
const SURVEY_VELOCITY_PENALTY = 0.3;
/** R2-15: the shared survey test (`shared/surveyLike.ts`: publication
 * type, title incl. the #209 prefix/colon forms, abstract). */
export function isSurvey(paper: SurveyPaperLike): boolean {
  return isSurveyLike(paper);
}

export function computeSeedScore(
  paper: { title?: unknown; citationCount?: unknown; year?: unknown },
  currentYear: number,
): number {
  const cites = Number(paper.citationCount) || 0;
  const year = paper.year;
  let age: number;
  if (typeof year !== "number" || !Number.isInteger(year) || year > currentYear) {
    age = SEED_VELOCITY_AGE_FLOOR_YEARS;
  } else {
    age = Math.max(currentYear - year, SEED_VELOCITY_AGE_FLOOR_YEARS);
  }
  let score = (cites + 1) / age;
  if (isSurvey(paper)) score *= SURVEY_VELOCITY_PENALTY;
  return score;
}

/** `options.currentYear` defaults to the LOCAL wall-clock year
 * (`new Date().getFullYear()`), matching Python's `_rank_and_truncate`,
 * which reads local `datetime.now().year` — a different clock read
 * from `_run_bfs_and_descendants`'s own `datetime.now(timezone.utc).year`
 * (see `bfs.ts`'s `RunBfsOptions.currentYear`). Pass it explicitly for
 * deterministic tests/parity runs. */
export function rankAndTruncate<
  T extends { year?: unknown; title?: unknown; citationCount?: unknown },
>(
  papers: Iterable<T>,
  options: {
    topN: number;
    sinceYear: number | null;
    currentYear?: number;
    /** R2-2b: per-paper multiplier on the velocity score (topic role,
     * `TopicScope.seedWeight`). Omitted -> 1 for every paper. */
    weight?: (paper: T) => number;
  },
): T[] {
  let candidates = [...papers];
  if (options.sinceYear !== null) {
    candidates = candidates.filter(
      (p) =>
        typeof p.year === "number" &&
        Number.isInteger(p.year) &&
        (p.year as number) >= options.sinceYear!,
    );
  }
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const weight = options.weight ?? (() => 1);
  const scored = candidates.map((p, i) => ({
    p,
    i,
    score: computeSeedScore(p, currentYear) * weight(p),
  }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  return scored.slice(0, options.topN).map((s) => s.p);
}

// ---- _apply_seed_filters ----

/**
 * Denylist / topic-relevance / blacklist filters, then velocity ranking.
 * R2-2b: with a theme, each seed's velocity score is multiplied by its
 * topic-role weight (`TopicScope.seedWeight`), so a paper whose title is
 * about the theme outranks one that merely uses it as a method component
 * ("SuperGlue: ... With Graph Neural Networks") or mentions it only in
 * the abstract. `topicScope: null` disables the weighting.
 */
export function applySeedFilters<T extends ThemeSeedLike & { year?: unknown }>(
  byId: ReadonlyMap<string, T>,
  options: {
    theme: string | null;
    topN: number;
    sinceYear: number | null;
    topicScope?: TopicScope | null;
  },
): T[] {
  let candidates = [...byId.values()];
  candidates = filterDenylistedSeeds(candidates);
  let scope: TopicScope | null = null;
  if (options.theme) {
    candidates = filterTopicRelevantSeeds(candidates, options.theme);
    candidates = filterThemeBlacklist(candidates, options.theme);
    scope =
      options.topicScope === undefined ? TopicScope.forTheme(options.theme) : options.topicScope;
  }
  return rankAndTruncate(candidates, {
    topN: options.topN,
    sinceYear: options.sinceYear,
    weight: scope ? (p) => scope.seedWeight(p) : undefined,
  });
}

// ---- _openalex_search_per_keyword / _discover_seeds_openalex_primary ----

export async function openalexSearchPerKeyword(
  keywords: readonly string[],
  options: { topN: number; sinceYear: number | null },
  deps: OpenAlexDeps,
  completeness?: BuildCompletenessLike | null,
): Promise<Record<string, unknown>[]> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const kw of keywords) {
    if (!kw || !kw.trim()) continue;
    const works = await discoverSeedsViaOpenalex(
      { query: kw, topN: options.topN, sinceYear: options.sinceYear, completeness },
      deps,
    );
    for (const work of works) {
      const wid = openalexShortId(work.id);
      if (wid && !byId.has(wid)) byId.set(wid, work);
    }
  }
  return [...byId.values()];
}

export async function discoverSeedsOpenalexPrimary(
  options: {
    keywords: readonly string[];
    topN: number;
    sinceYear: number | null;
    theme: string | null;
    topicScope?: TopicScope | null;
  },
  deps: OpenAlexDeps,
  completeness?: BuildCompletenessLike | null,
): Promise<ThemePaper[]> {
  const works = await openalexSearchPerKeyword(options.keywords, options, deps, completeness);
  const byId = new Map<string, ThemePaper>();
  for (const work of works) {
    const paper = workToPaperDict(work);
    if (paper === null) continue;
    if (!byId.has(paper.paperId)) byId.set(paper.paperId, paper);
  }
  return applySeedFilters(byId, {
    theme: options.theme,
    topN: options.topN,
    sinceYear: options.sinceYear,
    topicScope: options.topicScope,
  });
}

// ---- _search_one_keyword_via_s2 ----

function seedCachePath(keyword: string, sinceYear: number | null, cacheDir: string): string {
  const digest = createHash("sha1")
    .update(keyword.toLowerCase().trim(), "utf-8")
    .digest("hex")
    .slice(0, 12);
  const suffix = sinceYear !== null ? `y${sinceYear}` : "yany";
  return `${cacheDir}/search_${digest}_${suffix}.json`;
}

export async function searchOneKeywordViaS2(
  options: { keyword: string; sinceYear: number | null },
  deps: DiscoverSeedsDeps,
  completeness?: BuildCompletenessLike | null,
): Promise<ThemePaper[]> {
  const { keyword, sinceYear } = options;
  if (!keyword || !keyword.trim()) return [];
  const cachePath = seedCachePath(keyword, sinceYear, deps.cacheDir);
  if (existsSync(cachePath)) {
    // Unversioned files predate the outage/malformed-page split and may
    // hold an outage recorded as `[]`; they are misses (readVersionedCache
    // returns null for them, same as a missing file).
    const cached = readVersionedCache(cachePath, SEARCH_CACHE_VERSION);
    if (Array.isArray(cached) && firstUnusable(cached, (p) => Boolean(s2PaperShape(p))) === null) {
      const usable = cached.filter((p) => (p as Record<string, unknown>).title);
      if (usable.length > 0 || cached.length === 0) {
        // An empty cached list is a real "no results"; only a non-empty
        // list that yields nothing is corrupt (falls through below).
        return usable as ThemePaper[];
      }
    }
    // A truncated/malformed/wrong-version cache file, or a non-empty-but-
    // all-untitled one, is not "this keyword found nothing" — fall
    // through to the live search and let the write below replace it.
    deps.logger?.warn(`s2: discarding malformed seed cache for keyword ${JSON.stringify(keyword)}`);
  }

  const resp = await s2Get(
    "GET",
    S2_SEARCH_URL,
    {
      params: {
        query: keyword,
        fields: S2_FIELDS_SEARCH,
        limit: S2_SEARCH_LIMIT,
        fieldsOfStudy: S2_FIELDS_OF_STUDY,
      },
      timeoutMs: 20_000,
    },
    deps,
  );
  if (resp === null || resp.status !== 200) {
    const status = resp ? resp.status : null;
    deps.logger?.warn(
      `s2: search failed for keyword ${JSON.stringify(keyword)} (status=${status}); not caching`,
    );
    completeness?.subjectFailed(
      `s2 seed search for ${JSON.stringify(keyword)} failed (status=${status})`,
    );
    return [];
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    deps.logger?.warn(
      `s2: search returned a malformed body for keyword ${JSON.stringify(keyword)}; not caching`,
    );
    completeness?.subjectFailed(
      `s2 seed search for ${JSON.stringify(keyword)} returned a malformed body`,
    );
    return [];
  }
  const data =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : undefined;
  if (!Array.isArray(data)) {
    completeness?.subjectFailed(
      `s2 seed search for ${JSON.stringify(keyword)} returned no data array`,
    );
    return [];
  }
  const bad = firstUnusable(data, (p) => Boolean(s2PaperShape(p)));
  if (bad !== null) {
    const [index] = bad;
    completeness?.subjectFailed(
      `s2 seed search for ${JSON.stringify(keyword)} returned a malformed entry at index ${index}`,
    );
    return [];
  }
  const items = (data as Record<string, unknown>[]).filter((p) => p.title);
  writeVersionedCache(cachePath, SEARCH_CACHE_VERSION, items);
  return items as unknown as ThemePaper[];
}

// ---- _top_up_via_openalex ----

export async function topUpViaOpenalex(
  byId: ReadonlyMap<string, ThemePaper>,
  options: { keywords: readonly string[]; topN: number; sinceYear: number | null },
  deps: DiscoverSeedsDeps,
  completeness?: {
    subjectFailures: readonly string[];
    supplementFailed(reason: string): void;
  } | null,
): Promise<Map<string, ThemePaper>> {
  if (!options.keywords.some((k) => k && k.trim())) return new Map(byId);
  deps.logger?.warn(
    `S2 yielded ${byId.size} seeds (target=${options.topN}); trying OpenAlex fallback (keywords=${JSON.stringify(options.keywords.filter((k) => k && k.trim()))})`,
  );
  const scratchFailures: string[] = [];
  const scratch: BuildCompletenessLike = { subjectFailed: (r) => scratchFailures.push(r) };
  let resolved: ThemePaper[];
  try {
    const works = await openalexSearchPerKeyword(options.keywords, options, deps, scratch);
    resolved = works.length > 0 ? await resolveOpenalexToS2(works, deps, scratch) : [];
  } finally {
    if (completeness) {
      for (const reason of scratchFailures) completeness.supplementFailed(reason);
    }
  }
  if (resolved.length === 0) return new Map(byId);
  const merged = new Map(byId);
  for (const paper of resolved) {
    if (paper.paperId && !merged.has(paper.paperId)) merged.set(paper.paperId, paper);
  }
  return merged;
}

// ---- discover_seeds (dispatcher) ----

export interface DiscoverSeedsCompleteness extends BuildCompletenessLike {
  readonly subjectFailures: readonly string[];
  supplementFailed(reason: string): void;
}

export async function discoverSeeds(
  options: {
    keywords: readonly string[];
    topN: number;
    sinceYear: number | null;
    useOpenalexFallback?: boolean;
    theme?: string | null;
    primarySource?: "s2" | "openalex";
    /** R2-2b seed weighting; default `TopicScope.forTheme(theme)`. */
    topicScope?: TopicScope | null;
  },
  deps: DiscoverSeedsDeps,
  completeness?: DiscoverSeedsCompleteness | null,
): Promise<ThemePaper[]> {
  const {
    keywords,
    topN,
    sinceYear,
    useOpenalexFallback = true,
    theme = null,
    primarySource = "s2",
    topicScope,
  } = options;

  if (primarySource === "openalex") {
    return discoverSeedsOpenalexPrimary(
      { keywords, topN, sinceYear, theme, topicScope },
      deps,
      completeness,
    );
  }

  if (theme === null) {
    deps.logger?.warn(
      "discover_seeds called without theme= ; topic-relevance filter is bypassed and off-topic seeds may slip in (caller should pass the sanitised theme string)",
    );
  }

  const byId = new Map<string, ThemePaper>();
  for (const kw of keywords) {
    const papers = await searchOneKeywordViaS2({ keyword: kw, sinceYear }, deps, completeness);
    for (const paper of papers) {
      if (paper.paperId && !byId.has(paper.paperId)) byId.set(paper.paperId, paper);
    }
  }

  const primary = applySeedFilters(byId, { theme, topN, sinceYear, topicScope });
  if (!useOpenalexFallback || primary.length >= topN) return primary;

  const augmented = await topUpViaOpenalex(byId, { keywords, topN, sinceYear }, deps, completeness);
  if (augmented.size === byId.size) return primary;
  const merged = applySeedFilters(augmented, { theme, topN, sinceYear, topicScope });
  deps.logger?.warn(
    `OpenAlex fallback added ${merged.length - primary.length} new seeds (final=${merged.length})`,
  );
  return merged;
}
