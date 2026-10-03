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
// Deployment: this is a standalone API Worker, not bundled with the
// static site. GitHub Pages serves docs/ (including /themes/)
// independently; this Worker owns only /api/* (see worker/README.md
// "API-only Worker design"). wrangler.jsonc has no assets binding.
//
// This file is intentionally thin: Node 20 has no TS-strip step, so it
// cannot be imported by tests (see worker/README.md). All testable
// request-handling logic — the full POST /api/themes chain (input
// validation, manifest dedup, rate limiting, dispatch) — lives in
// worker/themes-post.js as plain JS with `fetch` injected. This file
// only wires that handler with the real global fetch and the route
// table in worker/entrypoint.js.

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
import { themeStatusUnavailable } from "./response.js";
import { createThemesPostHandler } from "./themes-post.js";
import { createPaperPilotWorker } from "./entrypoint.js";
export { themeSlug };
export { createPaperPilotWorker } from "./entrypoint.js";

async function handleStatusGet(_request: Request, _env: Env): Promise<Response> {
  // Deliberately dormant. Cloudflare KV counters are not an atomic quota, so
  // this public route must not proxy PAT-authenticated GitHub run queries.
  // The browser already treats this response as non-fatal and keeps polling
  // the public themes manifest, which remains the completion source of truth.
  return themeStatusUnavailable();
}

// The real global `fetch` is the only thing production injects — every
// other dependency the POST chain needs (env, KV) is already carried by
// the `(request, env)` signature createThemesPostHandler returns.
// Wrapped in an arrow function (not passed bare) so it's always invoked
// with no `this` binding to the Worker's global scope — passing the
// method reference directly would detach it, and workerd's JSG-wrapped
// globals can throw "Illegal invocation" when called that way (ES
// modules are strict mode; `this` would be `undefined`, not the global).
const handlePost = createThemesPostHandler({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}) as (request: Request, env: Env) => Promise<Response>;

// Paper Slide stays dormant in production: no API adapter is constructed or
// injected here. Tests can opt into the exact routes through the factory.
const handler: ExportedHandler<Env> = createPaperPilotWorker({
  handleThemePost: handlePost,
  handleThemeStatusGet: handleStatusGet,
});

export default handler;
