// Cloudflare Worker that backs the public theme-submission form on
// /themes/. Receives POST { theme: string } from the page, validates,
// dedupes against the existing themes-manifest.json, rate-limits per
// IP via KV, then triggers the on-demand GitHub Actions workflow. A
// server-generated request ID correlates one browser with one workflow run.
//
// Why a Worker (and not the static Pages handler):
//   - we need server-side secrets (the GH dispatch PAT) which can't
//     live in the static site;
//   - per-IP rate limiting needs durable state, which the Worker gets
//     from KV.
//
// Deployed alongside the static assets via the same wrangler.jsonc;
// the asset router falls through to this Worker for /api/* paths.

interface Env {
  // GitHub fine-grained PAT scoped to this repo with `actions:write` so
  // it can call POST /repos/:owner/:repo/actions/workflows/:wf/dispatches.
  GH_DISPATCH_PAT: string;
  // Repo + workflow target. Stored as Worker vars (not secrets) so the
  // values are visible in the dashboard.
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW_FILE: string; // "theme-on-demand.yml"
  GH_REF: string; // branch the workflow runs on, e.g. "develop"
  // KV namespace bound for per-IP rate limiting + slug existence cache.
  RATE_LIMIT_KV: KVNamespace;
}

// Slug derivation + input pattern come from worker/slug.js — a plain
// JS module shared by the Worker, the test runner, and (in spirit) the
// Python theme_slug() function. The pin test in
// paperpilot/tests/test_worker_slug_parity.py compares all three.
import { themeSlug } from "./slug.js";
import {
  json,
  isRateLimited,
  isGloballyRateLimited,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_GLOBAL_PER_DAY,
  themeStatusUnavailable,
} from "./response.js";
import { createRequestId, dispatchInputs } from "./request-id.js";
import { validatePostInput } from "./validate-input.js";
import { createPaperPilotWorker } from "./entrypoint.js";
export { themeSlug };
export { createPaperPilotWorker } from "./entrypoint.js";

async function alreadyGenerated(slug: string, env: Env): Promise<boolean> {
  // The viewer ships from GitHub Pages, so we read the manifest from
  // raw.githubusercontent.com (the Worker doesn't serve static assets).
  // GitHub's raw CDN has a ~5 min cache, so a freshly-published theme
  // stays "new" for roughly that window — same freshness behaviour as
  // CF Pages' old edge cache.
  const manifestUrl = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_REF}/docs/themes/themes-manifest.json`;
  // Fail closed on dedup: a non-200 / parse error here means we can't
  // be sure the slug is new, so we report it as "already generated"
  // and the caller answers "exists" instead of firing a redundant
  // workflow_dispatch. The user-facing error is recoverable (they
  // can retry once raw.githubusercontent.com is healthy); a silent
  // duplicate run would burn an Actions minute and a Groq quota slot.
  let resp: Response;
  try {
    resp = await fetch(manifestUrl);
  } catch {
    return true;
  }
  if (!resp.ok) return true;
  try {
    const data = (await resp.json()) as Array<{ slug?: string }>;
    return Array.isArray(data) && data.some((e) => e?.slug === slug);
  } catch {
    return true;
  }
}

async function dispatchWorkflow(theme: string, requestId: string, env: Env): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.GH_DISPATCH_PAT}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "paperpilot-theme-dispatcher",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: dispatchInputs(theme, requestId) }),
  });
  // GitHub returns 204 on success.
  return { ok: resp.ok, status: resp.status, body: resp.ok ? "" : await resp.text() };
}

async function handleStatusGet(_request: Request, _env: Env): Promise<Response> {
  // Deliberately dormant. Cloudflare KV counters are not an atomic quota, so
  // this public route must not proxy PAT-authenticated GitHub run queries.
  // The browser already treats this response as non-fatal and keeps polling
  // the public themes manifest, which remains the completion source of truth.
  return themeStatusUnavailable();
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, status: "invalid", message: "JSON body required" }, { status: 400 });
  }
  // Input validation lives in worker/validate-input.js so it can be
  // unit-tested without an HTTP round-trip. The pure helper bundles
  // body parse, theme pattern check, and slug derivation.
  const validation = validatePostInput(payload, themeSlug) as
    | { ok: true; raw: string; slug: string }
    | { ok: false; status: number; body: object };
  if (!validation.ok) {
    return json(validation.body, { status: validation.status });
  }
  const raw = validation.raw;
  const slug = validation.slug;

  // Existing theme → short-circuit. No rate-limit charge, no dispatch.
  if (await alreadyGenerated(slug, env)) {
    return json({ ok: true, status: "exists", slug });
  }

  // Rate limits — applied AFTER the manifest dedup so benign "redirect
  // to existing" requests don't count against either bucket. Per-IP
  // first (catches honest abuse) then a global daily cap that protects
  // against IP rotation / residential proxy attacks.
  //
  // cf-connecting-ip is set by Cloudflare's edge and cannot be spoofed
  // by a client. If it's missing the request didn't come through the
  // edge (local dev, misconfigured proxy) — fail closed rather than
  // falling through to a shared "rl:unknown" bucket that any single
  // local-dev session would exhaust.
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) {
    console.warn("cf-connecting-ip header missing; rejecting");
    return json({
      ok: false,
      status: "error",
      message: "request must originate from the public edge",
    }, { status: 400 });
  }
  if (await isRateLimited(ip, env.RATE_LIMIT_KV)) {
    return json({
      ok: false,
      status: "rate_limited",
      message: `more than ${RATE_LIMIT_PER_HOUR} new themes/hour from this IP`,
    }, { status: 429 });
  }
  if (await isGloballyRateLimited(env.RATE_LIMIT_KV)) {
    return json({
      ok: false,
      status: "rate_limited",
      message: `daily generation cap (${RATE_LIMIT_GLOBAL_PER_DAY}) reached; please try again tomorrow`,
    }, { status: 429 });
  }

  let requestId: string;
  try {
    requestId = createRequestId();
  } catch (error) {
    console.error(`request ID generation failed: ${(error as Error).message}`);
    return json({
      ok: false,
      status: "error",
      message: "could not start the generation job; please retry shortly",
    }, { status: 500 });
  }

  const dispatch = await dispatchWorkflow(raw, requestId, env);
  if (!dispatch.ok) {
    // Don't leak the GitHub error body — it can include rate-limit
    // headers / token hashes. Log full detail to the Worker tail; user
    // sees a generic message.
    console.error(`workflow dispatch failed: ${dispatch.status} ${dispatch.body}`);
    return json({
      ok: false,
      status: "error",
      message: "could not start the generation job; please retry shortly",
    }, { status: 502 });
  }

  return json({ ok: true, status: "queued", slug, request_id: requestId });
}

// Paper Slide stays dormant in production: no API adapter is constructed or
// injected here. Tests can opt into the exact routes through the factory.
const handler: ExportedHandler<Env> = createPaperPilotWorker({
  handleThemePost: handlePost,
  handleThemeStatusGet: handleStatusGet,
});

export default handler;
