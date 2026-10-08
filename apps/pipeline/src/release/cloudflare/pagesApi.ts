/**
 * Cloudflare Pages REST API calls backing `cf-deployment-id` / `cf-rollback`
 * (p5-plan.md §2 A4, §4.3 "deploy" stage, §4.4 "rollback" stage).
 *
 * **(verify) — every shape below is coded against the documented API,
 * not confirmed live (offline hard limit); listed again in this
 * changeset's handback per the brief, to be exercised once in the P2
 * rehearsal (p5-plan.md §7 R21) before any production use:**
 *   - `GET /accounts/{account}/pages/projects/{project}/deployments?env=production`
 *     returns `{ success, result: [{ id, url, created_on,
 *     deployment_trigger: { metadata: { commit_hash } } }] }`. This
 *     module does NOT trust the list's own order — it filters by
 *     `commit_hash === sourceSha` and re-sorts the matches by
 *     `created_on` itself, picking the newest.
 *   - `POST .../deployments/{id}/rollback` returns `{ success, result:
 *     { id, url } }` for the NEW rollback deployment.
 *   - `id` format: regex-checked as `^[A-Za-z0-9-]{1,64}$` here (a UUID
 *     is the documented shape, which this is a superset of; tightening
 *     to a strict UUID regex is a follow-up once the rehearsal confirms
 *     it).
 *   - `url` format: `https://<something>.pages.dev` (a bare per-deployment
 *     preview URL — the plan's "the per-deployment URL").
 *
 * Both `id` and `url` are regex-checked BEFORE this module returns them
 * to a caller that will put them in `GITHUB_OUTPUT` — an unchecked
 * string from a JSON response reaching `GITHUB_OUTPUT` unescaped is a
 * newline-injection path (a value containing `\n` could forge an
 * additional `key=value` line). `fetchImpl` is always caller-injected;
 * no test here ever touches the real network. The bearer token is read
 * from `apiToken` (the CLI layer gets it from an env var) and is never
 * interpolated into any thrown error message or log line in this module
 * — only the Cloudflare API's own `errors[].message` (never the request,
 * never the token) reaches an error's `.message`.
 */

export class CloudflareApiError extends Error {}

export interface CfApiResponse {
  status: number;
  json(): Promise<unknown>;
}

/** `fetchImpl(url, {method, headers})` — deliberately narrower than the DOM `fetch` type so a test fake doesn't have to implement the rest of `Response`. */
export type CfFetchFn = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string> },
) => Promise<CfApiResponse>;

const DEPLOYMENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const PAGES_URL_RE = /^https:\/\/[a-z0-9.-]+\.pages\.dev\/?$/;

interface CfErrorBody {
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

function describeCfError(status: number, body: CfErrorBody): string {
  const messages = (body.errors ?? []).map((e) => e.message).filter((m): m is string => Boolean(m));
  return messages.length > 0 ? messages.join("; ") : `HTTP ${status}`;
}

export interface CfDeploymentIdOptions {
  fetchImpl: CfFetchFn;
  accountId: string;
  project: string;
  apiToken: string;
  /** 40-hex commit SHA to match against `deployment_trigger.metadata.commit_hash`. */
  sourceSha: string;
  /** Polling budget for an in-progress newest deployment (default `DEPLOYMENT_POLL_MAX_ATTEMPTS`). */
  maxAttempts?: number;
  /** Delay between polls in ms (default `DEPLOYMENT_POLL_INTERVAL_MS`). */
  pollIntervalMs?: number;
  /** Injected sleep so tests run instantly (default: real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Max list pages walked per poll (default `DEPLOYMENT_LIST_MAX_PAGES`). */
  maxPages?: number;
}

export interface CfDeploymentIdResult {
  deploymentId: string;
  deploymentUrl: string;
}

interface CfDeploymentListEntry {
  id?: string;
  url?: string;
  created_on?: string;
  environment?: string;
  is_skipped?: boolean;
  latest_stage?: { status?: string };
  deployment_trigger?: { metadata?: { commit_hash?: string } };
}

/**
 * The list API does not document its sort order or default page size, so
 * ask for an explicit page size and never trust list order (we sort by
 * `created_on` below). A field the API documents but a response omits is
 * not held against the entry; a present field that says "not a
 * production deploy" is.
 */
const DEPLOYMENT_LIST_PER_PAGE = 25;
/** Hard cap on list pages walked per poll (25 × 10 = the newest 250 production deploys). */
export const DEPLOYMENT_LIST_MAX_PAGES = 10;
/** Default polling budget: 10 attempts, 6 s apart (≈ 54 s of waiting in the worst case). */
export const DEPLOYMENT_POLL_MAX_ATTEMPTS = 10;
export const DEPLOYMENT_POLL_INTERVAL_MS = 6_000;

/**
 * `latest_stage.status` values Cloudflare documents: `idle`, `active`,
 * `canceled`, `success`, `failure`, `skipped`. `success` is the only one
 * we return; `failure`/`canceled` are terminal failures; `skipped` is
 * dropped like `is_skipped`. Anything else (`idle`, `active`, or an
 * undocumented value such as `queued`) is treated as still in progress.
 * An ABSENT status is treated as success (unchanged from before: a field
 * a response omits is not held against the entry).
 */
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set(["failure", "canceled"]);

function isProductionCandidate(entry: CfDeploymentListEntry, sourceSha: string): boolean {
  if (entry.deployment_trigger?.metadata?.commit_hash !== sourceSha) return false;
  if (entry.environment !== undefined && entry.environment !== "production") return false;
  if (entry.is_skipped === true) return false;
  if (entry.latest_stage?.status === "skipped") return false;
  return true;
}

interface CfDeploymentListBody extends CfErrorBody {
  result?: CfDeploymentListEntry[];
  result_info?: { total_pages?: number };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walks the production deployment list (page 1, 2, … up to
 * `result_info.total_pages`, never more than `DEPLOYMENT_LIST_MAX_PAGES`)
 * and stops at the first page that contains any candidate for
 * `sourceSha`. Returns every candidate seen.
 */
async function fetchCandidates(options: CfDeploymentIdOptions): Promise<CfDeploymentListEntry[]> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    options.accountId,
  )}/pages/projects/${encodeURIComponent(options.project)}/deployments?env=production&per_page=${DEPLOYMENT_LIST_PER_PAGE}`;
  const maxPages = options.maxPages ?? DEPLOYMENT_LIST_MAX_PAGES;
  const candidates: CfDeploymentListEntry[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? base : `${base}&page=${page}`;
    const response = await options.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiToken}` },
    });
    const body = (await response.json()) as CfDeploymentListBody;
    if (response.status < 200 || response.status >= 300 || body.success !== true) {
      throw new CloudflareApiError(
        `Cloudflare Pages deployment list failed: ${describeCfError(response.status, body)}`,
      );
    }
    for (const entry of body.result ?? []) {
      if (isProductionCandidate(entry, options.sourceSha)) candidates.push(entry);
    }
    if (candidates.length > 0) break;
    const totalPages = body.result_info?.total_pages;
    if (typeof totalPages !== "number" || !Number.isFinite(totalPages) || page >= totalPages) break;
  }
  return candidates;
}

/**
 * `cf-deployment-id`: finds the newest production deployment for
 * `sourceSha` and waits (bounded) for it to finish.
 *
 * `wrangler pages deploy` can return before the deploy stage finishes,
 * so the newest entry for the SHA may still be `idle`/`active`. The
 * decision is always made on the NEWEST entry for the SHA (by
 * `created_on`) — never "any successful entry" — so an older successful
 * deploy of the same SHA is not returned while a newer one is in
 * progress or has failed. Not finding the SHA at all fails immediately.
 */
export async function getProductionDeploymentId(
  options: CfDeploymentIdOptions,
): Promise<CfDeploymentIdResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEPLOYMENT_POLL_MAX_ATTEMPTS);
  const intervalMs = options.pollIntervalMs ?? DEPLOYMENT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;
  let lastStatus = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidates = await fetchCandidates(options);
    if (candidates.length === 0) {
      throw new CloudflareApiError(
        `no production Cloudflare Pages deployment found for commit ${options.sourceSha}`,
      );
    }
    candidates.sort((a, b) => Date.parse(b.created_on ?? "") - Date.parse(a.created_on ?? ""));
    const newest = candidates[0] as CfDeploymentListEntry;
    const status = newest.latest_stage?.status;
    if (status !== undefined && TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new CloudflareApiError(
        `newest production Cloudflare Pages deployment for commit ${options.sourceSha} ended with status ${JSON.stringify(status)}`,
      );
    }
    if (status === undefined || status === "success") {
      if (typeof newest.id !== "string" || !DEPLOYMENT_ID_RE.test(newest.id)) {
        throw new CloudflareApiError("Cloudflare deployment id has an unexpected format");
      }
      if (typeof newest.url !== "string" || !PAGES_URL_RE.test(newest.url)) {
        throw new CloudflareApiError("Cloudflare deployment url has an unexpected format");
      }
      return { deploymentId: newest.id, deploymentUrl: newest.url };
    }
    lastStatus = status;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new CloudflareApiError(
    `newest production Cloudflare Pages deployment for commit ${options.sourceSha} still has status ${JSON.stringify(lastStatus)} after ${maxAttempts} attempts`,
  );
}

const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;

export interface CfVerifyDeploymentOptions {
  fetchImpl: CfFetchFn;
  accountId: string;
  project: string;
  apiToken: string;
  /** The deployment id a rollback is about to target. */
  deploymentId: string;
}

interface CfDeploymentGetBody extends CfErrorBody {
  result?: { deployment_trigger?: { metadata?: { commit_hash?: string } } };
}

/**
 * `GET /accounts/{account}/pages/projects/{project}/deployments/{id}` —
 * returns that single deployment's `commit_hash` (40-hex, regex-checked
 * before it is returned, same discipline as every other value in this
 * module that can reach `GITHUB_OUTPUT`/a POST body downstream).
 *
 * M2 of the P5 tier-A review: a rollback must never POST
 * `.../rollback` against a deployment id before confirming that id's
 * own recorded `commit_hash` really is the SHA the operator asked to
 * roll back to — otherwise a forged or stale `cf_deployment_id` (e.g.
 * from an unvalidated GitHub Deployment payload) switches production
 * to the wrong build before smoke ever has a chance to catch it.
 */
export async function getDeploymentCommitHash(options: CfVerifyDeploymentOptions): Promise<string> {
  if (!DEPLOYMENT_ID_RE.test(options.deploymentId)) {
    throw new CloudflareApiError("deployment id has an unexpected format");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    options.accountId,
  )}/pages/projects/${encodeURIComponent(options.project)}/deployments/${encodeURIComponent(
    options.deploymentId,
  )}`;
  const response = await options.fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${options.apiToken}` },
  });
  const body = (await response.json()) as CfDeploymentGetBody;
  if (response.status < 200 || response.status >= 300 || body.success !== true) {
    throw new CloudflareApiError(
      `Cloudflare Pages deployment lookup failed: ${describeCfError(response.status, body)}`,
    );
  }
  const commitHash = body.result?.deployment_trigger?.metadata?.commit_hash;
  if (typeof commitHash !== "string" || !COMMIT_HASH_RE.test(commitHash)) {
    throw new CloudflareApiError("Cloudflare deployment commit_hash has an unexpected format");
  }
  return commitHash;
}

/**
 * P5 tier-A review round 2 (survivor fix): `cli.ts`'s
 * `runCfVerifyDeployment` used to inline this `commitHash !==
 * expectedSha` compare directly after its `await
 * getDeploymentCommitHash(...)` call -- which only a LIVE Cloudflare
 * fetch could ever drive far enough to exercise, so no test could kill
 * a mutant that flipped `!==` to `===` (or dropped the check entirely)
 * without violating the "never hit the network" hard limit. Extracted
 * here as a pure, network-free compare so it is unit-testable on its
 * own, the same way `getDeploymentCommitHash`'s own format checks
 * already are.
 */
export function assertCommitHashMatches(
  deploymentId: string,
  commitHash: string,
  expectedSha: string,
): void {
  if (commitHash !== expectedSha) {
    throw new CloudflareApiError(
      `Cloudflare deployment ${deploymentId} commit_hash ${commitHash} does not match expected ${expectedSha}`,
    );
  }
}

export interface CfRollbackOptions {
  fetchImpl: CfFetchFn;
  accountId: string;
  project: string;
  apiToken: string;
  /** The deployment to roll back TO. */
  deploymentId: string;
}

export interface CfRollbackResult {
  /** The id of the NEW deployment the rollback created. */
  deploymentId: string;
}

interface CfRollbackBody extends CfErrorBody {
  result?: { id?: string };
}

/** `cf-rollback`: rolls the production branch back to `options.deploymentId`. */
export async function rollbackDeployment(options: CfRollbackOptions): Promise<CfRollbackResult> {
  if (!DEPLOYMENT_ID_RE.test(options.deploymentId)) {
    throw new CloudflareApiError("deployment id has an unexpected format");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    options.accountId,
  )}/pages/projects/${encodeURIComponent(options.project)}/deployments/${encodeURIComponent(
    options.deploymentId,
  )}/rollback`;
  const response = await options.fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiToken}` },
  });
  const body = (await response.json()) as CfRollbackBody;
  if (response.status < 200 || response.status >= 300 || body.success !== true) {
    throw new CloudflareApiError(
      `Cloudflare Pages rollback failed: ${describeCfError(response.status, body)}`,
    );
  }
  const id = body.result?.id;
  if (typeof id !== "string" || !DEPLOYMENT_ID_RE.test(id)) {
    throw new CloudflareApiError("Cloudflare rollback response id has an unexpected format");
  }
  return { deploymentId: id };
}
