/**
 * GitHub stars enrichment for theme nodes — TS port of the GitHub-stars
 * section of `paperpilot/scripts/build_theme_lineage.py`
 * (`_github_cache_entry_ok`, `_load_github_stars_cache`,
 * `_save_github_stars_cache`, `_enrich_github_stars`).
 *
 * Reuses the already-ported `apps/pipeline/src/collect/signals/github*`
 * (curated map, GitHub Search, GitHub stars fetch, URL parsing) and this
 * module's own `versionedCache.ts` (`read_versioned_cache`/
 * `write_versioned_cache`, from `paperpilot/utils/versioned_cache.py`,
 * shared with the S2 seed-search cache in `discoverSeeds.ts`) — only the
 * per-node resolution loop is local to this module.
 */

import {
  fetchRepoStars,
  type GitHubApiDeps,
  GitHubUnavailableError,
  parseGithubRepoUrl,
  searchRepoByTitle,
} from "../../collect/signals/githubApi.js";
import { loadCuratedMap } from "../../collect/signals/githubMap.js";
import type { ThemeGraphNode } from "../shared/node.js";
import { readVersionedCache, writeVersionedCache } from "./versionedCache.js";

const GITHUB_CACHE_VERSION = "github-stars-cache-v1";
const GITHUB_CACHE_TTL_DAYS = 7;
const GITHUB_DEFAULT_BUDGET = 80;

interface GithubCacheEntry {
  stars: number;
  url: string | null;
  fetched_at: string;
}

function githubCacheEntryOk(entry: unknown): entry is GithubCacheEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const stars = e.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 0) return false;
  const fetchedAt = e.fetched_at;
  if (typeof fetchedAt !== "string") return false;
  const parsed = new Date(fetchedAt);
  if (Number.isNaN(parsed.getTime())) return false;
  // JS `Date` has no concept of a Python-naive datetime (always UTC
  // internally); the ISO strings this module itself writes are always
  // `Z`-suffixed, so requiring a timezone designator is the closest
  // equivalent check available without a dedicated ISO-8601 parser.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(fetchedAt)) return false;
  const url = e.url;
  return url === null || url === undefined || typeof url === "string";
}

/** Load the GitHub-stars cache; `{}` on missing/malformed/legacy file,
 * dropping any entry that fails the shape check. */
export function loadGithubStarsCache(cachePath: string): Record<string, GithubCacheEntry> {
  const data = readVersionedCache(cachePath, GITHUB_CACHE_VERSION);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, GithubCacheEntry> = {};
  for (const [key, entry] of Object.entries(data as Record<string, unknown>)) {
    if (githubCacheEntryOk(entry)) out[key] = entry;
  }
  return out;
}

/** Persist the GitHub-stars cache; logs (via `deps.logger`) but does not
 * throw on a write failure — the in-memory cache stays consistent for
 * the rest of the run. */
export function saveGithubStarsCache(
  cache: Record<string, GithubCacheEntry>,
  cachePath: string,
  logger?: { warn: (msg: string) => void },
): void {
  try {
    writeVersionedCache(cachePath, GITHUB_CACHE_VERSION, cache);
  } catch (exc) {
    logger?.warn(`failed to persist github_stars cache: ${String(exc)}`);
  }
}

export interface EnrichGithubStarsDeps {
  cachePath: string;
  githubToken?: string | null;
  curated?: Record<string, string>;
  /** Required by `searchRepoByTitle`/`fetchRepoStars`'s real
   * implementations (injected fetch — "no network ever" in tests).
   * Only optional when both `fetchStars` and `searchRepo` overrides are
   * supplied (tests that stub out both real network-touching calls). */
  apiDeps?: GitHubApiDeps;
  fetchStars?: (
    repoFull: string,
    options: { githubToken?: string | null },
  ) => Promise<number | null>;
  searchRepo?: (title: string, options: { githubToken?: string | null }) => Promise<string | null>;
  maxLookups?: number;
  now?: () => Date;
  logger?: {
    warn: (msg: string) => void;
    info: (msg: string) => void;
    debug: (msg: string) => void;
  };
}

/** Resolve GitHub stars for theme nodes that have an `arxiv_id`.
 *
 * Mutates `nodes` in place, setting `github_stars`/`github_url` on
 * resolved entries. Persists a TTL-cached (7-day) lookup store so
 * subsequent runs reuse fresh lookups. Returns the count of nodes whose
 * final `github_stars > 0`. */
export async function enrichGithubStars(
  nodes: ReadonlyMap<string, ThemeGraphNode> | Iterable<ThemeGraphNode>,
  deps: EnrichGithubStarsDeps,
): Promise<number> {
  const {
    cachePath,
    githubToken = null,
    maxLookups = GITHUB_DEFAULT_BUDGET,
    now = () => new Date(),
    logger,
  } = deps;
  const curated = deps.curated ?? loadCuratedMap();
  const fetch =
    deps.fetchStars ??
    ((repo: string, opts: { githubToken?: string | null }) => {
      if (!deps.apiDeps)
        throw new Error(
          "enrichGithubStars: apiDeps.fetchImpl is required unless fetchStars is stubbed",
        );
      return fetchRepoStars(repo, opts, deps.apiDeps);
    });
  const search =
    deps.searchRepo ??
    ((title: string, opts: { githubToken?: string | null }) => {
      if (!deps.apiDeps)
        throw new Error(
          "enrichGithubStars: apiDeps.fetchImpl is required unless searchRepo is stubbed",
        );
      return searchRepoByTitle(title, opts, deps.apiDeps);
    });

  const cache = loadGithubStarsCache(cachePath);
  const freshCutoff = now().getTime() - GITHUB_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

  const nodeList: ThemeGraphNode[] = nodes instanceof Map ? [...nodes.values()] : [...nodes];

  let enriched = 0;
  const targets: [ThemeGraphNode, string][] = [];
  for (const node of nodeList) {
    const ax = node.arxiv_id;
    if (!ax) continue;
    const cached = cache[ax];
    if (cached && new Date(cached.fetched_at).getTime() >= freshCutoff) {
      if (cached.stars > 0) {
        node.github_stars = cached.stars;
        if (cached.url && parseGithubRepoUrl(cached.url)) {
          node.github_url = cached.url;
        }
        enriched += 1;
      }
      continue;
    }
    targets.push([node, ax]);
  }

  if (targets.length === 0) return enriched;

  // Slice to the lookup budget BEFORE issuing any API call. Papers past
  // the budget are NOT cached as 0 — they re-enter the queue next run.
  const lookedUp = targets.slice(0, maxLookups);
  const fetchedTs = now().toISOString();

  let curatedHits = 0;
  let searchHits = 0;
  let starsPositive = 0;
  for (const [node, ax] of lookedUp) {
    let repoFull: string | null = curated[ax] ?? null;
    let unavailable = false;
    if (repoFull) {
      curatedHits += 1;
    } else {
      try {
        repoFull = await search(node.title || "", { githubToken });
      } catch (exc) {
        if (exc instanceof GitHubUnavailableError) {
          logger?.warn(`github search unavailable for ${ax}: ${String(exc)}`);
        } else {
          logger?.debug(`search_repo failed for ${ax}: ${String(exc)}`);
        }
        repoFull = null;
        unavailable = true;
      }
      if (repoFull) searchHits += 1;
    }

    let stars = 0;
    let url: string | null = null;
    if (repoFull) {
      try {
        const fetched = await fetch(repoFull, { githubToken });
        if (fetched !== null && fetched > 0) {
          stars = Math.trunc(fetched);
          url = `https://github.com/${repoFull}`;
          starsPositive += 1;
        }
      } catch (exc) {
        if (exc instanceof GitHubUnavailableError) {
          logger?.warn(`github stars unavailable for ${repoFull}: ${String(exc)}`);
        } else {
          logger?.debug(`fetch_stars failed for ${repoFull}: ${String(exc)}`);
        }
        unavailable = true;
      }
    }

    if (unavailable) {
      // Leave this paper out of the cache entirely so the next run asks
      // again. A stars=0 entry with a fresh timestamp would be
      // indistinguishable from a successful "no public repo".
      continue;
    }

    // Cache the result regardless of stars value — caching 0 prevents
    // weekly re-querying for papers without a public GitHub repo.
    cache[ax] = { stars, url, fetched_at: fetchedTs };
    if (stars > 0) {
      node.github_stars = stars;
      if (url) node.github_url = url;
      enriched += 1;
    }
  }

  if (curatedHits || searchHits) {
    logger?.info(
      `github stars resolution: curated=${curatedHits}, search=${searchHits}, stars>0=${starsPositive} (of ${lookedUp.length} looked up)`,
    );
  }

  saveGithubStarsCache(cache, cachePath, logger);
  return enriched;
}
