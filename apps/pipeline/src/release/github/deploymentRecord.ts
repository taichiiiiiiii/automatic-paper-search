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
  artifactName: string;
  /** `PUBLIC_ORIGIN` (@paperpilot/core/site) — the deployment's `environment_url`. */
  environmentUrl: string;
}

export interface RecordDeploymentResult {
  deploymentId: number;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** `gh-record`: `POST /repos/{repo}/deployments`, then `POST .../deployments/{id}/statuses` with `state: "success"`. */
export async function recordDeployment(
  options: RecordDeploymentOptions,
): Promise<RecordDeploymentResult> {
  if (!REPO_RE.test(options.repo)) {
    throw new GithubApiError(`invalid repo: ${JSON.stringify(options.repo)}`);
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
