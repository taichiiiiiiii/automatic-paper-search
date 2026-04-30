# Theme submission Worker

Cloudflare Worker that backs the public on-demand theme generator at
`/themes/`. Receives `POST /api/themes`, validates the input, dedupes
against the existing manifest, rate-limits per IP, and dispatches the
`theme-on-demand.yml` GitHub Actions workflow.

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
   │                              │ POST /workflows/dispatches │
   │                              │ ─────────────────────────► │
   │                              │                            │
   │                              │ ◄─── 204 No Content ────── │
   │ ◄── 200 {status:"queued",     │                            │
   │     slug:"vision-transformer"} │                            │
   │                              │                            │
   │ poll themes-manifest.json     │   build_theme_lineage.py   │
   │ every 5s                     │   generate_themes_manifest │
   │                              │   git commit + push        │
   │                              │   ─────────► [CF Pages auto-deploy]
   │ ◄── slug appears             │                            │
   │ redirect to ?theme=<slug>    │                            │
```

## Setup

1. **Install wrangler** and authenticate:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Create the KV namespace** for per-IP rate limiting:

   ```bash
   wrangler kv namespace create RATE_LIMIT_KV
   ```

   Replace `REPLACE_WITH_ACTUAL_KV_ID` in `wrangler.jsonc` with the id
   the command prints (something like
   `id = "abc123…"`). Commit the change.

3. **Mint a fine-grained GitHub PAT** scoped to this repo with the
   `Actions: read & write` permission, and store it as a Worker secret:

   ```bash
   wrangler secret put GH_DISPATCH_PAT
   ```

   The PAT is the only credential that can dispatch jobs — keep it
   tight (no other scopes, no other repos).

4. **Deploy**:

   ```bash
   wrangler deploy
   ```

   The same wrangler config also handles the static `docs/` bundle, so
   one deploy ships both the Pages assets and the Worker.

## Local development

```bash
wrangler dev --local
```

The form on `http://localhost:8787/themes/` will hit the local Worker.
For end-to-end testing without burning real GH Actions runs, point the
PAT at a test repo or stub the dispatch in the Worker source.

## Tests

```bash
node worker/index.test.mjs
uv run pytest paperpilot/tests/test_worker_slug_parity.py
```

The first checks `themeSlug()` and `THEME_INPUT_PATTERN` in JS; the
second runs the SAME inputs through both the JS module and Python's
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
