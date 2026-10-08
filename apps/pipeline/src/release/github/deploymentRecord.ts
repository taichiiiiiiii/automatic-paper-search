/**
 * `gh-record` — p5-plan.md §2 A4, §4.3 "record" stage. Creates a GitHub
 * Deployment in the `cloudflare-pages-production` environment AFTER
 * `deploy` and `smoke` have both already succeeded (§4.3's whole point:
 * "a job with `environment:` auto-creates a GitHub Deployment and marks
 * it success when the job ends, which is before smoke" — this module is
 * called explicitly, by its own job, only once smoke has passed, so the
 * record always reflects a smoke-tested deployment).
 *
 * Talks to the REST API directly (`fetchImpl`, always injected, never
 * the real network in a test) rather than shelling out to the `gh` CLI —
 * "through `gh api` with env only" in the plan describes the SHAPE of
 * the two calls (`POST .../deployments` then `POST
 * .../deployments/{id}/statuses`), not a literal subprocess dependency.
 * The token reaches this module only via `token` (the CLI layer reads it
 * from an env var) and is never interpolated into any thrown error
 * message — only the GitHub API's own `message` field (never the
 * request, never the token) ever reaches `.message`.
 */

export class GithubApiError extends Error {}

export interface GhApiResponse {
  status: number;
  text(): Promise<string>;
}

export type GhFetchFn = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<GhApiResponse>;

// GitHub 403s a request with no User-Agent at all; this is a deliberate,
// stable value (not e.g. undici's default, which isn't guaranteed).
const USER_AGENT = "paperpilot-release-cli";

function tryParseJson(text: string): Record<string, unknown> {
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function ghPost(
  fetchImpl: GhFetchFn,
  token: string,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = tryParseJson(text);
  if (response.status < 200 || response.status >= 300) {
    const message = typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
    throw new GithubApiError(`GitHub API request failed: ${message}`);
  }
  return parsed;
}

export interface RecordDeploymentOptions {
  fetchImpl: GhFetchFn;
  token: string;
  /** `owner/repo`. */
  repo: string;
  sourceSha: string;
  cfDeploymentId: string;
  releaseKind: string;
  requestId: string | null;
  /**
   * `null` only for a rollback record (P5 tier-A review round 2, N3):
   * `pages-rollback.yml`'s "record" step never builds an artifact (no
   * rebuild happens anywhere in a rollback, per p5-plan.md §4.3), so it
   * has no `ARTIFACT_NAME` to pass. A normal release always builds one
   * and must keep passing it -- `cli.ts`'s `runGhRecord` still requires
   * it when `releaseKind === "normal"`; only this module's own
   * validation, and the JSON payload, accept `null` as well as a
   * regex-checked string.
   */
  artifactName: string | null;
  /** `PUBLIC_ORIGIN` (@paperpilot/core/site) — the deployment's `environment_url`. */
  environmentUrl: string;
}

export interface RecordDeploymentResult {
  deploymentId: number;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// Same shape as cloudflare/pagesApi.ts's own `DEPLOYMENT_ID_RE` (the
// Cloudflare deployment id this value actually came from, earlier in
// the same release pipeline) -- duplicated rather than imported so this
// module has no dependency on the cloudflare/ subtree.
const CF_DEPLOYMENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// Same shape as marker.ts's own `REQUEST_ID_RE` -- the value comes from
// the same `REQUEST_ID` env var pages-release.yml / theme-on-demand.yml
// already regex-check at dispatch time; duplicated for the same
// no-cross-module-dependency reason as above.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// `ARTIFACT_NAME` is built by the job itself (pages-release.yml:
// `cf-pages-$SOURCE_SHA`) and never comes from an untrusted actor
// input, but it still reaches a GitHub API payload unescaped (L1 of the
// P5 tier-A review) -- the same conservative "ASCII identifier" charset
// as the other two regexes above, wide enough for the real
// `cf-pages-<40-hex>` shape plus any future artifact-name scheme built
// from the same characters.
const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * `gh-record`: `POST /repos/{repo}/deployments`, then `POST
 * .../deployments/{id}/statuses` with `state: "success"`.
 *
 * L1 of the P5 tier-A review: `cfDeploymentId`, `requestId`, and
 * `artifactName` used to reach the GitHub API payload with no format
 * check at all (unlike `sourceSha`, already regex-checked by the CLI's
 * `requiredShaEnv`, and `repo`, checked just below) -- an unchecked
 * string embedded in a JSON request body is not a `GITHUB_OUTPUT`
 * newline-injection vector the way an UNQUOTED shell value would be,
 * but it is still the known-good ledger's own input validation gap: a
 * malformed/oversized value from a compromised upstream step would be
 * recorded verbatim into the GitHub Deployment this module creates.
 * All three are validated here, BEFORE the first `ghPost` call, exactly
 * like `repo` already was.
 */
export async function recordDeployment(
  options: RecordDeploymentOptions,
): Promise<RecordDeploymentResult> {
  if (!REPO_RE.test(options.repo)) {
    throw new GithubApiError(`invalid repo: ${JSON.stringify(options.repo)}`);
  }
  if (!CF_DEPLOYMENT_ID_RE.test(options.cfDeploymentId)) {
    throw new GithubApiError(`invalid cfDeploymentId: ${JSON.stringify(options.cfDeploymentId)}`);
  }
  if (options.requestId !== null && !REQUEST_ID_RE.test(options.requestId)) {
    throw new GithubApiError(`invalid requestId: ${JSON.stringify(options.requestId)}`);
  }
  if (options.artifactName !== null && !ARTIFACT_NAME_RE.test(options.artifactName)) {
    throw new GithubApiError(`invalid artifactName: ${JSON.stringify(options.artifactName)}`);
  }
  const created = await ghPost(
    options.fetchImpl,
    options.token,
    `https://api.github.com/repos/${options.repo}/deployments`,
    {
      ref: options.sourceSha,
      environment: "cloudflare-pages-production",
      auto_merge: false,
      required_contexts: [],
      production_environment: true,
      payload: {
        source_sha: options.sourceSha,
        cf_deployment_id: options.cfDeploymentId,
        release_kind: options.releaseKind,
        request_id: options.requestId,
        artifact_name: options.artifactName,
      },
    },
  );
  const deploymentId = created.id;
  if (typeof deploymentId !== "number") {
    throw new GithubApiError("GitHub deployment response has no numeric id");
  }
  await ghPost(
    options.fetchImpl,
    options.token,
    `https://api.github.com/repos/${options.repo}/deployments/${deploymentId}/statuses`,
    {
      state: "success",
      environment_url: options.environmentUrl,
    },
  );
  return { deploymentId };
}
