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
  roles, accessible names and URLs. After a redesign that renames a
  control, fix the getter there; specs should not change.
- **Data** comes from the build (`e2e/support/site.ts` reads
  `themes-manifest.json`, `lineage-quality-v1.json`, `conferences.json`), so
  newly published themes are covered automatically.
- **Coverage**: landing (links to themes / catalogs / 仕組み, cross-search),
  header/footer links on each page family (no 404, `#fragment` targets
  exist), every published theme (tree, evidence panel + Esc + GitHub
  report link, 本流 toggle and `?main=`, tree/timeline and `?view=`, node
  selection, 土台/発展 panel and `?focus=`/`?to=`, BibTeX/CSV/SVG/PNG
  exports, URL copy, 新着 + valid Atom `feed.xml`, back/forward), the
  `neurips-2025` and `iclr-2025` catalogs (first results within
  `E2E_CATALOG_BUDGET_MS`, default 10 s; EN/JA search; type/tag filters;
  sort; no-result state; detail open/close with `?paper=` and Back;
  BibTeX/CSV export; URL state), `paper-links` pages with JavaScript
  disabled, the 404 page, and axe-core (serious/critical) on landing, a
  theme and a catalog.
- **Known bugs** are `test.fixme` with a `BUG:` comment describing
  expected vs actual; remove the `fixme` when fixed.
- **CI**: `.github/workflows/e2e.yml` (push/PR to develop touching
  `apps/web`, `packages/core` or `data/published`) builds the site, caches
  the Chromium download, runs the suite with one retry, and uploads the
  HTML report and traces on failure. Workers default to 1 (`E2E_WORKERS`).
