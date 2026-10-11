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
  `apps/web`, `packages/core` or `data/published`) builds the site, caches
  the Chromium download, runs the suite with one retry, and uploads the
  HTML report and traces on failure. Workers default to 1 (`E2E_WORKERS`).
