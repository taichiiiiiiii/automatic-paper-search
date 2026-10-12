# apps/web

Next.js app (static export) served from Cloudflare Pages (see
`docs/design/40-post-cutover-roadmap.md` and `docs/design/41-lineage-publication-and-reliability.md`).

## `tsconfig.json` notes

- **`target`/`lib`: `ES2022`, not Next's template default `ES2017`.**
  `apps/web` imports `@paperpilot/core` (`lib/config.ts`, `lib/data.ts`),
  whose `package.json` `exports` points straight at its TS source, so `tsc`
  type-checks that source under *this* file's `target`/`lib`. `core`'s own
  `pycompat/round.ts` uses BigInt literals (ES2020+), so anything lower
  than `tsconfig.base.json`'s `ES2022` fails here even though Next's SWC
  build is unaffected (it does its own downleveling).

  (Moved out of `tsconfig.json` itself: `paperpilot/tests/test_published_assets_are_parseable.py`
  parses every `*.json` file in the repo with `json.loads` — including
  `tsconfig.json`, which has no provision for JSONC comments — so a `//`
  comment there fails that test. Keep `tsconfig.json` comment-free; put
  explanations here instead.)

## End-to-end tests (Playwright)

`e2e/` drives the **built** site (`out/`) in Chromium, in two projects:
`desktop-chromium` (1280x800) and `mobile-chromium` (Pixel 5 at 375px).

```sh
pnpm --filter @paperpilot/web build          # e2e reads apps/web/out
pnpm --filter @paperpilot/web e2e:install    # once: playwright install chromium
pnpm --filter @paperpilot/web e2e            # whole suite, both projects
pnpm --filter @paperpilot/web e2e themes --project desktop-chromium   # one file / project
pnpm --filter @paperpilot/web exec playwright show-report             # HTML report
```

- **Server**: `e2e/support/static-server.mjs` (dependency-free) serves `out/`
  like Cloudflare Pages: it applies `out/_headers` and `out/_redirects`,
  serves `/x/` from `x/index.html`, redirects `/x` → `/x/` and
  `/x/index.html` → `/x/`, and answers unknown paths with `404.html` and
  status 404. Playwright starts it on port 4173 (`E2E_PORT`); set
  `E2E_BASE_URL` to test an already-running server (e.g. a preview deploy).
- **Page health guard** (`e2e/support/fixtures.ts`): every test fails on a
  console error, a CSP violation, an uncaught page error, or a failed
  same-origin request (HTTP >= 400 or network error; `ERR_ABORTED` from
  cancelled Next prefetches is ignored). Import `test`/`expect` from
  `./support/fixtures`, never from `@playwright/test`. A test that expects
  an error opts out narrowly with `test.use({ allowedProblems: /regex/ })`.
  `guard.e2e.ts` proves the guard catches each kind.
- **Selectors** live only in the page objects (`e2e/pages/index.ts`) and use
  roles, accessible names and URLs, falling back to the stable `data-*`
  hooks the UI exposes on purpose (`data-export-menu`, `data-view-toggle`,
  `data-select-paper`, ... listed in docs/design/53-ux-audit.md). After a
  redesign that renames a control, fix the getter there; specs should not
  change.
- **Data** comes from the build (`e2e/support/site.ts` reads
  `themes-manifest.json`, `lineage-quality-v1.json`, `conferences.json`), so
  newly published themes are covered automatically.
- **Coverage**: landing (catalog section, lazy theme shelf incl. the 4 s
  fallback, in-page `#s0-confs`/`#s0-lineages` links, cross-search listbox
  and choosing a result by click and Enter), header/footer links on each
  page family (no 404, `#fragment` targets exist; header 学会 → `#s0-confs`),
  every published theme (card selection bar + `?focus=`, evidence panel +
  Esc/close with focus return + GitHub report link, 本流 toggle and
  `?main=`, tree/timeline and `?view=`, 並べ方, zoom 縮小/拡大/全体, reading
  guide first-visit/dismiss, keyboard-help dialog focus trap, 土台/発展
  panel and `?focus=`/`?to=`, export menu BibTeX/CSV/SVG/PNG, URL copy,
  collapsed 新着 + valid Atom `feed.xml`, collapsed コードとモデル,
  back/forward), the `neurips-2025` and `iclr-2025` catalogs (first results
  within `E2E_CATALOG_BUDGET_MS`, default 10 s; debounced EN search;
  full-width IME query; JA query; type/tag/要旨あり (`abs=1`) filters; sort;
  フィルタ解除; no-result state; detail open/close with `?paper=`, Esc focus
  return and Back; BibTeX/CSV export and URL copy; conference switcher; URL
  state), `paper-links` pages with JavaScript disabled, the 404 page and its
  links, and axe-core with zero serious/critical WCAG 2.2 A/AA violations
  on landing (search open), a theme (guide, feeds, export menu and evidence
  panel open), the timeline view, two catalog states, how-it-works, 404 and
  paper-links.
- **Bugs** found by the suite are fixed in the app; no `test.fixme` is left.
  A new known bug may be parked as `test.fixme` with a `BUG:` comment
  (expected vs actual) only until it is fixed.
- **CI**: `.github/workflows/e2e.yml` (push/PR to develop touching
  `apps/web`, `apps/api`, `packages/core` or `data/published`) builds the
  site, caches the Chromium download, runs the suite with one retry, then
  the request-flow suite below, and uploads the HTML report and traces on
  failure. Workers default to 1 (`E2E_WORKERS`).

## Request-flow integration test (form → Worker → GitHub)

`e2e-integration/` drives the theme request form of the **built** site
against the real Worker app and a mock GitHub:

```sh
pnpm --filter @paperpilot/web build
pnpm --filter @paperpilot/web e2e:request-flow   # ~1 min incl. wrangler start
```

- `playwright.request-flow.config.ts` starts four servers: the site
  (`:4180`, the allowed origin), the same build on a foreign origin
  (`:4181`), the mock GitHub (`e2e-integration/support/mock-github.mjs`,
  `:4290`) and `wrangler dev --local` (`:8787`, HTTPS) with the test-only
  entry `apps/api/test/integration/worker-entry.ts` + its
  `wrangler.integration.jsonc` (real Hono app, real SQLite Durable Object
  quota and in-flight dedup, local KV; outbound `api.github.com` /
  `raw.githubusercontent.com` go to the mock, anything else throws). Local
  only: no Cloudflare login, nothing is deployed.
- The page keeps its production `API_BASE` (so the per-page CSP
  `connect-src` and the Worker's CORS answers are the real ones); Chromium
  resolves that host to the local wrangler via `--host-resolver-rules`.
- Covered: a valid request (progress panel; exactly one
  `theme-on-demand.yml` dispatch with `{theme, request_id}`, ref and PAT
  header), invalid inputs (never sent), server-side gates when the page is
  bypassed (400/413/415), an existing theme (`exists`, no dispatch), double
  submit, re-request of an in-flight theme (follows the first run),
  per-IP rate limit (Japanese message), GitHub 5xx / 401 (generic error +
  Issue link; the retry dispatches), unreadable manifest (503), the accept
  switch, and a foreign origin (form closed, CORS refusal, no dispatch).
- The dispatch inputs themselves are pinned against the workflows'
  `workflow_dispatch.inputs` by `apps/api/test/workflow-dispatch-contract.test.ts`
  (Worker) and `apps/pipeline/test/workflows/gh-dispatch-commands-contract.test.ts`
  (`gh workflow run … -f` commands the repo prints).

## Lighthouse gate

`.github/workflows/lighthouse.yml` runs Lighthouse CI on PRs and pushes to
develop with `.lighthouserc.json` (desktop) and `.lighthouserc.mobile.json`
(mobile): landing, a theme, the `icml-2026` catalog and its paper-links
page, 3 runs each, median. Assertions are errors; the measured baseline
behind every budget is in each config's `_comment`. Run locally with
`npx @lhci/cli@0.15 autorun --config=.lighthouserc.json` after a build
(set `CHROME_PATH` to a Chromium, e.g. Playwright's).
