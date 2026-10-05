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
}

export interface CfDeploymentIdResult {
  deploymentId: string;
  deploymentUrl: string;
}

interface CfDeploymentListEntry {
  id?: string;
  url?: string;
  created_on?: string;
  deployment_trigger?: { metadata?: { commit_hash?: string } };
}

interface CfDeploymentListBody extends CfErrorBody {
  result?: CfDeploymentListEntry[];
}

/** `cf-deployment-id`: finds the newest production deployment for `sourceSha`. */
export async function getProductionDeploymentId(
  options: CfDeploymentIdOptions,
): Promise<CfDeploymentIdResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    options.accountId,
  )}/pages/projects/${encodeURIComponent(options.project)}/deployments?env=production`;
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
  const matches = (body.result ?? []).filter(
    (entry) => entry.deployment_trigger?.metadata?.commit_hash === options.sourceSha,
  );
  if (matches.length === 0) {
    throw new CloudflareApiError(
      `no production Cloudflare Pages deployment found for commit ${options.sourceSha}`,
    );
  }
  matches.sort((a, b) => Date.parse(b.created_on ?? "") - Date.parse(a.created_on ?? ""));
  const newest = matches[0] as CfDeploymentListEntry;
  if (typeof newest.id !== "string" || !DEPLOYMENT_ID_RE.test(newest.id)) {
    throw new CloudflareApiError("Cloudflare deployment id has an unexpected format");
  }
  if (typeof newest.url !== "string" || !PAGES_URL_RE.test(newest.url)) {
    throw new CloudflareApiError("Cloudflare deployment url has an unexpected format");
  }
  return { deploymentId: newest.id, deploymentUrl: newest.url };
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
