/**
 * Shared GitHub stars resolvers — TS port of `paperpilot/utils/github.py`
 * (OUT-26..30 of docs/migration/safety-contracts.md).
 *
 * `search_repo_by_title`, `fetch_repo_stars` and `parse_github_repo_url`
 * are used by `GitHubSignal` (Stage 2). The theme/lineage builder
 * (`build_theme_lineage.py`) that shares this module in Python is P4d, out
 * of this task's scope.
 */

import type { FetchLike } from "../http/requestWithRetry.js";
import { requestWithRetry } from "../http/requestWithRetry.js";
import { firstUnusable, ghRepoSlug, ghSearchItemOk } from "./payload.js";

/**
 * The GitHub API could not answer — throttled, erroring, or down. Distinct
 * from a successful "no such repository" / "zero stars" answer, which is a
 * fact about the paper and is safe to cache.
 */
export class GitHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

const GH_UNAVAILABLE_STATUSES = new Set([403, 429]);
const TITLE_SIM_THRESHOLD = 0.55;
const TOKEN_RE = /[a-z0-9]{3,}/g;

export interface GitHubApiDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

function githubUnavailable(resp: HttpResponseLike | null): boolean {
  if (resp === null) return true;
  if (GH_UNAVAILABLE_STATUSES.has(resp.status)) return true;
  return resp.status >= 500;
}

/**
 * Token-overlap similarity in [0, 1] for filtering GitHub search hits.
 * Tokens are ASCII alnum runs of length >= 3, lowercased. A substring
 * shortcut (both sides >= 6 normalised chars) returns 1.0.
 */
export function titleSimilarity(paperTitle: string, candidate: string): number {
  const pt = (paperTitle || "").toLowerCase();
  const ct = (candidate || "").toLowerCase();
  if (!pt || !ct) return 0.0;
  const pn = pt.replace(/[^a-z0-9]/g, "");
  const cn = ct.replace(/[^a-z0-9]/g, "");
  if (pn.length >= 6 && cn.length >= 6 && (cn.includes(pn) || pn.includes(cn))) return 1.0;
  const pa = new Set(pt.match(TOKEN_RE) ?? []);
  const pb = new Set(ct.match(TOKEN_RE) ?? []);
  if (pa.size === 0 || pb.size === 0) return 0.0;
  let intersection = 0;
  for (const t of pa) if (pb.has(t)) intersection += 1;
  const union = pa.size + pb.size - intersection;
  return intersection / union;
}

interface GhSearchItem {
  full_name: string;
  name?: unknown;
  description?: unknown;
}

/**
 * Best-effort `owner/repo` resolution via `GET /search/repositories`.
 * Returns `null` only for a genuine "nothing matched" (200, empty/no-
 * similar-enough `items`) or a too-short title; throws
 * {@link GitHubUnavailableError} for anything that says nothing about
 * whether a repository exists.
 */
export async function searchRepoByTitle(
  title: string,
  options: { githubToken?: string | null } = {},
  deps: GitHubApiDeps,
): Promise<string | null> {
  const cleaned = (title || "").trim();
  if (cleaned.length < 8) return null;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
  const resp = await requestWithRetry(
    {
      method: "GET",
      url: "https://api.github.com/search/repositories",
      params: { q: cleaned.slice(0, 80), sort: "stars", order: "desc", per_page: 5 },
      headers,
      timeoutMs: 10000,
    },
    deps,
  );
  if (githubUnavailable(resp)) {
    throw new GitHubUnavailableError(
      `github repo search failed (status=${resp ? resp.status : null})`,
    );
  }
  const r = resp as HttpResponseLike;
  if (r.status !== 200) {
    throw new GitHubUnavailableError(
      `github repo search answered ${r.status}, which says nothing about whether a repository exists`,
    );
  }
  let payload: unknown;
  try {
    payload = await r.json();
  } catch {
    throw new GitHubUnavailableError("github repo search returned a malformed body");
  }
  const items =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(items)) {
    const keys =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Object.keys(payload as object)
            .sort()
            .slice(0, 5)
        : typeof payload;
    throw new GitHubUnavailableError(`github repo search returned no items array (keys=${keys})`);
  }
  const bad = firstUnusable(items, ghSearchItemOk);
  if (bad !== null) {
    const [index, item] = bad;
    const typeName = item === null ? "NoneType" : Array.isArray(item) ? "list" : typeof item;
    throw new GitHubUnavailableError(
      `github repo search returned a malformed item at index ${index} (type=${typeName})`,
    );
  }
  for (const item of items as GhSearchItem[]) {
    const fullName = item.full_name;
    const sim = Math.max(
      titleSimilarity(cleaned, typeof item.name === "string" ? item.name : ""),
      titleSimilarity(cleaned, typeof item.description === "string" ? item.description : ""),
    );
    if (sim >= TITLE_SIM_THRESHOLD) return fullName;
  }
  return null;
}

/**
 * `GET /repos/{owner}/{repo}` -> stargazer count. Returns `null` only for a
 * genuinely negative answer (unusable slug, or 404 — no public repository).
 */
export async function fetchRepoStars(
  repoFull: string,
  options: { githubToken?: string | null } = {},
  deps: GitHubApiDeps,
): Promise<number | null> {
  const slug = ghRepoSlug(repoFull);
  if (slug === null) return null;
  const [owner, name] = slug;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
  const resp = await requestWithRetry(
    {
      method: "GET",
      url: `https://api.github.com/repos/${owner}/${name}`,
      headers,
      timeoutMs: 10000,
    },
    deps,
  );
  if (githubUnavailable(resp)) {
    throw new GitHubUnavailableError(
      `github repo lookup failed for ${repoFull} (status=${resp ? resp.status : null})`,
    );
  }
  const r = resp as HttpResponseLike;
  if (r.status === 404) return null;
  if (r.status !== 200) {
    throw new GitHubUnavailableError(
      `github repo lookup for ${repoFull} answered ${r.status}, which says nothing about whether the repository exists`,
    );
  }
  let payload: unknown;
  try {
    payload = await r.json();
  } catch {
    throw new GitHubUnavailableError(
      `github repo lookup for ${repoFull} returned a malformed body`,
    );
  }
  const stars =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).stargazers_count
      : undefined;
  if (typeof stars !== "number" || !Number.isInteger(stars)) {
    const keys =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Object.keys(payload as object)
            .sort()
            .slice(0, 5)
        : typeof payload;
    throw new GitHubUnavailableError(
      `github repo lookup for ${repoFull} returned no stargazers_count (keys=${keys})`,
    );
  }
  return stars;
}

const GH_NETLOC = new Set(["github.com", "www.github.com"]);

/**
 * Strict parse of a GitHub URL -> `[owner, repo]`. `null` on any deviation:
 * missing URL, non-http(s) scheme, non-github host, fewer than two path
 * segments, or any segment failing the slug regex.
 */
export function parseGithubRepoUrl(url: string | null | undefined): [string, string] | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!GH_NETLOC.has(parsed.hostname.toLowerCase())) return null;
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0] as string;
  const repo = (segments[1] as string).replace(/\.git$/, "");
  return ghRepoSlug(`${owner}/${repo}`);
}
