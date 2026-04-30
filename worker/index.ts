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
  // Static-asset binding produced by wrangler when `assets.directory` is
  // configured. We hand non-API requests through to it so /themes/, /
  // and friends keep working.
  ASSETS: Fetcher;
}

// Slug derivation + input pattern come from worker/slug.js — a plain
// JS module shared by the Worker, the test runner, and (in spirit) the
// Python theme_slug() function. The pin test in
// paperpilot/tests/test_worker_slug_parity.py compares all three.
import { themeSlug, THEME_INPUT_PATTERN } from "./slug.js";
export { themeSlug };

const RATE_LIMIT_PER_HOUR = 5;
// Global daily ceiling on dispatched workflows. Even with a perfect
// per-IP limiter, a /20 IPv6 block or a rotating proxy can bypass IP
// rate limiting; this cap protects against direct-cost denial-of-service
// against the LLM provider (Groq Stage 4 calls).
const RATE_LIMIT_GLOBAL_PER_DAY = 100;
const THEME_PATTERN = THEME_INPUT_PATTERN;

interface JsonResponse {
  ok: boolean;
  status: "exists" | "queued" | "rate_limited" | "invalid" | "error";
  slug?: string;
  message?: string;
}

function json(body: JsonResponse, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // Tight CORS — same-origin only, since the page is on the same
      // CF Pages domain. If we ever expose the API for embeds, change
      // this to a specific allow-list.
      "vary": "origin",
    },
    ...init,
  });
}

async function alreadyGenerated(slug: string, request: Request, env: Env): Promise<boolean> {
  // Re-resolve against the static asset bundle on the same origin so we
  // don't need a hard-coded site URL or external fetch. cf.cacheTtl=0
  // keeps a freshly-deployed manifest visible without a cooldown.
  const origin = new URL(request.url).origin;
  const manifestUrl = `${origin}/themes/themes-manifest.json`;
  // Prefer the static asset binding (no network hop, no CDN cache) when
  // available; fall back to a regular fetch for compatibility with
  // non-Pages deployments.
  const fetcher = env.ASSETS ?? globalThis;
  const resp = await fetcher.fetch(new Request(manifestUrl, { method: "GET" }));
  if (!resp.ok) return false;
  try {
    const data = (await resp.json()) as Array<{ slug?: string }>;
    return Array.isArray(data) && data.some((e) => e?.slug === slug);
  } catch {
    return false;
  }
}

async function isRateLimited(ip: string, kv: KVNamespace): Promise<boolean> {
  const key = `rl:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_PER_HOUR) return true;
  // 1-hour TTL — KV expirationTtl resets the window when the next
  // request lands after the bucket expires, so a single client gets a
  // fresh quota each hour rather than a fixed UTC-aligned window.
  await kv.put(key, String(count + 1), { expirationTtl: 3600 });
  return false;
}

// Today's UTC date as YYYY-MM-DD. Worker time is UTC by default.
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function isGloballyRateLimited(kv: KVNamespace): Promise<boolean> {
  const key = `rl:global:${todayUTC()}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_GLOBAL_PER_DAY) return true;
  // 24h TTL on the global bucket. Even if KV reset on every write
  // sliding the window slightly, the daily cap is loose enough that the
  // amortised throughput stays bounded.
  await kv.put(key, String(count + 1), { expirationTtl: 86400 });
  return false;
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

async function handlePost(request: Request, env: Env): Promise<Response> {
  let payload: { theme?: unknown };
  try {
    payload = (await request.json()) as { theme?: unknown };
  } catch {
    return json({ ok: false, status: "invalid", message: "JSON body required" }, { status: 400 });
  }
  const raw = typeof payload.theme === "string" ? payload.theme.trim() : "";
  if (!THEME_PATTERN.test(raw)) {
    return json({
      ok: false,
      status: "invalid",
      message: "theme must be 2-80 chars matching /^[A-Za-z0-9 _-]+$/",
    }, { status: 400 });
  }

  let slug: string;
  try {
    slug = themeSlug(raw);
  } catch (e) {
    return json({
      ok: false,
      status: "invalid",
      message: `slug derivation failed: ${(e as Error).message}`,
    }, { status: 400 });
  }

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
    if (url.pathname === "/api/themes" && request.method === "OPTIONS") {
      // Preflight isn't strictly needed for same-origin same-site posts,
      // but reply 204 anyway in case a client sends one.
      return new Response(null, { status: 204 });
    }
    // Anything else falls through to the static asset router (the
    // worker only owns /api/*; everything else is the Pages bundle).
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },
};

export default handler;
