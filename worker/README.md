# PaperPilot API Worker

Cloudflare Worker that backs the public on-demand theme generator at
`/themes/`. It receives `POST /api/themes`, validates the input, dedupes
against the existing manifest, rate-limits per IP, and dispatches the
`theme-on-demand.yml` GitHub Actions workflow. Paper Slide request/callback
adapters are locally implemented behind explicit seams, but production does
not inject their adapter, Durable Object binding, catalog pin, or provider;
that plane remains dormant.

## Architecture

```
[browser]                      [CF Worker]                 [GH Actions]
   │                              │                            │
   │ POST /api/themes             │                            │
   │ { theme: "Vision Transformer"} │                            │
   │ ────────────────────────────► │                            │
   │                              │ themeSlug() + validate     │
   │                              │ check manifest (existing?) │
   │                              │ rate limit (KV, 5/h/IP)    │
   │                              │ create request_id          │
   │                              │ POST /workflows/dispatches │
   │                              │ {theme, request_id}        │
   │                              │ ─────────────────────────► │
   │                              │                            │
   │                              │ ◄─── 204 No Content ────── │
   │ ◄── 200 {status:"queued",     │                            │
   │     slug:"vision-transformer", │                            │
   │     request_id:"theme-…"}      │                            │
   │                              │                            │
   │ poll themes-manifest.json     │   build_theme_lineage.py   │
   │ every 5s                     │   validate + promote       │
   │                              │   exact-SHA Pages release  │
   │ ◄── slug appears             │                            │
   │ redirect to ?theme=<slug>    │                            │
```

## API-only Worker design

PaperPilot is one product with two deployment units:

- **GitHub Pages read plane** — serves the generated `docs/` site, including
  `/themes/` and `themes-manifest.json`.
- **Cloudflare Worker write plane** — production owns exact `/api/themes` POST
  and `/api/themes/status` GET routes. The shared entrypoint also has locally
  tested Paper Slide public (`/api/paper-slides`, `/api/paper-slides/status`)
  and authenticated callback seams, but production `worker/index.ts` injects
  no Paper Slide adapter or Durable Object binding, so those routes remain
  dormant and return `404`. `wrangler.jsonc` intentionally has no static-assets
  or Paper Slide binding.

The Pages viewer and Worker are cross-origin. During migration, JSON responses
and `/api/*` preflights use `Access-Control-Allow-Origin: *`; requests do not
carry cookies or browser credentials. Tightening this to the canonical Pages
origin remains a separate coordinated change to both the JSON and preflight
headers.

`GET /api/themes/status` is currently dormant and always returns a stable
`503` JSON envelope with CORS and `Cache-Control: no-store`. Cloudflare KV is
not used as an atomic quota for PAT-authenticated GitHub run queries. The
browser treats this response as non-fatal and continues polling the public
`themes-manifest.json`, which is the completion source of truth. Live workflow
status may be enabled only after a strict atomic quota/cache boundary is added.

## Setup (one-time)

> **Quick path:** run `bash worker/setup.sh` from the repo root. It does
> the steps below interactively (login → KV create → splice id →
> secret put → deploy → post-deploy probe). Use the manual steps if you
> need fine-grained control.

You need a developer machine with `wrangler` and Cloudflare auth.

1. **Install wrangler** and authenticate:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Create the KV namespace** for per-IP rate limiting:

   ```bash
   wrangler kv namespace create RATE_LIMIT_KV
   ```

   The command prints something like:

   ```
   { binding = "RATE_LIMIT_KV", id = "abc123…" }
   ```

   **Replace the 32-zero placeholder** in the root `wrangler.jsonc`
   (`kv_namespaces[0].id`) with that real id. Commit the change.

3. **Mint a fine-grained GitHub PAT** scoped to this repo with the
   `Actions: read & write` permission and store it as a Worker secret:

   ```bash
   wrangler secret put GH_DISPATCH_PAT
   ```

   The PAT is the only credential that can dispatch jobs — keep it
   tight (no other scopes, no other repos, short expiry).

4. **Deploy** (or just push to `develop` — CF auto-deploys on push):

   ```bash
   wrangler deploy
   ```

After step 3, a push to `develop` can independently trigger the GitHub Pages
release and the Cloudflare Worker build. They remain separate deploys even
though the viewer presents one product.

## Local development

```bash
wrangler dev --local
```

This starts only the API Worker; it does not serve `docs/`. Serve the Pages
files separately and configure the viewer's API base to the local Worker when
testing cross-origin behavior. For end-to-end testing without burning real GH
Actions runs, point the PAT at a test repo or stub the dispatch in the Worker
source.

## Tests

Docker is the canonical integration-test target after approved image digests
are available. Until then, the following host commands are auxiliary checks and
are not evidence that the Docker runtime gate passed:

```bash
node --test worker/entrypoint.test.mjs
node --test worker/index.test.mjs
node --test worker/paper-slide-api.test.mjs
node --test worker/paper-slide-catalog.test.mjs
node --test worker/paper-slide-contract.test.mjs
node --test worker/paper-slide-coordinator.test.mjs
node --test worker/paper-slide-dispatch.test.mjs
node --test worker/paper-slide-durable-coordinator.test.mjs
node --test worker/paper-slide-request-plane.integration.test.mjs
node --test worker/paper-slide-runtime.test.mjs
node --test worker/paper-slide-workflow-api.test.mjs
node --test worker/request-id.test.mjs
node --test worker/response.test.mjs
node --test worker/run-match.test.mjs
node --test worker/validate-input.test.mjs
uv run --extra dev pytest \
  paperpilot/tests/test_worker_node_suites.py \
  paperpilot/tests/test_worker_request_id_contract.py \
  paperpilot/tests/test_worker_slug_parity.py
```

`test_worker_node_suites.py` pins this complete 15-suite inventory so a newly
added Worker suite cannot silently escape pytest. The parity test runs the same
slug inputs through the JS module and Python's
`paperpilot.scripts._common.theme_slug()` and fails if they disagree.

## Security model

| Layer | Defense |
|---|---|
| Frontend | HTML pattern + maxlength on `<input>` |
| Worker | `THEME_INPUT_PATTERN` regex + `themeSlug()` derivation |
| GH Actions | `THEME_INPUT` env var only — never spliced into shell |
| Python | `theme_slug()` NFKD-normalises and caps to 64 chars |

The user-typed string is never interpolated into a shell or path
construction. Each layer re-validates because each receives the data
from a less-trusted boundary than the previous.
