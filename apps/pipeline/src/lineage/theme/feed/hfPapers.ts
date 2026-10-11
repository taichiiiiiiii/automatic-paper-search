/**
 * R4-3 (design 48 P1-2, design 52 §3.3): "コード" / "HF" badges for theme
 * lineage nodes.
 *
 * For every lineage node with an arXiv id, ask the Hugging Face Papers
 * API (`GET https://huggingface.co/api/papers/{arxiv_id}`, no key, `api`
 * quota 500 requests / 5 minutes) for:
 *  - `githubRepo` / `githubStars` -> the "コード" badge (Papers with Code
 *    is retired; HF is its official successor for paper -> code links),
 *    only when a person linked it (`githubRepoAddedBy: "user"`);
 *  - `upvotes`, `numTotalModels`, `numTotalDatasets`, `numTotalSpaces` ->
 *    the "HF" badge, linked to `https://huggingface.co/papers/{id}`.
 * When HF has no repository, the curated `data/config/paper_repos.json`
 * (arXiv id -> owner/repo) supplies the code link.
 *
 * Only numbers and URLs are kept. The LLM-generated fields (`ai_summary`,
 * `ai_keywords`, `ai_summary_model`) and the HF-hosted summary are never
 * read into the cache or published (project rule: no LLM output; HF ToS:
 * HF / submitter content is not republished).
 *
 * Answers are cached in `data/state/hf-papers/papers.json` with a TTL
 * (default 7 days); a 404 ("paper not on HF") is cached as `absent`; any
 * other failure is never cached and keeps the previous entry.
 */

import type { FetchLike } from "../../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../../collect/http/requestWithRetry.js";
import { normaliseArxivId } from "../openalexWork.js";

export const HF_PAPERS_API = "https://huggingface.co/api/papers";
export const HF_PAPER_PAGE = "https://huggingface.co/papers";
export const HF_CACHE_SCHEMA_VERSION = "hf-papers-cache-v1";
export const CODE_LINKS_SCHEMA_VERSION = "theme-code-links-v1";
export const CODE_LINKS_FILENAME = "code-links.json";
export const DEFAULT_HF_TTL_DAYS = 7;
/** Requests per run; well under HF's 500 / 5 min. */
export const DEFAULT_HF_MAX_REQUESTS = 200;
/** Pause between HF requests (stays far below the quota). */
export const HF_PACE_MS = 300;

const GITHUB_REPO_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const OWNER_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const MODERN_ARXIV_RE = /^\d{4}\.\d{4,5}$/;

export interface HfPaperEntry {
  status: "ok" | "absent";
  fetched_at: string;
  github_repo: string | null;
  github_stars: number | null;
  upvotes: number;
  models: number;
  datasets: number;
  spaces: number;
}

export interface HfCache {
  schema_version: typeof HF_CACHE_SCHEMA_VERSION;
  source: "huggingface-papers";
  entries: Record<string, HfPaperEntry>;
}

export function emptyHfCache(): HfCache {
  return { schema_version: HF_CACHE_SCHEMA_VERSION, source: "huggingface-papers", entries: {} };
}

/** Parse a cache file's JSON; anything malformed yields an empty cache
 * (a cache is never trusted over a refetch). */
export function parseHfCache(raw: unknown): HfCache {
  const cache = emptyHfCache();
  if (!raw || typeof raw !== "object") return cache;
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== HF_CACHE_SCHEMA_VERSION) return cache;
  const entries = obj.entries;
  if (!entries || typeof entries !== "object") return cache;
  for (const [id, e] of Object.entries(entries as Record<string, unknown>)) {
    if (!MODERN_ARXIV_RE.test(id) || !e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    if ((x.status !== "ok" && x.status !== "absent") || typeof x.fetched_at !== "string") continue;
    cache.entries[id] = {
      status: x.status,
      fetched_at: x.fetched_at,
      github_repo: canonicalGithubRepo(x.github_repo),
      github_stars: nonNegInt(x.github_stars),
      upvotes: nonNegInt(x.upvotes) ?? 0,
      models: nonNegInt(x.models) ?? 0,
      datasets: nonNegInt(x.datasets) ?? 0,
      spaces: nonNegInt(x.spaces) ?? 0,
    };
  }
  return cache;
}

/** Stable serialisation: entries sorted by id. */
export function serializeHfCache(cache: HfCache): string {
  const entries: Record<string, HfPaperEntry> = {};
  for (const id of Object.keys(cache.entries).sort()) entries[id] = cache.entries[id]!;
  return `${JSON.stringify({ ...cache, entries }, null, 2)}\n`;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `https://github.com/<owner>/<repo>` for a GitHub repo URL (or
 * `owner/repo`), else `null`. Anything else (gists, orgs, other hosts,
 * query strings) is rejected. */
export function canonicalGithubRepo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = GITHUB_REPO_RE.exec(s) ?? OWNER_REPO_RE.exec(s);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return `https://github.com/${owner}/${repo}`;
}

/** Keep ONLY the numeric / URL fields of an HF paper payload. */
export function entryFromHfPayload(payload: unknown, fetchedAt: string): HfPaperEntry | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "string") return null;
  // Only a repository a person linked on HF (`githubRepoAddedBy: "user"`,
  // usually the authors). Automatic links point to unrelated mirrors for
  // older papers (Switch Transformer -> `pwc-1/Paper-10`, 1 star).
  const repo = p.githubRepoAddedBy === "user" ? canonicalGithubRepo(p.githubRepo) : null;
  return {
    status: "ok",
    fetched_at: fetchedAt,
    github_repo: repo,
    github_stars: repo ? nonNegInt(p.githubStars) : null,
    upvotes: nonNegInt(p.upvotes) ?? 0,
    models: nonNegInt(p.numTotalModels) ?? 0,
    datasets: nonNegInt(p.numTotalDatasets) ?? 0,
    spaces: nonNegInt(p.numTotalSpaces) ?? 0,
  };
}

export function absentEntry(fetchedAt: string): HfPaperEntry {
  return {
    status: "absent",
    fetched_at: fetchedAt,
    github_repo: null,
    github_stars: null,
    upvotes: 0,
    models: 0,
    datasets: 0,
    spaces: 0,
  };
}

export interface HfDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

/** One HF lookup: entry on 200, `absent` on 404, `null` (do not cache) otherwise. */
export async function fetchHfPaper(
  arxivId: string,
  fetchedAt: string,
  deps: HfDeps,
): Promise<HfPaperEntry | null> {
  const resp = await requestWithRetry(
    {
      method: "GET",
      url: `${HF_PAPERS_API}/${arxivId}`,
      headers: { "User-Agent": "PaperPilot/0.1 (+https://paperpilot.pages.dev)" },
      timeoutMs: 20_000,
    },
    deps,
  );
  if (resp === null) return null;
  if (resp.status === 404) return absentEntry(fetchedAt);
  if (resp.status !== 200) {
    deps.logger?.warn(`hf papers: ${arxivId} -> HTTP ${resp.status} (not cached)`);
    return null;
  }
  try {
    return entryFromHfPayload(await resp.json(), fetchedAt);
  } catch {
    return null;
  }
}

export function isFresh(entry: HfPaperEntry | undefined, nowMs: number, ttlDays: number): boolean {
  if (!entry) return false;
  const t = Date.parse(entry.fetched_at);
  return Number.isFinite(t) && nowMs - t < ttlDays * 86_400_000;
}

export interface RefreshStats {
  requested: number;
  fresh: number;
  fetched: number;
  absent: number;
  failed: number;
  skipped_budget: number;
}

/** Refresh the cache for `arxivIds` (stale or missing only, at most
 * `maxRequests` calls). Mutates and returns `cache`. */
export async function refreshHfCache(
  cache: HfCache,
  arxivIds: readonly string[],
  opts: { nowMs: number; ttlDays?: number; maxRequests?: number; paceMs?: number },
  deps: HfDeps,
): Promise<RefreshStats> {
  const ttl = opts.ttlDays ?? DEFAULT_HF_TTL_DAYS;
  const max = opts.maxRequests ?? DEFAULT_HF_MAX_REQUESTS;
  const pace = opts.paceMs ?? HF_PACE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchedAt = new Date(opts.nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const stats: RefreshStats = {
    requested: 0,
    fresh: 0,
    fetched: 0,
    absent: 0,
    failed: 0,
    skipped_budget: 0,
  };
  const ids = [...new Set(arxivIds)].sort();
  for (const id of ids) {
    if (isFresh(cache.entries[id], opts.nowMs, ttl)) {
      stats.fresh += 1;
      continue;
    }
    if (stats.requested >= max) {
      stats.skipped_budget += 1;
      continue;
    }
    if (stats.requested > 0 && pace > 0) await sleep(pace);
    stats.requested += 1;
    const entry = await fetchHfPaper(id, fetchedAt, deps);
    if (entry === null) {
      stats.failed += 1;
      continue;
    }
    cache.entries[id] = entry;
    if (entry.status === "absent") stats.absent += 1;
    else stats.fetched += 1;
  }
  return stats;
}

// ---- published per-theme document ----

export interface CodeLinksNode {
  arxiv_id: string;
  code: { url: string; stars: number | null; source: "huggingface-papers" | "paper_repos" } | null;
  hf: { url: string; upvotes: number; models: number; datasets: number; spaces: number } | null;
}

export interface CodeLinksDoc {
  schema_version: typeof CODE_LINKS_SCHEMA_VERSION;
  kind: "theme-code-links";
  slug: string;
  generated_at: string;
  sources: Array<"huggingface-papers" | "paper_repos">;
  nodes: Record<string, CodeLinksNode>;
}

export interface CodeLinksNodeInput {
  id: string;
  arxiv_id?: unknown;
  github_stars?: unknown;
}

/** Modern arXiv id of a node (old-style ids are not on HF Papers). */
export function nodeArxivId(node: CodeLinksNodeInput): string | null {
  const id = normaliseArxivId(node.arxiv_id);
  return id && MODERN_ARXIV_RE.test(id) ? id : null;
}

/**
 * Per-node badges from the cache (+ `paper_repos.json` for code). A node
 * gets an entry only when it has something to show: a repository, or an
 * HF page with at least one upvote or linked model / dataset / Space.
 */
export function buildCodeLinks(
  slug: string,
  nodes: readonly CodeLinksNodeInput[],
  cache: HfCache,
  paperRepos: Readonly<Record<string, unknown>>,
  nowMs: number,
): CodeLinksDoc {
  const out: Record<string, CodeLinksNode> = {};
  const sources = new Set<"huggingface-papers" | "paper_repos">();
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const arxiv = nodeArxivId(node);
    if (!arxiv) continue;
    const hfEntry = cache.entries[arxiv];
    // An HF page with no upvote and no linked model/dataset/Space says
    // nothing a reader can use: no badge.
    const hfUseful =
      hfEntry?.status === "ok" &&
      hfEntry.upvotes + hfEntry.models + hfEntry.datasets + hfEntry.spaces > 0;
    const hf =
      hfEntry && hfUseful
        ? {
            url: `${HF_PAPER_PAGE}/${arxiv}`,
            upvotes: hfEntry.upvotes,
            models: hfEntry.models,
            datasets: hfEntry.datasets,
            spaces: hfEntry.spaces,
          }
        : null;
    let code: CodeLinksNode["code"] = null;
    if (hfEntry?.status === "ok" && hfEntry.github_repo) {
      code = {
        url: hfEntry.github_repo,
        stars: hfEntry.github_stars,
        source: "huggingface-papers",
      };
    } else {
      const curated = canonicalGithubRepo(paperRepos[arxiv]);
      if (curated) {
        const stars = nonNegInt(node.github_stars);
        code = { url: curated, stars: stars && stars > 0 ? stars : null, source: "paper_repos" };
      }
    }
    if (!hf && !code) continue;
    if (hf || code?.source === "huggingface-papers") sources.add("huggingface-papers");
    if (code?.source === "paper_repos") sources.add("paper_repos");
    out[node.id] = { arxiv_id: arxiv, code, hf };
  }
  return {
    schema_version: CODE_LINKS_SCHEMA_VERSION,
    kind: "theme-code-links",
    slug,
    generated_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    sources: [...sources].sort(),
    nodes: out,
  };
}
