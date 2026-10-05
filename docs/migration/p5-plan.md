# P5 実装計画（切替）

> 2026-10-05 作成（opus の計画エージェント）。設計書 [39](../design/39-typescript-cloudflare-migration.md) §7.4・§8 P5 の詳細版。本文は英語のまま保存。**(verify)** は Cloudflare / GitHub の仕様を未確認の箇所。

## 0. What I found that changes the plan

1. **The single layout switch from §1 does not exist yet.** About 30 call sites hard-code the old paths. Examples:
   - `join(repoRoot,"docs")` and `"paperpilot","data"` in `buildPagesCli.ts`, `buildSummaryCli.ts`, `searchIndexCli.ts`, `buildLineageCli.ts`, `buildConferenceLineageCli.ts`, `buildLineageQualityCli.ts`, `auditLineageQualityCli.ts`, `auditThemeSeedsCli.ts`, `computeThemeQualityCli.ts`, `lineage/theme/cli.ts`, `seedFilters.ts`, `buildLineage.ts`, `auditLineageClassificationBreakdownCli.ts`, `buildDeepLineageCli.ts`.
   - `classify.ts:454` uses the relative path `../../../../../paperpilot/data/...`.
   - `promote.ts` `SHARED_PATHS`, and `validateRelease.ts` `DEFAULT_REQUIRED_ARTIFACTS`.
   - `apps/web/scripts/copy-data.ts` and `apps/web/lib/lineage/server-fs.ts` (both define `DOCS_DIR`).
   - About 20 test files.
   
   Without this switch the "one cutover commit" cannot be reviewed. It is changeset A0.
2. **Promoter hooks are not wired (follow-up #3).** `defaultRefreshSharedOutputs` and `defaultValidatePromotedTree` throw for every kind except `test-only`.
3. **Some CLIs are missing:**
   - arXiv conference collector: only `runCollectConferenceMain` exists, with no `isMain` entry.
   - identity-lite: `release/derived/identityLite.ts` has no CLI.
   - `registerConference`: no CLI, and apps/web does not read it yet (follow-up #17).
   - No theme-slug printer for the workflow's "freeze" step.
   - `buildLineageCli` / `buildDeepLineageCli` entry points are still provisional (follow-up #19).
4. **`apps/api` has no D1 code.** It has the Durable Object (`QuotaCounter`), the KV flags, `/api/health` and dry-run mode. P5 should not add a D1 binding nobody reads; record D1 as a P3 gap / P6 item.
5. **`apps/api/wrangler.jsonc` is the preview config** (`paperpilot-api-preview`, placeholder KV id, binding `CONFIG_KV`). The old Worker binds the same production namespace `3e11d3e73dae42a8b94f06a9fa9de19f` as `RATE_LIMIT_KV`. Binding names are per-Worker, so `CONFIG_KV` → `3e11…` is fine. The old Worker's rate-limit keys sit in the same namespace and do not collide with `accepting`, `origin_allowlist` or `namespace_tag`.
6. **The old site's `docs/assets/theme.js` has no `paused` handling.** `apps/web/lib/themes-request.ts` handles both `paused` and `dry_run`.
7. **Legacy-coupled tests:**
   - `packages/core/test/slug/theme.test.ts` imports `worker/slug.js`.
   - `apps/web/test/misc/how-it-works.test.ts` reads `docs/how-it-works/index.html`.
   - `apps/web/test/misc/sitemap.test.ts` reads `docs/sitemap.xml`.
   - `apps/web/test/catalog/paper-links-parity.test.ts` reads `docs/<conf>/paper-links.html`.
   - `buildLineageQuality.parity.test.ts` and `parity/self-check.test.ts` read the real `docs/` and `paperpilot/data`.
   - There are 14 fixture-generator `.py` files under `apps/` and `packages/`. Their outputs are committed and no test spawns Python, so the generators can simply be deleted.
8. **Already fine:**
   - `biome.json` only includes `apps/**` and `packages/**`, so `data/` and `legacy/` are never linted. No change needed.
   - TS `buildPages` writes no `paper-links.html`.
   - `apps/web` postbuild already produces `out/sitemap.xml`, `out/_redirects` and `out/_headers` (`frame-ancestors 'self'` only).
   - So `sync_asset_versions` and `build_sitemap` disappear from promotion.
9. **`docs/lineage-pilot-index-v1.json` has no generator** once `lineage_pilot` is deleted. It becomes a static published file.
10. **`c090c84` is already on `origin/develop`.**

---

## 1. Overall shape: three tiers and two merges

| Tier | Contents | Where / when | Needs the user? |
|---|---|---|---|
| **A** (A0–A12) | Refactors and new code, all inert with the layout still set to legacy. New workflows staged in `.github/workflows-p5/` (GitHub ignores that folder). Data-move tool, redirect site, runbook doc | feat branch, now, fully offline | No (except A6/A5 values: Pages project name, production branch, origin) |
| **Merge A** | feat up to the end of A → develop. Inert on develop (see §6.2) | After A | Approval. Check Workers Builds settings first (R1) |
| **Phase W** | Production Worker switches from `worker/` to `apps/api` (KV seeded first) | After Merge A | Yes: KV writes, Workers Builds setting, approval |
| **B** | One generated cutover commit: `git mv` data, flip the layout constant, move staged workflows into `.github/workflows/`, delete `publish.yml` / `paper-slides-on-demand.yml` / `ts-ci.yml`, `.gitignore`, config path keys. Optional second data-only commit **B′** for format-only regeneration | Created during the pause, on top of the current develop tip, merged with a **merge commit** | Yes: pause, disable workflows, approval |
| **C** | Python and legacy deletion, doc rewrite | After about one week of observation | Approval, and decision 8 (`.codex/`) |

**Why two merges, and decision 10.** If the Worker swap happens before the data cutover, you get the pause switch, origin allowlist and `/api/health` on production without the interim `worker/` change from decision 10. Each step also has its own rollback. If the user keeps the design's order (merge first, then switch the Worker root), the interim `worker/` change is still required, because §7.4 step 1 pauses requests on the current Worker. Either way, an optional small `theme.js` paused-message change can ride in Merge A (A13).

---

## 2. Tier A changesets (feat, offline, no deploy)

All tier A changesets can be done on the branch now with no deploy. A5 and A6 additionally need values from the user, as noted in each section.

### A0: single data-layout switch
- **Add** `packages/core/src/layout/index.ts`, exported as `@paperpilot/core/layout` in `packages/core/package.json`.
  - `export const LAYOUT_MODE: "legacy" | "p5" = "legacy"`.
  - `layoutFor(repoRoot)` returns `{ published, state, inputs, config, legacySite, workflowsDir }`.
    - legacy: `docs`, `paperpilot/data`, `paperpilot/output`, `paperpilot/data`, `docs`, `.github/workflows-p5`.
    - p5: `data/published`, `data/state`, `data/inputs`, `data/config`, `legacy/gh-pages-site`, `.github/workflows`.
  - Named file helpers, each relative to the right root: `seenIds`, `runHistory`, `classificationsCache`, `lineageCacheDir`, `denylist`, `foundationalAllowlist`, `themeAliases`, `themeBlacklist`, `paperRepos`, `qualityPolicy`, `auditFixtures`, `conferenceSources`, `identityCoverage`, `conferenceCopyDir`, `collectConfig(kind)`.
  - Repo-relative POSIX strings for allowlists via `relLayout()`.
- **Modify** every call site listed in §0.1 to use these helpers, including `classify.ts:454`, `apps/web/scripts/copy-data.ts`, `apps/web/lib/lineage/server-fs.ts`, and `promote.ts` `SHARED_PATHS` (§3).
- **Tests:**
  - `packages/core/test/layout/index.test.ts`: both modes; only one constant differs.
  - A grep-style contract test that fails if `"docs"`, `"paperpilot","data"` or `"paperpilot","output"` literals appear in `apps/*/src`, `apps/web/{lib,app,scripts}` or `packages/core/src` (comments excluded).
  - The existing suite must stay green unchanged under legacy mode.

### A1: decouple tests from legacy files
- Convert to frozen fixtures under `apps/web/test/fixtures/legacy/`:
  - `how-it-works.test.ts` and `sitemap.test.ts` (copy today's HTML and XML).
  - `paper-links-parity.test.ts` (copy one or two `paper-links.html` files).
  - `packages/core/test/slug/theme.test.ts`: replace the dynamic `import(worker/slug.js)` with a committed `worker-slug-expected.json` produced once from `worker/slug.js`.
- Tests that read real repo data must use `layoutFor(getRepoRoot())`. Sort each one into:
  - (a) invariant checks on live data (keep), or
  - (b) equality with frozen expected output (point at a fixture copy).
  
  Otherwise a legitimate data update inside the promoter's validate step will fail the tests (R9).
- Tests: the suite stays green in both modes. Add a temporary CI job running `LAYOUT_MODE` = p5 against an `applyDataMove` dry-run tree (A9).

### A2: missing CLIs (`isMain` entry, strict argparse, env-only for free text)
- `apps/pipeline/src/conference/arxiv/cli.ts`: `--conference --venue --query --max --output-root` (default `layout.inputs`), wired to `runCollectConferenceMain`.
- `apps/pipeline/src/release/derived/identityLiteCli.ts`: `--as-of`, default roots from layout. Writes `identity-aliases-v1.json` to published and `identity-coverage-v1.json` to state.
- `apps/pipeline/src/conference/scaffold/cli.ts`:
  - `--conference` from argv (validated slug). Display and lede come from env `DISPLAY` / `LEDE` only.
  - Writes **one file per slug**: `<layout.config>/conference-copy/<slug>.json`. A shared manifest would make two concurrent conference promotions fail the CAS "paths changed on develop" check.
  - Rejects `RESERVED_CONFERENCE_SLUGS`.
- `apps/pipeline/src/lineage/theme/slugCli.ts`: reads `THEME_INPUT` from env and prints `themeSlug()`. Exit 1 if the result is empty or does not match `^[a-z0-9-]{1,64}$`.
- Follow-up #19: finish the `buildLineageCli` / `buildDeepLineageCli` entry points (load `.env` from `layout.config`, provider factory). Add spawn tests like `collect/cli.spawn.test.ts`.
- `apps/web/lib/catalog-copy.ts` (follow-up #17): `getCatalogCopy()` uses the static map, then the build-time `conference-copy/<slug>.json` (read through layout with node:fs in a server module), then the generic fallback. Test: a new slug with a copy file renders its display and lede, escaped.
- Tests: one spawn test per CLI (`--help`, bad flag, env-only free text). No network.

### A3: promoter wiring (follow-up #3), detailed in §3
- **Add** `apps/pipeline/src/release/promoteHooks.ts`: the command tables, `createRefreshHook(spawn)`, `createValidateHook(spawn)`.
- **Modify** `release/cli.ts` `runPromote` to pass these hooks. `promote.ts` keeps its throwing defaults for library use.
- Tests:
  - The command table per kind equals the expected ordered list (pinned against the order in `promote-generated.sh`, minus the dropped steps).
  - An injected spawn records `cwd === tree` for every command.
  - A failing command propagates as `PromotionError`, with no commit and no push.
  - Integration: a `test-only`-style local bare remote with a tiny fixture repo, using a stub command table.

### A4: release CLI extensions (`apps/pipeline/src/release/`)
- `validate bundle <out-dir>`: same as `validateLocal` without the HEAD==SHA check. Needed because the promote worktree's HEAD is the pre-commit tip.
- `DEFAULT_REQUIRED_ARTIFACTS` becomes the p5 list (switched by layout mode):
  - `index.html`, `404.html`, `conferences.json`, `search-index-v2.json`, `lineage-quality-v1.json`, `sitemap.xml`, `_redirects`, `_headers`.
  - Plus `_paperpilot-deployment.json` in build mode.
  - Drop `search-index.json`, `assets/versions.json`.
- Keep the design/research/`*_IMPLEMENTER.md` forbidden-path check and the CSP-meta-on-every-HTML check.
- `marker <out-dir>`: env `SOURCE_SHA` / `RELEASE_KIND` / `REQUEST_ID` (each regex-checked). Writes `_paperpilot-deployment.json`, byte-identical to today's Python output: sorted keys, `,`/`:` separators, `ensure_ascii=False`, trailing `\n`, schema `paperpilot-deployment-v1`.
- `smoke` extensions:
  - `--wait-marker <seconds>`: polls the marker until it shows the SHA (alias propagation).
  - `--expect-bytes <out-dir>`: sha256 of served `/`, `/404.html` and one conference page must equal the artifact.
  - `--expect-404 /__pp_smoke_missing__/`: requires HTTP 404.
  - `--expect-redirect /iclr-2026/lineage.html=/iclr-2026/lineage/`: 301 with `redirect:"manual"`.
  - `_headers` check: response CSP header equals exactly `frame-ancestors 'self'`.
- `cf-deployment-id`: env `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_PROJECT`, `SOURCE_SHA`. Lists the project's production deployments **(verify endpoint/shape: `GET /accounts/{id}/pages/projects/{project}/deployments?env=production`)** and picks the newest with `deployment_trigger.metadata.commit_hash == SHA`. Prints the id and the per-deployment URL. Never prints the token.
- `cf-rollback`: **(verify endpoint: `POST …/deployments/{id}/rollback`)**. Returns the new deployment id.
- `gh-record`: env-driven `gh api`-equivalent fetch to create a Deployment and its success status (see §4.3, record stage).
- `no-skip-gate <vitest-json…>`: fails if any test is skipped, todo, or pending.
- Tests: an injected fetch for every network path; marker bytes compared to a fixture generated from the old Python one-liner; no real network.

### A5: apps/web for the P5 layout and production origin
- `copy-data.ts`: source is `layout.published`; head assets come from a new tracked folder `apps/web/static/assets/{favicon.svg,favicon-32.png,og-image.png}`, because `public/` is wiped on every build. A9 maps the `docs/assets` copies there.
- `packages/core/src/site/config.ts`:
  - `PUBLIC_ORIGIN` becomes the real project origin (**user input** from §10-1 and the custom-domain decision 3).
  - Add `PAGES_PROJECT_NAME` and `PAGES_PRODUCTION_BRANCH` (for example `production`).
- Tests: existing CSP, sitemap, redirects and copy-data tests, plus a contract test that workflow env constants equal these exports (A7).

### A6: apps/api production config
- `git mv apps/api/wrangler.jsonc apps/api/wrangler.preview.jsonc` (unchanged content; local use with `-c`).
- **New** `apps/api/wrangler.jsonc` (production):
  - `name: "paperpilot-themes"`, `main: "src/index.ts"`, the same `compatibility_date` and flags.
  - `vars`: `GH_OWNER`, `GH_REPO`, `GH_WORKFLOW_FILE: theme-on-demand.yml`, `GH_REF: develop`, `DISPATCH_MODE: live`.
  - `kv_namespaces: [{binding:"CONFIG_KV", id:"3e11d3e73dae42a8b94f06a9fa9de19f"}]`.
  - DO binding `QUOTA` → `QuotaCounter`, migration `v1` with `new_sqlite_classes`.
  - **No D1.** The `GH_DISPATCH_PAT` secret already exists on the Worker and persists.
- `apps/api/src/config.ts`: `PRODUCTION_ORIGINS = ["https://taichiiiiiiii.github.io", PUBLIC_ORIGIN]`, imported from core (resolves the `TODO(P5)`).
- **Rollback material:**
  - `worker/rollback-entry.ts` re-exports `worker/index.ts`'s default and adds a stub `export class QuotaCounter` that answers 503.
  - `wrangler.legacy-rollback.jsonc` keeps the old config, adds the `QUOTA` binding and the same migration `v1`, so it can go back onto a Worker that already has the DO class.
  - Inert, because Workers Builds only reads the configured file.
- Tests:
  - Parse both wrangler files (JSONC). Production has `DISPATCH_MODE=live`, `GH_REF=develop`, the production KV id and no `d1_databases`.
  - Preview has a different name, no production KV id, and `DISPATCH_MODE=dry-run`.
  - `checkDispatchMode` refuses dry-run for `PUBLIC_ORIGIN`.

### A7: Node workflows staged in `.github/workflows-p5/`, plus a composite action
- **Add** `.github/actions/setup-pnpm/action.yml`:
  - Pinned `actions/setup-node@49933ea…` with Node 22, `corepack enable`, `pnpm install --frozen-lockfile`.
  - Optional `cache-dependency-path: pnpm-lock.yaml`.
- **Add** the 12 workflow files from §4 under `.github/workflows-p5/` with their final names: `tests.yml`, `data-audit.yml`, `pages.yml`, `pages-release.yml`, `pages-rollback.yml`, `lighthouse.yml`, `collect-weekly.yml`, `collect-daily-watch.yml`, `regen-themes.yml`, `theme-on-demand.yml`, `conference-on-demand.yml`, `legacy-redirects.yml`.
- **Add** `apps/pipeline/test/workflows/*.test.ts`, parsed with the `yaml` dependency and pointed at `layout.workflowsDir`. Assertions:
  1. No `${{ inputs.* }}`, `${{ github.event.inputs.* }}`, `${{ secrets.* }}` or `${{ needs.*.outputs.* }}` inside any `run:` string; only `env:`.
  2. Every `uses:` is pinned to a 40-hex SHA (or the local composite action).
  3. Top-level `permissions: {}`, with per-job minimum permissions.
  4. `CLOUDFLARE_*` is referenced only in jobs with `environment: cloudflare-pages-deploy`, and those jobs have `if: github.ref == 'refs/heads/develop'`.
  5. No job sets `environment: cloudflare-pages-production`. That name is written only by the `record` job through the API (§4.3).
  6. `record` needs `smoke`.
  7. Every generate job has `persist-credentials: false` and `contents: read`.
  8. `pages.yml` `paths` ⊇ the `admit` diff path set.
  9. Concurrency group `paperpilot-pages-production` on `pages-release` and `pages-rollback`.
  10. No `python`, `uv`, `setup-python` or `.github/scripts/*.sh` anywhere.
  11. Env `CF_PAGES_PROJECT`, `CF_PAGES_PRODUCTION_BRANCH` and `PUBLIC_ORIGIN` equal the core constants.
  12. `legacy-redirects.yml` is dispatch-only with a confirm input.
  13. Theme and slug regexes equal `apps/api` `THEME_INPUT_PATTERN` and the core slug validator.
- This replaces `paperpilot/tests/test_ts_ci_workflow.py`.

### A8: GitHub Pages redirect site (§5)

### A9: data-move tool (§5)

### A10: `.gitignore`, config and `.env` changes, prepared as a patch applied by A9
`config.yaml` / `config.daily-watch.yaml` path keys and `.gitignore` rules. Details in §5.

### A11: timing measurement (offline)
- Time `pnpm install --offline`, refresh per kind, full `pnpm -r test`, `next build` and `validate bundle` on a CI-sized runner (or locally ×1.5).
- Set timeouts from the measured numbers:
  - promote `timeout-minutes` ≥ 3 × (install + refresh + validate) + git.
  - Today the promote jobs allow 20 or 30 minutes.
- If too slow: run Vitest in the promote validate step with `--project pipeline,core` plus the web build, keeping the full suite in release validate. Record the decision.

### A12: runbook document
`docs/migration/p5-runbook.md` holds §6 verbatim, filled with the real project name and origin. Design doc §7.4 links to it.

### A13 (optional, needs approval, rides in Merge A): paused message on the old site
`docs/assets/theme.js` maps `status:"paused"` (HTTP 503) to 「現在受付を一時停止しています」 plus the Issue link. Run `sync_asset_versions.py` and the viewer `.mjs` tests. Without it, the old form shows the generic 503 text during the pause window.

---

## 3. Promoter wiring (Q1)

**Principle.** The shell does `cd "$tree" && uv run …`, so refresh and validate run the *fresh tip's* code and tests. The TS hooks must do the same: spawn the tree's own CLIs with `cwd=tree` after `pnpm install --frozen-lockfile --offline` inside the worktree. The job's earlier install has already filled the store; `node_modules` is gitignored, so it is not "untracked". In-process calls from the job checkout would run possibly stale code against a newer tree.

**Refresh order.** Each row is `pnpm --filter @paperpilot/pipeline exec tsx <file>` with cwd = tree; default paths come from layout.

| # | `themes` | `conference` | Shell equivalent |
|---|---|---|---|
| 0 | `pnpm install --frozen-lockfile --offline` | same | (`uv run --frozen` creates the env) |
| 1 | `src/lineage/theme/generateThemesManifestCli.ts` | `src/catalog/buildPagesCli.ts` (all conferences, rewrites `conferences.json`) | `generate_themes_manifest` / `build_pages.py` |
| 2 | `src/lineage/theme/computeThemeQualityCli.ts` | `src/release/derived/identityLiteCli.ts --as-of $AS_OF` | `compute_theme_quality` / `build_identity_lite` |
| 3 | `src/lineage/quality/buildLineageQualityCli.ts --as-of $AS_OF` | `src/release/derived/searchIndexCli.ts` (v2 + id blocks, no v1) | `build_lineage_quality` / `build_search_index` |
| 4 | dropped: `sync_asset_versions` (Next content-hashes `_next/static`; no `versions.json`) | `buildLineageQualityCli.ts --as-of $AS_OF` | |
| 5 | dropped: `build_sitemap` (`apps/web/scripts/sitemap.ts` postbuild in validate step 8, gated on the rebuilt `lineage-quality-v1.json`) | dropped: `sync_asset_versions`, `build_sitemap` | |

`test-only` stays a no-op for both hooks.

**`SHARED_PATHS` (p5).** Built from layout; the legacy values stay as they are today until the flip.
- themes: `data/published/themes/themes-manifest.json`, `data/published/themes/_quality.json`, `data/published/lineage-quality-v1.json`.
- conference: `data/published/{conferences.json, identity-aliases-v1.json, lineage-quality-v1.json, paper-details-v1, search-index-v2.json, search-paper-ids-v1}`, `data/state/identity-coverage-v1.json`.
- Removed: `assets/versions.json`, `sitemap.xml`, `search-index.json`. Follow-up #5: generating and referencing v1 both stop in commit B; `searchIndex.ts` and `--check` drop v1 under p5 mode.

**Validate (both kinds, cwd = tree, in order).** The shell ran ruff, full pytest, `audit_theme_seeds` and `audit_lineage_quality`.
1. `pnpm exec biome check .`
2. `pnpm -r test` (reporter json → `no-skip-gate`; the shell promoter did not enforce no-skip, the release did. Keep that split unless A11 shows time to spare.)
3. `tsx src/lineage/theme/auditThemeSeedsCli.ts`
4. `tsx src/lineage/quality/auditLineageQualityCli.ts`
5. `tsx src/release/derived/searchIndexCli.ts --check` (new, cheap)
6. `pnpm --filter @paperpilot/web build`. New: this proves the promoted data builds (`generateStaticParams` over a new conference, CSP hashing, redirects, sitemap).
7. `tsx src/release/cli.ts validate bundle apps/web/out`

`typecheck` is optional, depending on A11. Build outputs (`out/`, `public/`, `.next`) are gitignored, so the existing "untracked outside allowlist" check is unaffected.

**How apps/web is built in release.** The promote build is only a gate; Next build IDs are random, so its bytes are never shipped. The release `build` stage rebuilds once from the exact SHA, hashes CSP from that output, writes the marker and uploads exactly that folder. `deploy` uploads the same artifact, and `smoke` byte-compares against it (§4.4-2 and §4.4-5).

---

## 4. Node workflows (Q2)

Common to every workflow:
- `permissions: {}` at the top; jobs get the minimum.
- Pinned SHAs as today (`checkout@11d5960…`, `upload-artifact@ea165f8…`, `download-artifact@d3f86a1…`), plus `./.github/actions/setup-pnpm`.
- Every dispatch input reaches the shell only through `env:`, checked with whole-string `[[ =~ ]]` and explicit `\n`/`\r` rejection.
- `run:` calls `pnpm exec tsx apps/pipeline/src/...`.

### 4.1 Per-workflow specification (files staged in `.github/workflows-p5/`, moved into place by B)

| Workflow | Triggers | Permissions / secrets / concurrency | Steps (P5) |
|---|---|---|---|
| `tests.yml` (**keep the file name and job id `test`**, which branch protection may require; the user confirms) | PR, push to `develop`/`main`, dispatch | `contents: read`; group `tests-${{ github.ref }}`, cancel-in-progress | setup-pnpm → `biome check .` → `pnpm -r typecheck` → `pnpm -r test` (skip → `::warning`, as today) → web build → `validate bundle apps/web/out`. Absorbs `ts-ci.yml` (deleted in B). In C, add `git ls-files '*.py'` must be 0 (excluding `.codex/` if kept) |
| `data-audit.yml` | push `develop`/`main` and PR, paths `data/published/themes/*/lineage.json`, `data/published/themes/themes-manifest.json`, `data/published/*/lineage.json`, `apps/pipeline/src/lineage/**`, the workflow itself; dispatch | `contents: read` (drops the unused `pull-requests: write`) | Two `continue-on-error` audit steps (`auditThemeSeedsCli`, `auditLineageQualityCli`) piped through `tee`, the same `GITHUB_STEP_SUMMARY` block, a final fail step |
| `pages.yml` | push `develop`, paths `data/published/**`, `apps/web/**`, `packages/core/**`, `schemas/**`, `pnpm-lock.yaml`, `package.json`, `apps/pipeline/src/release/**`, `.github/workflows/pages*.yml`, `.github/actions/**` | job: `contents: read`, `deployments: write` | `uses: ./.github/workflows/pages-release.yml` with `source_sha: github.sha`, `release_kind: normal`, `request_id: push-<run_id>-<attempt>` |
| `pages-release.yml` (reusable) | `workflow_call` with `source_sha`, `release_kind` (`normal` only), `request_id` | group `paperpilot-pages-production`, `cancel-in-progress: false` (re-check whether the existing `queue: max` key is real before carrying it over **(verify)**) | 6 stages + record, see §4.3 |
| `pages-rollback.yml` | dispatch `target_sha`, `confirm` (`ROLLBACK`) | same group; `validate_target`: `contents: read`, `deployments: read`; `rollback`: environment `cloudflare-pages-deploy`; `record`: `deployments: write` | §4.4 |
| `lighthouse.yml` | PR paths `apps/web/**`, `packages/core/**`, `.lighthouserc.json`, the workflow; schedule `0 2 * * 1`; dispatch | `contents: read`, `pull-requests: write` | setup-pnpm → web build → treosh action (pinned SHA). `.lighthouserc.json`: `staticDistDir: ./apps/web/out`; URLs `/`, `/iclr-2026/`, `/iclr-2026/lineage/`, `/themes/` (**verify** that the lhci static server resolves directory index) |
| `collect-weekly.yml` | dispatch `allow_shrink_for` | generate: `contents: read`; promote: `contents: write`; release job: `contents: read`, `deployments: write`. Secrets as today (`S2_API_KEY`, `OPENALEX_EMAIL`, `GEMINI_API_KEY`, `CLAUDE_API_KEY`, `GROQ_API_KEY`, `github.token`) | See below |
| `collect-daily-watch.yml` | dispatch | group `collect-daily-watch` (unchanged); `contents: write`; `SLACK_WEBHOOK_URL`, `GH_PAT` / `github.token`, `OPENALEX_EMAIL` | Pinned checkout → setup-pnpm → `collect/cli.ts --config data/config/config.daily-watch.yaml --fail-on-errors` → `if: !cancelled()` `release/cli.ts commit-push "$MSG" data/inputs/daily data/state/seen_ids.daily.json data/state/run_history.daily.jsonl` → failure Slack curl with URL and run link via env |
| `regen-themes.yml` | dispatch `themes` | as weekly; `PAPERPILOT_GROQ_API_KEY`, `PAPERPILOT_S2_API_KEY` | Newline guard; jq over `data/published/themes/*/lineage.json` `.meta.theme`; regex per entry; `lineage/theme/cli.ts … --llm-strict ambiguous --primary-source openalex`; refresh (`generateThemesManifestCli`, `computeThemeQualityCli`); upload `data/published/themes` and `data/state/lineage-cache/classifications.json`; promote `themes` with those two allowed paths; release. The unarXive download step is removed (decision: no DuckDB) |
| `theme-on-demand.yml` | dispatch `theme`, `request_id`; **no concurrency group** (kept, #125) | as above | Validate (`^[A-Za-z0-9 _-]{2,80}$`, `^[A-Za-z0-9._:-]{1,128}$`) → checkout develop → `lineage/theme/cli.ts --theme "$THEME_INPUT" --depth 1 --seeds 5 --width 8 --since-year 2018 --llm-strict ambiguous --primary-source openalex --auto-expand` → `slugCli.ts` gives `primary_path=data/published/themes/$slug`, checked against `^data/published/themes/[a-z0-9-]{1,64}$` and the file existing → `release/cli.ts package` (`PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED=1`) → upload → promote `themes … "$PRIMARY_PATH"` (path re-validated) → release with `request_id` |
| `conference-on-demand.yml` | dispatch `conference`, `venue`, `query`, `display`, `lede`, `max`, `allow_shrink_for` | as above; no LLM secrets | Validate slug `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$`; reserved list = core `RESERVED_CONFERENCE_SLUGS` (adds `lineage`; keeps `cvpr-2026`, `daily`; contract-tested); venue and max as today → `conference/arxiv/cli.ts` (`--output-root data/inputs`) → `buildSummaryCli --conference` → `buildPagesCli [--allow-shrink-for …]` (all) → `scaffold/cli.ts` (env `DISPLAY`/`LEDE`) → upload `data/published/$CONF`, `data/inputs/$CONF`, `data/config/conference-copy/$CONF.json` → promote `conference` with those three → release |
| `legacy-redirects.yml` | **dispatch only** with `confirm` (`REDIRECT`) until runbook step 10; optionally push paths `legacy/redirect/**` afterwards | `contents: read`, `pages: write`, `id-token: write`; environment `github-pages`; group `paperpilot-legacy-pages` | §5.4 |

**Weekly detail.**
- Collector: `collect/cli.ts --config data/config/config.yaml --fail-on-errors`.
- Shrink loop: same bash, iterating `data/inputs/*/` (skip `daily`) with `buildSummaryCli` and `buildPagesCli --conference`.
- Lineage loop: `data/published/*/papers.json` → jq oral count → `buildLineageCli --conference`. The inline Python node/edge check is replaced with `jq -e '(.nodes|type=="array" and length>0) and (.edges|type=="array" and length>0)'`. Same backup/restore and summary table.
- Package includes: `data/inputs`, `data/state/seen_ids.json`, `data/state/run_history.jsonl`, `data/state/lineage-cache/classifications.json`, `data/published/*/papers.json`, `data/published/*/lineage.json`. `paper-links.html` is dropped.
- On failure, the `run_history` artifact path is `data/state/run_history.jsonl`.
- The promote allowed list is built with `find "$CANDIDATE_DIR/data/published" -mindepth 2 -maxdepth 2 -name papers.json|lineage.json`.

**Deleted in B:** `ts-ci.yml`, `publish.yml` (it triggers on PR `paperpilot/**` and its wheel check needs `paperpilot/data/*.json`, which moves), `paper-slides-on-demand.yml` (decision: delete). The old Python workflows are replaced in place under the same names, so "disabled" state and history carry over.

### 4.2 GitHub environments (user)
- `cloudflare-pages-deploy`: deployment branch policy = `develop` only. Secrets `CLOUDFLARE_API_TOKEN` (Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`. Used only by the `deploy` and `rollback` jobs.
- `cloudflare-pages-production`: no secrets, no job uses it. It is the **known-good ledger**, written only by `record` through the REST API.
- **Why two names:** a job with `environment:` auto-creates a GitHub Deployment and marks it success when the job ends, which is before smoke. That reproduces the weakness §4.3 says to remove.
- `github-pages`: kept, used only by `legacy-redirects.yml`.

### 4.3 `pages-release.yml`: the six stages plus record

| Stage | Job details |
|---|---|
| **validate** (`contents: read`, about 20–30 min per A11) | Env checks: SHA `^[0-9a-f]{40}$`, `release_kind == normal`, request_id regex → checkout exact SHA (`persist-credentials: false`), `rev-parse HEAD` == SHA → setup-pnpm → `biome check .` → `pnpm -r typecheck` → `pnpm -r test` with json reporters → `release/cli.ts no-skip-gate` (fails on any skip, as today) → `auditThemeSeedsCli`, `auditLineageQualityCli`, `searchIndexCli --check` |
| **build** (`contents: read`) | Checkout exact SHA → setup-pnpm → `pnpm --filter @paperpilot/web build` (prebuild copies `data/published` → `public/`; postbuild strip-nojs, csp-hash, redirects, sitemap) → `release/cli.ts marker apps/web/out` → `validate local $SHA apps/web/out` (p5 required list incl. marker) → `sha256sum` manifest of `out/` → `upload-artifact` `cf-pages-$SHA` (exact bytes, retention 14). Outputs `artifact_name` |
| **admit** (`contents: read`, `fetch-depth: 0`) | rollback never comes here. `merge-base --is-ancestor $SHA origin/develop` → `git diff --quiet $SHA $tip -- data/published apps/web packages/core schemas pnpm-lock.yaml package.json` → `deployable=true/false`. **This set must be ⊆ `pages.yml` paths** (contract test), or a skipped stale release is never superseded |
| **deploy** (environment `cloudflare-pages-deploy`, `if: deployable && github.ref == 'refs/heads/develop'`, `contents: read`) | Download artifact → assert marker `source_sha == SHA` → `npx --yes wrangler@<exact pinned 4.x> pages deploy <dir> --project-name="$CF_PAGES_PROJECT" --branch="$CF_PAGES_PRODUCTION_BRANCH" --commit-hash="$SHA" --commit-dirty=false` (token and account via env `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) → `release/cli.ts cf-deployment-id` gives `cf_deployment_id` and `deployment_url` (filtered on commit_hash, never scraped from wrangler stdout) |
| **smoke** (`contents: read`, no secrets) | Download artifact → `release/cli.ts validate smoke "$PUBLIC_ORIGIN" "$SHA" --wait-marker 300 --expect-bytes <dir> --expect-404 … --expect-redirect …`. Optionally also smoke `deployment_url` first, which cannot be affected by alias lag |
| **record** (`deployments: write`, `needs: [deploy, smoke]`) | Through `gh api` with env only: `POST /repos/$REPO/deployments` with `ref=$SHA`, `environment=cloudflare-pages-production`, `auto_merge=false`, `required_contexts=[]`, `production_environment=true`, `payload={source_sha, cf_deployment_id, release_kind, request_id, artifact_name}`; then `POST …/statuses` with `state=success`, `environment_url=$PUBLIC_ORIGIN`. The cf id is regex-checked (**verify the id format**, likely a UUID) |
| concurrency | Workflow-level group `paperpilot-pages-production` (verify that it is honoured in a called workflow; today's file relies on that too) |

If smoke fails, a bad deploy stays live with no record, exactly as today. The runbook says the operator immediately runs `pages-rollback` to the last recorded known-good SHA. Automatic rollback is not added.

Callers (`pages.yml` and the four generation workflows) grant `contents: read` and `deployments: write`. `pages: write` and `id-token: write` are removed. Environment secrets are read inside the called job; nothing is passed through `secrets:`.

### 4.4 `pages-rollback.yml`
1. **validate_target:** `confirm == ROLLBACK`; SHA regex; `cat-file -e`; ancestor of `origin/develop`; `gh api deployments?environment=cloudflare-pages-production&ref=$SHA` → newest whose latest status is `success` → payload `source_sha == SHA` and `cf_deployment_id` regex → output. Only SHAs released to Cloudflare after P5 can be rolled back; old `github-pages` records are rejected.
2. **rollback** (environment `cloudflare-pages-deploy`, develop-only `if`): `release/cli.ts cf-rollback` (verify endpoint).
3. **smoke:** marker == target SHA plus 404, redirect and header checks. No byte compare, because no artifact exists.
4. **record:** new deployment with `release_kind: rollback` and the new cf id.

No rebuild anywhere, per §4.3. Data and branches are not rolled back.

---

## 5. The data-move commit (Q3), the tool, and the redirect site

### 5.1 Mapping table (every tracked path → exactly one destination)

| Old (tracked) | New | Class |
|---|---|---|
| `docs/conferences.json`, `identity-aliases-v1.json`, `lineage-quality-v1.json`, `search-index-v2.json`, `lineage-pilot-index-v1.json` (now static, no generator) | `data/published/<same>` | move (R100) |
| `docs/paper-details-v1/**` (256), `docs/search-paper-ids-v1/**` (111) | `data/published/…` | move |
| `docs/<conf>/papers.json`, `docs/<conf>/lineage.json` (10 conferences, empty stubs kept per §9.3) | `data/published/<conf>/…` | move |
| `docs/iclr-2026/deep-*.json` (14), `deep-manifest.json` | `data/published/iclr-2026/…` | move |
| `docs/themes/*/lineage.json` (3), `themes-manifest.json`, `_quality.json` | `data/published/themes/…` | move |
| `docs/search-index.json` (v1) | none | **delete** (follow-up #5, §9.3) |
| `docs/daily/papers.json` | none | **delete, needs user confirmation** (§9.3 explicitly) |
| `docs/assets/{favicon.svg,favicon-32.png,og-image.png}` | `apps/web/static/assets/…` | move |
| `docs/assets/*.js`, `*.css` (17), `docs/assets/versions.json`, `docs/index.html`, `404.html`, `sitemap.xml`, `how-it-works/index.html`, `lineage/index.html`, `themes/index.html`, `docs/<conf>/{index.html,paper-links.html,lineage.html,deep.html}` | `legacy/gh-pages-site/…` (frozen; source for the redirect list; deleted in C) | move |
| `docs/design/**`, `docs/research/**`, `docs/migration/**`, `docs/QWEN_IMPLEMENTER.md` | unchanged (no longer published) | stay |
| `paperpilot/data/{seen_ids.json, seen_ids.daily.json, run_history.jsonl, identity-coverage-v1.json}` | `data/state/…` | move |
| `paperpilot/data/lineage-cache/**` (467: `classifications.json` plus S2 citations/references caches) | `data/state/lineage-cache/**` | move |
| `paperpilot/data/{conference-sources-v1.yaml, lineage_denylist.json, lineage_foundational_allowlist.json, lineage-audit-fixtures-v1.json, lineage-quality-policy-v1.json, paper_repos.json, theme_aliases.json, theme_blacklist.json}` | `data/config/…` | move |
| `paperpilot/data/sol-abstract-local-v1.json`, `paperpilot/data/.gitkeep`, `paperpilot/output/.gitkeep` | unchanged | stay (Python-only, deleted in C) |
| `paperpilot/output/<conf>/**` (10 conferences, 3–4 files each), `paperpilot/output/daily/**` (11 incl. `.gitkeep`), `paperpilot/output/papers_2026-05-2{4,5}.{csv,json}` | `data/inputs/…` | move |
| `paperpilot/config.yaml`, `paperpilot/config.daily-watch.yaml` | `data/config/…` | **move + edit** |
| `paperpilot/.env.example` | `data/config/.env.example` | move |

The edits allowed on the two config files are restricted to these keys:
- `output.*.dir` → `data/inputs` / `data/inputs/daily`.
- `incremental.seen_ids_file` → `data/state/…`.
- `incremental.run_history_file` → `data/state/run_history.daily.jsonl`.
- `logging.file` → `logs/…` (gitignored).

`.env` is now looked up in `data/config/` by `loadConfig`. `.env*` is already globally gitignored.

**Code and other files changed in the same commit B (all prepared in A, flipped mechanically):**
- `packages/core/src/layout` `LAYOUT_MODE = "p5"`. **This single flip is also what retires `searchIndex` v1** (follow-up #5) — `writeSearchIndexes`/`checkSearchIndexes` (`apps/pipeline/src/release/derived/searchIndex.ts`) take `mode: LayoutMode = LAYOUT_MODE`, and every caller (`searchIndexCli.ts`, `promoteHooks.ts`'s refresh/validate command tables, `promote.ts`'s `SHARED_PATHS`, `validateRelease.ts`'s `DEFAULT_REQUIRED_ARTIFACTS`) uses that default rather than hard-coding a mode. Under `"p5"` neither function touches `search-index.json` at all. **No separate edit to any of those files is needed in B** — confirmed by reading each call site (none passes an explicit `mode` argument); B's `dataMove` tool output (the layout flip plus the rule-table moves/deletes) is sufficient on its own. This was previously listed as its own bullet ("searchIndex v1 generation and check removed"), which read as if B needed a second, hand-written code edit beyond the layout flip; it doesn't, and `dataMove verify`'s enumerated allowlist (§5.2) is written on that basis — it does not and must not allow an edit to `searchIndex.ts` itself.
- `git mv .github/workflows-p5/*` → `.github/workflows/` (overwrite); delete `ts-ci.yml`, `publish.yml`, `paper-slides-on-demand.yml`.
- `.lighthouserc.json`.
- `.gitignore`:
  - `paperpilot/data/lineage-cache/*` → `data/state/lineage-cache/*` with `!data/state/lineage-cache/classifications.json`. The 466 already-tracked cache files remain tracked after `git mv`, as today.
  - `paperpilot/data/unarxive/` → `data/state/unarxive/`.
  - Add `logs/`.
- `apps/web/.gitignore` comment.

**How packages/core switches.** Every reader resolves through `layoutFor(getRepoRoot())`. `getRepoRoot()` already walks up to `schemas/`, which does not move. Commit B changes exactly one literal plus the tests' expected mode. The A0 grep contract test guarantees there is no other path literal left.

### 5.2 Data-move tool (A9): `apps/pipeline/src/release/dataMove/{rules.ts,cli.ts}`
- `rules.ts`: the table above as ordered rules: prefix or glob → `{move: dest} | stay | delete | moveEdit: {dest, allowedKeys}`.
- `cli.ts plan`: runs `git ls-files` and maps every path. Exit 1 on any unmapped path, any two sources mapping to one destination, or a destination that already exists.
- `cli.ts apply [--confirm-delete <path>] [--allow-missing-workflows]`:
  - `git mv` per rule, `git rm` for deletes.
  - Applies the A10 patch to the config files and `.gitignore`, flips `LAYOUT_MODE`, moves the staged workflows.
  - Refuses the *entire* call, before touching anything, if `.github/workflows-p5` is missing or empty — never a silent skip — unless `--allow-missing-workflows` is passed (review finding L8).
- `cli.ts apply --reverse --before <sha> [--allow-missing-workflows]`:
  - `--before <sha>` is **required** — no implicit `HEAD^` default (review finding M3). Before touching anything, asserts (the same proof `verify` performs) that `HEAD`'s tree is *exactly* `<sha>`'s forward-`apply` result; refuses, untouched, otherwise. This only ever reconstructs the exact tree the forward `apply` on `<sha>` produced — it is not, and must not be used as, a general "undo however much history has piled up since" tool. See §6.2 R-B for when this applies vs. `carry-back`.
- `cli.ts carry-back --since <sha>`:
  - The R-B step 4 case `apply --reverse` cannot cover on its own: every path changed in `<sha>..HEAD` under `data/` (add, modify, or delete) is mapped back onto its legacy path via the reverse of the rule table and replayed there (`git add`/`git rm --ignore-unmatch`). Refuses the whole call, untouched, if any changed path has no legacy-path equivalent (for example a p5-only `data/config/conference-copy/<slug>.json`). Never touches `LAYOUT_MODE`, `.gitignore`/`.lighthouserc.json`, or the workflow directories — that structural half is `apply --reverse`'s or a plain `git revert`'s job (§6.2 R-B).
- `cli.ts verify <before> <after> [--allow-missing-workflows]`:
  - `git ls-tree -r` both commits.
  - For every move rule, the blob SHA *and file mode* at the old path in `<before>` equal the blob SHA and mode at the new path in `<after>` (review finding L2 — a chmod-only change is not byte-identical).
  - For `moveEdit`, the line diff is limited to the allowed keys.
  - Counts: N_before(docs+paperpilot/data+paperpilot/output) = N_moved + N_moveEdit + N_stay + N_deleted, with deletes equal to the enumerated list.
  - `git diff -M100% --name-status <before> <after>` contains only R100 for moves, the enumerated D, R+M for moveEdit, and M/A/D on code/workflow paths from an allowlist.
  - `<before>` having no files under `.github/workflows-p5` is itself a problem by default, mirroring `apply`'s L8 gate, unless `--allow-missing-workflows` is passed.
  - Writes a JSON manifest (path, blob SHA, class) to stdout for the PR description.
- Tests:
  - The rule table covers today's `git ls-files` (run in CI on feat): no orphans, no collisions.
  - apply → verify → `apply --reverse --before <sha>` on a temp clone gives a byte-identical tree.
  - A tampered blob, a chmod-only change, an untracked extra change, and a tampered workflow-swap destination all fail verify.
  - `apply --reverse` refuses cleanly (no partial mutation) when `HEAD` has a post-`<sha>` commit under `data/**`, or when the cutover commit was already `git revert`ed first (review probes P4, P5).
  - `carry-back` carries a brand-new post-B file, a modification of a pre-existing one, and a deletion; refuses on an unmappable path.

**Format-only proof (§7.2), a pre-cutover checkpoint.** On a develop snapshot in a temp dir:
1. `apply`.
2. Run the TS refresh tables for both kinds plus `generateThemesManifest`.
3. `parity/compare-trees` against the moved data. JSON is compared by content, and float formatting differences are allowed while values must match.
4. Must report zero content differences.

If there are formatting byte differences, commit them as a separate data-only commit **B′** right after B. That keeps B's blob-SHA proof clean and stops the first real promotion from carrying format noise.

### 5.3 Moving `data/` requires a fresh base
The commit is generated by `apply` **during the pause**, on the exact develop tip after confirming no generation runs are active. It is not pre-committed on feat, because feat must not touch data (§7.3). Rehearse with `apply` on a throwaway local branch from current develop, then run the full suite, web build, `validate bundle` and `verify`. Repeat as often as needed, offline.

### 5.4 GitHub Pages redirect site (Q5, changeset A8)
- **`legacy/redirect/redirect.js`** (hand-written, about 40 lines, ES5, no dependencies), exporting the mapping for tests through a UMD-style guard:
  - Strip the `/automatic-paper-search` prefix.
  - `/<conf>/{lineage,deep,paper-links}.html` → `/<conf>/{lineage,deep,paper-links}/`.
  - `/<conf>/index.html` and `/index.html` → directory form.
  - `/themes/index.html` → `/themes/`.
  - Anything else keeps its path.
  - Preserve `location.search` and `location.hash` verbatim.
  - Then `location.replace(NEW_ORIGIN + path + search + hash)`.
  - `NEW_ORIGIN` is injected at generation from core `PUBLIC_ORIGIN`.
- **Generator** `apps/web/scripts/legacy-redirects.ts`:
  - Walks `legacy/gh-pages-site/**/*.html` plus `404.html` and writes `legacy-out/<same path>`.
  - Each page has `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">`, `<link rel="canonical" href="<mapped new URL>">`, `<meta name="robots" content="noindex">`, `<meta http-equiv="refresh" content="0; url=<mapped URL>">` as the no-JS fallback (query/hash cannot be kept there, which is acceptable), `<script src="/automatic-paper-search/redirect.js">`, and a visible link.
  - `404.html` is the catch-all.
  - No `sitemap.xml`. Add a `.nojekyll`.
- **Workflow** `legacy-redirects.yml`: checkout → setup-pnpm → generator → `actions/upload-pages-artifact` (pinned) → `actions/deploy-pages` (pinned), environment `github-pages`. Node only, so it survives C.
- **Tests:**
  - Table-driven Vitest loading `redirect.js` in jsdom: `?q=`, `?theme=`, `#…`, encoded characters, the `lineage.html` cases, unknown paths, a bare prefix.
  - The generator emits a page for every legacy HTML.
  - No inline script; canonical == mapped URL.
- **Residual risk to record:** clients reading `…github.io/automatic-paper-search/*.json` directly cannot be redirected. User registers the new sitemap in Search Console.

---

## 6. Worker cutover (Q4) and the detailed §7.4 runbook (Q6)

### 6.1 KV values (production namespace `3e11d3e73dae42a8b94f06a9fa9de19f`)
Write with `wrangler kv key put --namespace-id=3e11… <key> <value> --remote`. **Verify:** wrangler 4 may default `kv` commands to local storage, so pass `--remote`. Never add preview or `<hash>.<project>.pages.dev` origins.

| Key | Phase W | Cutover step 1 | Cutover step 4 | After step 8 | After observation |
|---|---|---|---|---|---|
| `accepting` | `"true"` | `"false"` | `"false"` | `"true"` | `"true"` |
| `origin_allowlist` | `["https://taichiiiiiiii.github.io"]` | same | `+ "<PUBLIC_ORIGIN>"` | same | `["<PUBLIC_ORIGIN>"]` (drop GitHub Pages once the redirect is live) |
| `namespace_tag` | `"paperpilot-themes-production"` | | | | |

### 6.2 Runbook

Format: ☐ marks user or approval. ✔ is the checkpoint. ↩ is the rollback for that step.

**P0: prerequisites (user, no deploy)**
1. ☐ Create the Cloudflare Pages project (Direct Upload) and decide the production branch name (§10-1). Decide on a custom domain (decision 3). Report the exact origin, which goes into A5.
2. ☐ Create the Pages token. Create GitHub environments `cloudflare-pages-deploy` (develop-only, secrets) and `cloudflare-pages-production` (no secrets).
3. ☐ Workers Builds for `paperpilot-themes`:
   - Record the current root directory, build command, deploy command and Node version.
   - **Check what happens once a root `package.json`/`pnpm-lock.yaml` exist (R1).** Pin `NODE_VERSION=22` and an explicit deploy command.
   - Confirm builds for non-production branches are off (§10-4).
4. ☐ Confirm the branch-protection required checks on develop (names). Decide on `.codex/` and the Codex/Qwen docs (decision 8). Confirm deleting `docs/daily/papers.json`.
5. ☐ Pages project settings: no Web Analytics auto-inject. With a custom domain, Rocket Loader and email obfuscation off for that zone.

**P1: feat (offline).** Changesets A0–A12, each with `/code-review` (high for A3/A4/A6/A7/A9). Then:
- `pnpm -r test`, `typecheck`, `biome`, web build, `validate bundle`.
- `dataMove plan` with no orphans.
- Rehearsal `apply` → full suite → `verify`.
- Format-only parity proof.
- A11 timings.

✔ Everything green, and the plan output is attached to the PR.

**P2: rehearsal (☐ approval, user's local wrangler only).**
1. Build `apps/web` from feat with `apply` on a develop snapshot, write the marker.
2. `wrangler pages deploy apps/web/out --project-name=<p> --branch=rehearsal` (a non-production branch gives a preview URL; Cloudflare Access is optional).
3. `release/cli.ts validate smoke https://rehearsal.<p>.pages.dev <sha> --expect-bytes … --expect-404 … --expect-redirect …`.
4. Manual browser pass over every page type, checking for no CSP console errors. The theme form shows 403 or degraded because the preview origin is not allowlisted, which is expected.

✔ Smoke passes. ↩ Delete the preview deployment in the dashboard.

**P3: Merge A (☐ approval).** PR feat → develop, using a **merge commit**. ✔
- Python `tests.yml` green.
- `pages.yml` (Python) re-releases GitHub Pages because `docs/design` and `docs/migration` changed. Note that this publishes `docs/migration/*` on GitHub Pages until the redirect step, a minor exposure (R12).
- The Workers Builds log shows the old Worker redeployed.
- `curl -X POST` with `Origin: https://taichiiiiiiii.github.io` and an existing theme returns `status: exists`, with no dispatch.

↩ `git revert -m 1 <mergeA>`. Nothing else changed.

**Phase W: switch the Worker to apps/api (☐ each step).**
- **W1.** Write KV `accepting=true`, `origin_allowlist=["https://taichiiiiiiii.github.io"]`, `namespace_tag`. Read them back with `wrangler kv key get --remote`.
- **W2.** Local `pnpm --filter @paperpilot/api exec wrangler deploy --dry-run --outdir <tmp>` with the production config. Also `wrangler deploy --dry-run -c wrangler.legacy-rollback.jsonc` to prove the fallback bundles.
- **W3.** Workers Builds root directory → `apps/api` (§10-7). Install/build command so the pnpm workspace resolves (**verify**; for example a build command of `cd ../.. && corepack enable && pnpm install --frozen-lockfile` and a deploy command of `npx wrangler deploy`). Then retry the latest build.

  **Alternative:** keep root `/` and point root `wrangler.jsonc` `main` at `apps/api/src/index.ts`. The config stays git-revertable, but it diverges from §10-7. Present this to the user if W3 install resolution fails.
- **W4.** ✔ Checks:
  - `GET /api/health` returns `{accepting:true, dispatch_mode:"live", pat_configured:true, kv_namespace_tag:"paperpilot-themes-production"}`.
  - OPTIONS with the GitHub Pages origin returns the exact ACAO and `Vary: Origin`.
  - An unknown origin gets 403.
  - POST of an existing theme returns `exists`.
- **W5.** ☐ One real new theme through the **old** site form returns `queued`. The Python `theme-on-demand` workflow runs and GitHub Pages is updated.
- **↩ W:**
  - Immediately set `accepting=false` (fail closed; wait 60 seconds or more).
  - Then either use Workers version rollback to a previous apps/api version, or redeploy the legacy Worker with `wrangler deploy -c wrangler.legacy-rollback.jsonc` (stub `QuotaCounter`, same migration `v1`).
  - Cloudflare blocks version rollback across DO migrations, and redeploying `worker/` without the class fails, so **do not** roll back to a pre-DO version of the plain `worker/` (**verify** both behaviours in current docs). Optionally set the root directory back to `/` afterwards.

**Merge B: the cutover**
1. ☐ KV `accepting=false`. ✔ `/api/health` shows `accepting:false`; wait at least 5 more minutes.
2. ☐ `gh workflow disable` for theme-on-demand, collect-weekly, collect-daily-watch, regen-themes, conference-on-demand. ✔ `gh run list --status in_progress` and `--status queued` both empty for all workflows (`set -euo pipefail` plus CAS keeps any in-flight promoter safe).
3. Create branch `p5/cutover` from the current `origin/develop` and run `dataMove apply` (+ B′ if needed). ✔ Offline:
   - `dataMove verify origin/develop HEAD` (manifest attached).
   - `pnpm -r test`, web build, `validate bundle`.
   - Workflow contract tests now targeting `.github/workflows`.
   - `/code-review high`.
4. ☐ KV `origin_allowlist` adds `<PUBLIC_ORIGIN>`.
5. ☐ Merge the PR into develop with a **merge commit** (keeps B revertable). ✔ Checks:
   - `pages.yml` (Node) runs validate → build → admit → deploy → smoke → record, all green.
   - A GitHub Deployment exists in `cloudflare-pages-production` with `cf_deployment_id`.
   - `tests.yml` (Node) and `data-audit.yml` green.
   - `/api/health` still shows `accepting:false` (never verified by a real POST).
6. ✔ Production checks:
   - Script over `out/sitemap.xml` URLs: all 200.
   - `/__missing__/` returns 404.
   - `/iclr-2026/lineage.html?x=1#y` returns 301 to `/iclr-2026/lineage/?x=1`, with the fragment kept by the browser.
   - The CSP header is only `frame-ancestors`; meta CSP on every page.
   - Manual browser pass with no CSP violations.
   - The theme form on the new site shows the paused message.
   - Preflight from `<PUBLIC_ORIGIN>` returns ACAO.
7. ☐ `gh workflow enable` for all five.
8. ☐ KV `accepting=true`.
9. ☐ One real request on the **new** site goes Node `theme-on-demand` → promote (tree's own code, web build gate) → release → Cloudflare. ✔ The theme is visible and recorded. If anything fails, set `accepting=false` and go to R-B.
10. ☐ Dispatch `legacy-redirects.yml` (confirm `REDIRECT`). ✔ Sample old URLs with `?q=`, `?theme=` and `#…` land correctly, and the 404 catch-all works. ☐ Search Console: submit the new sitemap.
11. Observation, about one week:
    - ☐ Approve at least one `collect-weekly` (or `regen-themes` for one theme) and one `collect-daily-watch`.
    - ✔ Each run: generate → promote → release → record, and `data/state` updates committed.
    - Then ☐ remove the GitHub Pages origin from the allowlist.
12. Tier C PR (☐ approval).

**↩ R-B (after Merge B, before C).** Rewritten (review finding M3): the
previous draft ran `git revert -m 1 <mergeB>` *before* `dataMove apply
--reverse`, and described the reverse step as if one `apply --reverse`
call could both undo B's own structural move *and* carry forward
whatever post-B `data/**` commits had landed since — the tool never
supported either. `apply --reverse`'s `--before <sha>` precondition is
"`HEAD` is *exactly* `<sha>`'s forward-`apply` result" (`verifyMove`'s own
check, enforced before anything is touched); a prior `git revert` already
breaks that precondition (probe P5 — `LAYOUT_MODE` is back to `"legacy"`
before `apply --reverse` even starts), and so does any ordinary post-B
commit under `data/**` (probe P4). Two genuinely different cases, in this
order:

1. `accepting=false`.
2. List data commits since B: `git log <mergeB>..origin/develop -- data/`.
3. **No data commits since B** (rollback is immediate — nothing in step 6 or
   later ran yet): `dataMove apply --reverse --before <mergeB>^` directly,
   then commit. Skip to step 7. Plain `git revert` is not used for the
   data/layout/workflow files at all — `apply --reverse` already produces
   the byte-identical pre-B tree on its own.
4. **Data commits exist since B** (the common case — R-B can run up to the
   §6.2 step 11 observation week later, by which point `collect-weekly`/
   `collect-daily-watch`/`regen-themes`/`conference-on-demand` have
   almost certainly run):
   a. `dataMove carry-back --since <mergeB>` **first, while `data/**` is
      still live** (it reads every changed path via `git show HEAD:…`; run
      it after a `git revert` and there is nothing left to read). This
      writes every post-B `data/**` add/modify/delete back onto its legacy
      path (`paperpilot/…`/`docs/…`) via the reverse rule table, and
      refuses the whole call — untouched — if any changed path has no
      legacy equivalent (for example a brand-new
      `data/config/conference-copy/<slug>.json`, which is p5-only and
      never existed under `paperpilot/data`; resolve that by hand before
      retrying). Commit this as its own commit.
   b. `git revert -m 1 <mergeB>` (B′ first if present) now undoes B's own
      structural diff — the original rule-table moves, the `LAYOUT_MODE`
      flip, the workflow swap, `.gitignore`/`.lighthouserc.json` — on top
      of (a)'s commit. **A conflict here is expected, not a bug**: if a
      *pre-existing* published/state file (one B itself moved, not a
      brand-new post-B one) was also modified after B, (a) already wrote
      today's content to its legacy path, and `git revert` separately
      tries to recreate that same path from B's own parent's (older)
      blob — resolve by keeping (a)'s content. Commit.
5. Pushing `docs/**` triggers the Python `pages.yml`, which re-releases the old site to GitHub Pages, overwriting the redirect site if step 10 ran.
6. Remove `<PUBLIC_ORIGIN>` from the allowlist.
7. The apps/api Worker stays (Phase W is independent); Durable Object counters need no action. The Cloudflare Pages project is left idle or its production deployment removed (☐).

Revert does **not** undo: Workers Builds settings, KV values, DO storage, Cloudflare Pages deployments, GitHub Deployment records, workflow enabled/disabled state. Each has its own line above.

**↩ after C:** revert C first, then R-B.

### 6.3 Tier C: deletion and docs (separate PR after observation)
- **Delete:**
  - `paperpilot/` (all tracked files: lineage review tools per decision, `paper_slides`, scripts, tests, `sol-abstract-local-v1.json`, `.gitkeep`s), `pyproject.toml`, `uv.lock` (`.venv` is local).
  - `Dockerfile`, `docker-compose.yml`, `docker/`, `containers/`, `.dockerignore`.
  - `tools/render_og_image.py` (the og-image png stays as a static asset; a TS regenerator is a follow-up).
  - `.github/scripts/` (four `.sh` files plus `paper_slide_workflow.py`).
  - `worker/` (including `paper-slide-*` and `setup.sh`), root `wrangler.jsonc` (if W3 used root-dir mode), `wrangler.legacy-rollback.jsonc`, `worker/rollback-entry.ts` (once the Worker rollback window has closed).
  - `legacy/gh-pages-site/` — only after its tests point at the A1 fixtures. The redirect generator's legacy path list must be frozen into `legacy/redirect/paths.json` first.
  - The 14 fixture-generator `.py` files under `apps/` and `packages/` (outputs stay; add a README noting their origin).
  - Python-only parts of `apps/pipeline/src/parity` if any (**verify** `run-command.ts` usage; keep `compare-trees`).
  - `.pre-commit-config.yaml` ruff/mypy hooks (or the whole file).
  - `.codex/`, `AGENTS.md`, `PAPERPILOT_PROFILE.md`, `docs/QWEN_IMPLEMENTER.md` **only if decision 8 says delete**. If kept, the completion check excludes `.codex/`.
  - Stale `docs/design` files (nine, consolidated).
- **Rewrite:**
  - CLAUDE.md: TS-only rules, the new 12-workflow trigger table, the `data/` layout, KV switch and `/api/health` ops, Cloudflare release and rollback; remove the uv/Docker/unarXive sections.
  - README.
  - Design doc 39 (status, progress).
  - `safety-contracts.md` (follow-ups #14 LLM-18 and #15 path column).
  - `.claude/agents/*` and `.claude/skills/*` (§7.5).
  - CHANGELOG.
- **Add** the CI guard in `tests.yml`: `git ls-files '*.py' ':!.codex'` must be 0.
- ✔ Done criterion: §8 P5.

---

## 7. P5-specific risks and how each is checked offline first

| # | Risk | Mitigation / offline check |
|---|---|---|
| R1 | Merging feat puts a root `package.json` and `pnpm-lock.yaml` on develop, so Workers Builds may attempt a pnpm workspace install with the wrong Node and fail to deploy the old Worker | P0-3 inspection; pin `NODE_VERSION`; check the build log in Merge A while the old Worker keeps serving (a failed build does not take down the live version) |
| R2 | Worker rollback across the DO migration | A6 stub-DO rollback config plus `--dry-run` in W2; primary rollback = KV pause |
| R3 | KV order mistakes (fail-closed pauses production) or writing to local KV | §6.1 table, `--remote`, read back before each push; `/api/health` after every change |
| R4 | Silent partial refresh (stale shared outputs) | A3 command-table test pinned to the shell order; hooks throw on any non-zero exit |
| R5 | Promoter runs stale job code against a newer tip | Hooks spawn with `cwd=tree` and the tree's own install (tested) |
| R6 | Promote timeouts (3 attempts × build and test) | A11 measurement; size timeouts; optional scoped Vitest in promote |
| R7 | GitHub Deployment marked good before smoke | Separate environment names; contract test 5–6 |
| R8 | Stale-skip never superseded | Contract test: admit diff set ⊆ `pages.yml` paths |
| R9 | Tests comparing live data to frozen expectations fail on legitimate updates inside promote | A1 classification; frozen fixtures |
| R10 | Data loss or duplication in the move | `dataMove plan/verify` (blob-SHA equality, counts, R100-only diff), `--reverse` round-trip test |
| R11 | Format-only churn hiding real changes at cutover | Parity compare-trees proof; separate B′ commit |
| R12 | `docs/migration` and `docs/design` published on GitHub Pages between Merge A and the redirect | Accept and record (already true for `docs/design` today), or move docs/migration earlier (user choice) |
| R13 | Alias propagation makes smoke flaky | `--wait-marker` poll; smoke the per-deployment URL too |
| R14 | Cloudflare auto-injection breaks CSP or byte equality | P0-5 settings; smoke byte compare |
| R15 | Pages token is account-wide and can push to production | Only in the develop-only environment; never on feat CI (contract test); residual risk recorded |
| R16 | Workers Builds preview builds from feat with production bindings and PAT after the root switch | P0-3 confirmation; recheck after W3 |
| R17 | Required-check names break merges | Keep `tests.yml` and job `test`; P0-4 |
| R18 | Concurrent conference-on-demand runs conflict on the copy manifest | One file per slug |
| R19 | `daily/papers.json` deletion was blocked before | Explicit user confirmation in P0-4 |
| R20 | Revert does not carry post-cutover state (`seen_ids` and so on) | `dataMove carry-back --since <B>`, run before `git revert` (R-B step 4a) |
| R21 | Uncertain Cloudflare/GitHub API shapes (deployment list, rollback endpoint, deployment id format, `wrangler kv` defaults, `queue:` key, reusable-workflow concurrency, Workers Builds monorepo install, lhci directory URLs) | Each is marked **verify**; A4 is coded against injected fetch, then exercised once in the P2 rehearsal (deployment list) before production |
| R22 | D1 expected by the design but not implemented | No binding in P5; recorded as a P3 gap / P6 item |

### Critical files for implementation
- /Users/taichi/work/paper/apps/pipeline/src/release/promote.ts (plus a new `promoteHooks.ts` and `cli.ts` changes)
- /Users/taichi/work/paper/apps/pipeline/src/release/validateRelease.ts (bundle mode, marker, smoke extensions, Cloudflare id and rollback, record)
- /Users/taichi/work/paper/packages/core/src/site/config.ts (with a new `packages/core/src/layout/index.ts`)
- /Users/taichi/work/paper/.github/scripts/promote-generated.sh and /Users/taichi/work/paper/.github/workflows/pages-release.yml (the behaviour to reproduce)
- /Users/taichi/work/paper/apps/api/wrangler.jsonc (split into production and preview) and /Users/taichi/work/paper/apps/web/scripts/copy-data.ts
