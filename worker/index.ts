// Cloudflare Worker that backs the public theme-submission form on
// /themes/. Receives POST { theme: string } from the page, validates,
// dedupes against the existing themes-manifest.json, rate-limits per
// IP via KV, then triggers the on-demand GitHub Actions workflow that
// regenerates the lineage and pushes to develop.
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
  // Optional static-asset binding. Present when the legacy
  // "Workers + Static Assets" wrangler config (assets.directory = docs)
  // is in effect; absent when the static viewer is served from GitHub
  // Pages and the Worker only owns /api/*. Code paths that touch this
  // tolerate both shapes via `env.ASSETS ?? globalThis`.
  ASSETS?: Fetcher;
}

// Slug derivation + input pattern come from worker/slug.js — a plain
// JS module shared by the Worker, the test runner, and (in spirit) the
// Python theme_slug() function. The pin test in
// paperpilot/tests/test_worker_slug_parity.py compares all three.
import { themeSlug, THEME_INPUT_PATTERN } from "./slug.js";
import {
  json,
  isRateLimited,
  isGloballyRateLimited,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_GLOBAL_PER_DAY,
} from "./response.js";
import { pickMatchingRun } from "./run-match.js";
import { validatePostInput } from "./validate-input.js";
export { themeSlug };

const THEME_PATTERN = THEME_INPUT_PATTERN;

async function alreadyGenerated(slug: string, request: Request, env: Env): Promise<boolean> {
  // Two manifest sources, picked by which deploy shape is live:
  //
  //   1. Same-origin /themes/themes-manifest.json via the ASSETS
  //      binding — only when the legacy CF Pages-style deploy
  //      (assets.directory = docs) is configured. No CDN hop.
  //
  //   2. raw.githubusercontent.com/<owner>/<repo>/<ref>/docs/themes/...
  //      — used in the GH Pages + Worker hybrid. The Worker no longer
  //      serves the static bundle, so we read the manifest straight
  //      from the develop branch. GitHub's raw CDN has a ~5 min cache
  //      that matches the previous CF Pages CDN behaviour, so a
  //      freshly-published theme stays "new" for a similar window.
  let manifestUrl: string;
  // `new Request(url, ...)` is used at the call site so both fetchers
  // (CF's Fetcher binding + globalThis.fetch) receive an identical
  // Request object — Fetcher's signature is stricter than the global
  // fetch's URL-or-Request-or-string union, so the explicit Request
  // wrapper is what keeps the structural type check happy.
  let fetcher: { fetch: typeof fetch };
  if (env.ASSETS) {
    manifestUrl = `${new URL(request.url).origin}/themes/themes-manifest.json`;
    fetcher = env.ASSETS;
  } else {
    manifestUrl = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_REF}/docs/themes/themes-manifest.json`;
    fetcher = globalThis;
  }
  // Fail closed on dedup: a non-200 / parse error here means we can't
  // be sure the slug is new, so we report it as "already generated"
  // and the caller answers "exists" instead of firing a redundant
  // workflow_dispatch. The user-facing error is recoverable (they
  // can retry once raw.githubusercontent.com is healthy); a silent
  // duplicate run would burn an Actions minute and a Groq quota slot.
  let resp: Response;
  try {
    resp = await fetcher.fetch(new Request(manifestUrl, { method: "GET" }));
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

async function dispatchWorkflow(theme: string, env: Env): Promise<{ ok: boolean; status: number; body: string }> {
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
    body: JSON.stringify({ ref: env.GH_REF, inputs: { theme } }),
  });
  // GitHub returns 204 on success.
  return { ok: resp.ok, status: resp.status, body: resp.ok ? "" : await resp.text() };
}

// Subset of fields we surface to the client. Mirrors the JSON shape of
// /actions/workflows/{file}/runs items; intentionally narrow so we
// don't leak GitHub-internal fields (head_sha, run_attempt etc).
interface RunSummary {
  status: string;       // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | "timed_out" | null while running
  html_url: string;     // direct link to the run for the failure-UI CTA
  created_at: string;
  run_started_at: string | null;
  display_title: string;
}

// Find the most recent workflow run whose display_title matches the
// `theme` input. Run names are set by the `run-name:` block at the top
// of theme-on-demand.yml ("theme-on-demand: <theme>"), so a substring
// match on the theme — verbatim, case-preserved — is unambiguous.
//
// Returns null when GitHub doesn't list a matching run yet (typical for
// the first ~5-10 s after a dispatch lands but before Actions indexes
// the run).
async function findRecentRun(theme: string, env: Env): Promise<RunSummary | null> {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`;
  const resp = await fetch(url, {
    headers: {
      "authorization": `Bearer ${env.GH_DISPATCH_PAT}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "paperpilot-theme-dispatcher",
    },
  });
  if (!resp.ok) {
    console.warn(`workflow runs query failed: ${resp.status}`);
    return null;
  }
  type RunFromApi = {
    status: string;
    conclusion: string | null;
    html_url: string;
    created_at: string;
    run_started_at: string | null;
    display_title: string;
  };
  const data = await resp.json() as { workflow_runs?: RunFromApi[] };
  // Matching logic lives in run-match.js so it can be unit-tested
  // without an HTTP mock — see worker/run-match.test.mjs.
  const match = pickMatchingRun(data?.workflow_runs as unknown[] | undefined, theme) as RunFromApi | null;
  if (!match) return null;
  return {
    status: match.status,
    conclusion: match.conclusion,
    html_url: match.html_url,
    created_at: match.created_at,
    run_started_at: match.run_started_at,
    display_title: match.display_title,
  };
}

async function handleStatusGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const theme = url.searchParams.get("theme") ?? "";
  // Same validator as the POST endpoint — keep the surface area uniform
  // so a malformed query string can't probe the GH API on our behalf.
  if (!THEME_PATTERN.test(theme.trim())) {
    return json({
      ok: false,
      status: "invalid",
      message: "theme query param must be 2-80 chars matching /^[A-Za-z0-9 _-]+$/",
    }, { status: 400 });
  }
  let run: RunSummary | null = null;
  try {
    run = await findRecentRun(theme.trim(), env);
  } catch (e) {
    // Treat upstream errors as "no info yet" rather than a hard failure;
    // the manifest poll is still the primary source of truth.
    console.warn(`findRecentRun threw: ${(e as Error).message}`);
    return json({ ok: true, run: null });
  }
  return json({ ok: true, run });
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
  if (await alreadyGenerated(slug, request, env)) {
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

  const dispatch = await dispatchWorkflow(raw, env);
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

  return json({ ok: true, status: "queued", slug });
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/themes" && request.method === "POST") {
      return handlePost(request, env);
    }
    if (url.pathname === "/api/themes/status" && request.method === "GET") {
      return handleStatusGet(request, env);
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      // Cross-origin preflight from the GH-Pages viewer. POST with a
      // JSON body and content-type: application/json triggers a CORS
      // preflight, so we must echo the allowed origin/method/headers
      // before the browser will send the actual request. The wildcard
      // ACAO matches the json() helper; tighten both together if you
      // lock the API down to a single origin later.
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    // Anything else falls through to the static asset router when it's
    // configured (legacy CF Pages deploy). In the GH Pages + Worker
    // hybrid the Worker only owns /api/*, so everything else is a 404.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },
};

export default handler;
