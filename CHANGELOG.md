# Changelog

All notable changes to PaperPilot are documented here. This project
follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added

- **Above-the-fold density for catalog and lineage pages (#370).** All ten
  conference pages move to the established compact-hero idiom (breadcrumb +
  title + a one-line mono stat strip + a "詳細" disclosure); the redundant
  first-timer guide is gone, and the first sentence of each lede stays
  visible as a tagline. On a 375×812 viewport the first paper card is now on
  screen (previously zero). Relation icons in the card Relations panel are
  now colour dots carrying the same `--rel-*` tokens as the lineage canvas —
  the first step of the visual-language unification, with hues untouched.
  Tag chips collapse to the top 8 plus a "+N タグ" expander that hands
  keyboard focus to the first revealed chip. Emoji chrome (🌳🗂️📅🏠🔍 and
  the relation icons) is replaced by text and tokens site-wide.

- **Site redesign phase 1 — cross-conference search, global nav, automatic
  asset versioning (#355).** The landing page gained a single search box that
  spans all 10 conferences: `paperpilot/scripts/build_search_index.py` folds
  every `docs/<conf>/papers.json` into `docs/search-index.json` (2,723,015 B
  raw / 759,264 B gzip / 28,300 entries). Entries are `[title, conference]`
  pairs and deliberately carry **no paper id** — `arxiv_id` is empty for
  95.5% of rows, so a `?focus=<id>` permalink would have been broken for the
  large majority; the existing `?q=` parameter is reused instead. A shared
  `<nav class="site-nav">` (探す / テーマ系譜 / 仕組み) now appears on all 17
  pages, and `paperpilot/scripts/sync_asset_versions.py` derives every `?v=`
  from the asset's content hash, with `docs/assets/versions.json` as the
  single source of truth and `--check` failing on divergence or on an
  unversioned reference. No pipeline or data-contract change: `papers.json`
  and `conferences.json` are untouched. Merged as `b01705b` and live.

- **Free-tier conference lineage — ECCV 2024 family tree (#347).**
  `paperpilot/scripts/build_conference_lineage.py` (260 lines, 117 lines of
  tests) resolves Oral titles through OpenAlex and walks
  references/citations to build `docs/<conf>/lineage.json` **without S2 and
  without an LLM** — the path for venues collected via
  OpenReview/CVF/ACL, whose papers carry no `arxiv_id` and therefore cannot
  go through `build_lineage.py`. Ships `docs/eccv-2024/lineage.{json,html}`
  as the first output. Edge relations come from a citation-direction
  successor heuristic, so this is a coverage tier below the LLM-classified
  lineages, not a replacement.

- **Scan-first catalog cards — judge relevance without opening a paper
  (#352).** Every card now shows the abstract as a two-line-clamped dek, the
  query is `<mark>`-highlighted in title and dek, the dek window is anchored
  to the first body match (word-boundary snap, aria-hidden leading "…") so a
  body-only hit is visible without expanding, and the active filter tag is
  highlighted on each card. Escape-then-match-then-wrap keeps the new
  innerHTML sink XSS-safe; links route through `safeHref()` (http(s) only).
  Assets: style.css v82→v83, app.js v81→v82.

- **Family-tree viewer "仕組み" explainer page (#324).**
  `docs/how-it-works/` — an editorial page that explains what the coloured
  lineage edges mean (the six relation types: supersedes / successor /
  extends / ablation / baseline / contrasts) as a specimen list using the
  viewer's actual `--rel-*` edge colours, plus an honest short "how it's
  classified" section. Linked from the landing hero caption.

### Changed

- **Periodic-maintenance audit: four documented safety nets that do not exist
  (#358, #360).** A sweep of README, CLAUDE.md and `docs/design/**` against the
  actual code and workflow files found several claims of automation with no
  implementation behind them. CLAUDE.md described a `develop` PR gate of
  "CI (test / ruff / mypy)" — **no workflow runs any of the three**, so a local
  `uv run pytest` / `ruff check` before merge is the only gate, and a merge to
  `develop` publishes straight to production through `pages.yml`.
  `data-audit.yml` last ran on 2026-06-15 and has not fired since: its path
  filter watches only `docs/iclr-*/lineage.json`, so the ECCV-2024 lineage
  added by #347 has never been audited (#358). `collect-weekly.yml` and
  `collect-daily-watch.yml` were documented as running every Saturday and
  every morning, but #245 removed their `schedule:` keys on 2026-06-04 — the
  catalog is frozen at `generated: 2026-06-28` and `lighthouse.yml` is now the
  only scheduled workflow. `docs/design/07-operations.md` §11 still prints a
  full `.github/workflows/collect.yml` with a daily cron for a file that does
  not exist. All four corrected in the docs.

- **Design book 01–07 flagged as stale (#360).** Those seven files are still
  the v2.1 (2026-04-05) text while the implementation moved on ~4.5 months; a
  measured audit found 33 divergences (16 high). Embedding is MiniLM, not
  SPECTER2; the LLM layer is a four-provider setup defaulting to ollama, not a
  required Claude API; there is no `social` signal (the real one is `follow`,
  at the highest weight 3.5); `stage2_top_n` is 30, not 80; `requirements.txt`
  holds five packages, not the numpy/torch/transformers/anthropic set the doc
  lists. `01-overview.md` is not an overview at all (it is a fragment of §5.6,
  and the real §1/§2 do not exist in the repo) and `04-data.md` is truncated
  mid-section. Content was left untouched — each file gained a staleness
  banner pointing at `09-implementation-status.md` as the single source of
  truth, pending a decision in #360 on whether to freeze, rewrite, or fold the
  design book into the status doc.

- **Paper-count discrepancy retracted.** The long-standing note that
  `conferences.json` (28,300) and `papers.json` (28,310) disagreed by ten was
  wrong: all ten conferences match exactly, and the difference was
  `docs/daily/papers.json`, a non-conference file that
  `build_pages.NON_CONFERENCE` already excludes. The `LLM`-tag figure in
  `10-site-redesign.md` was corrected the same way (28,300 / 10,099).

- **Docs compaction — CLAUDE.md / CHANGELOG.md split into archives
  (2026-08-18).** `CLAUDE.md` had grown to 920 lines / 72KB and is read by
  every agent session; `CHANGELOG.md`'s `[Unreleased]` had accumulated 20
  completed history subsections (686 of its 792 lines). Both are now split
  **losslessly** (md5 of the reconstruction matches the pre-split file):
  the CHANGELOG history moves verbatim to
  [`CHANGELOG-archive.md`](CHANGELOG-archive.md) and the implementation
  status chapter moves verbatim to
  [`docs/design/09-implementation-status.md`](docs/design/09-implementation-status.md),
  each leaving a pointer plus a re-measured current-state summary. No prose
  was rewritten or dropped.

- **Finer topic classification + mobile improvements (#349).** Expanded
  `TOPIC_RULES` in `build_summary_csv.py` (~60 regex categories, title +
  abstract match, multi-tag) and regenerated `summary.csv` for all 9
  collected venues. The viewer chips render only each venue's top-18 tags,
  so the larger taxonomy adapts per conference (CV venues surface CV tasks,
  NLP venues surface NLP tasks) without a viewer change.

- **Editorial polish for the result list (#353).** Oral papers get a gold
  left rail plus a warm tint so they read as curated rather than bordered;
  the results line echoes the active query in coral serif-italic (aria-hidden
  — the aria-live region announces only the count, not every keystroke);
  byline drops to `text-body-sm` with a tighter title→byline gap so the dek
  gets its own air; and a short staggered fade-up runs on first paint and
  "show more" only, disabled under `prefers-reduced-motion`. Assets:
  style.css v83→v85, app.js v82→v84.

- **CLAUDE.md gains a frontend (`docs/`) chapter (#351).** The guide was
  thorough on the Python pipeline and nearly silent on the static site where
  most catalog/UX work happens. Adds shared-asset architecture, the
  `summary.csv → papers.json/conferences.json` data flow, the conventions
  (unified asset cache-bust versions, TOPIC_RULES → top-18 chips, mobile and
  a11y rules), the headless screenshot harness (MCP playwright is
  unavailable — no X server), and the per-venue collect→build→scaffold flow
  with its gotchas. Also corrects the dev-tool commands to the actual
  `uv run …` convention.

- **Family-tree viewer frontend redesign (#325, #328–#332).** Editorial pass
  over the theme/conference/deep lineage viewers. Paper cards: polish +
  a11y (citation-heat no longer fights tier/hub/focus border colour, FOCUS
  badge moved to `::after` so it keeps the hover accent line, deep-view
  touch target, trending-pulse reduced-motion guard, emoji `aria-label`s),
  removed the broken deep-view CTA from theme cards (it pointed at the
  conference deep explorer which has no tree for theme papers, #328), and
  replaced the 👑/📈/🔗 status emoji with editorial mono tags HUB / TREND /
  孤立 (#329). Relationship lines: a backbone/branch hierarchy
  (successor/supersedes solid + full weight, extends/etc. thinner + fainter
  + finer dashes) so the descent trunk reads through dense graphs, shared
  across all three viewers via `PP.edgeStyle` in `utils.js` (#330, #331),
  and a fan-out of edge origins across each card's bottom edge via
  `PP.fanOffsets` so children don't all radiate from one point (#332). Hue
  is unchanged (the legend + 仕組み page describe the colours); only
  weight/dash/opacity/geometry move. Cache-bust to v=82.

- **#285 relation-classifier measurement (Gemini).** Measured the #296
  prompt rewrite via the `PAPERPILOT_LLM_PROVIDER=gemini` override (#311),
  NEW(#296) vs OLD prompt on the `supersedes` gold rows (gold set already
  expanded to 54 rows, #295): NEW recall **4/7, precision 1.00** vs OLD
  **0/7** — the rewrite demonstrably moves `supersedes` from 0 to 4 of 7
  (OLD mislabels 6/7 as `successor`). Confirms #296's value. Groq stays the
  production default (a valid key still hits the free-tier 429 cap during a
  full theme run → heuristic fallback, so rotating it has limited effect).
  Full 55-row macro-F1 + an #285 comment remain optional follow-ups. See
  `docs/design/08-lineage-roadmap.md` §判定品質の改善計画.

### Fixed

- **`Face` tag no longer fires on the English verb (#356).** Measured on the
  shipped 28,300-paper catalogue, the old rule tagged 1,322 papers of which
  60.6% were certain verb-only false positives ("methods face the challenge
  of…"). The replacement demands face-domain context: 371 papers remain,
  verb-only rate 1.3%, zero face-domain papers lost. `Recommendation` was
  tightened the same way (165 → 163). All ten conferences were re-tagged
  through the regular pipeline; the only field that changed anywhere is
  `tags` (1,560 papers, proven by full-record comparison).

- **`data-audit` can finally run green (#358).** The auditor now derives each
  conference's minimum focus-paper year from its directory name instead of
  the wall clock (`eccv-2024` no longer fails for containing 2024 papers),
  empty stub lineages report as SKIP instead of FAIL, and the workflow's
  path filter watches `docs/*/lineage.json` — the audit had not fired since
  2026-06-15 because it only watched `docs/iclr-*`.

- **Degenerate rationales are still shipping for ICLR 2026 (#359).** The #297
  guard is in `develop` (`_is_degenerate_rationale` in `build_lineage.py`), but
  it only rejects bad rationales at build time — the already-published
  `docs/iclr-2026/lineage.json` was never regenerated and still carries 45 of
  63 edges (71.4%) with rationales like `"A"`, `"QD"`, `"CMA-ES"`, visible to
  readers as edge tooltips. Every lineage generated after the guard measures
  0.0%, which confirms the diagnosis. Recorded, not fixed: regeneration needs
  an LLM key and `docs/<conf>/lineage.json` may only be written by its build
  script (absolute rules §13/§14). `audit_lineage_quality.py` had been warning
  about this the whole time — nobody saw it because `data-audit.yml` was
  dormant (#358).

- **The repository's only standing test failure is gone (#357).**
  `test_theme_typography_tokens` had failed for a long time and was waved
  through as "pre-existing" — first blamed on a node environment
  dependency, then on leftover work from the #257 token migration. Both
  diagnoses were wrong and the CSS was correct. The real cause was in the
  test's own helper: `extractSelectorBlock()` required `<selector> {` and so
  could not see a selector sitting mid-group behind a comma, silently
  falling through to a later standalone rule that sets only colours — it was
  checking a font-size contract against a block with no font-size. The
  helper now returns every rule whose selector list contains the selector,
  and the contract reads "some rule sets font-size from the token, no rule
  reintroduces the raw literal". `--text-micro: 0.58rem` (introduced by #329
  for the HUB / TREND / 孤立 badges) is now pinned too. Verified with four
  mutations, each of which the test catches. Suite: 1,075 passed / 0 failed.

- **Oral / Highlight marks restored on CVF and ACL venues (#348).** CVF and
  ACL Anthology carry no oral/poster distinction, so re-collecting a venue
  that had previously been collected from arXiv made `write_outputs`
  overwrite the older `oral_summaries_ja.md` and drop Oral to 0. The
  collectors now preserve the arXiv-declared oral overlay
  (`--oral-arxiv-query`), restoring the marks for cvpr-2025, cvpr-2026,
  iccv-2025 and emnlp-2025.

- **Whole-site UI/UX audit pass (#350).** A11y, interaction and consistency
  fixes across all 11 page templates (landing, 10 catalogs, lineage, deep,
  themes, how-it-works).

- **PII removed from the public README.** The worked example in
  `paperpilot/scripts/README.md` embedded a real address; replaced with a
  placeholder.

- **deep viewer no longer silently shows the wrong paper (#327).**
  `deep.html?arxiv=<id>` for an id not in the deep manifest (e.g. a theme
  card's paper) previously fell back to `manifest[0]`, rendering a
  different paper's lineage under the requested id. Now it shows an honest
  "not available" notice + the picker instead of swapping papers.

- **#300 slot-fill heuristic rationale — relation collapse fix.**
  `_derive_relation_heuristic` (`paperpilot/scripts/_lineage_classify.py`)
  previously emitted generic `TEMPLATE_RATIONALES[...]` strings on both
  the intent_map and year_cite branches. When the LLM was unavailable
  (Groq quota exhausted → `None`), `_apply_llm_classification` dropped
  every such edge because the rationale was a member of
  `_TEMPLATE_RATIONALES_SET` — wiping all signal-bearing heuristic edges
  and producing the empty-tree "relation collapse" reported on the family
  tree viewer. The fix generalises the slot-fill pattern already used by
  `_foundational_ancestor_edge`: a new `_slot_fill_rationale(relation,
  parent, child, intent=None)` helper builds a Japanese, paper-specific
  rationale embedding the actual parent/child titles (60-char trimmed)
  plus years plus the signal (S2 intent label or year-cite delta). The
  output is by construction never a `TEMPLATE_RATIONALES` value, so the
  edge survives the LLM-None drop. Invariants preserved: (a) #209
  no-fabrication boundary — no-signal pairs still `return None`, no new
  edges created; (b) #131 template-echo reject set + prompt MUST-NOT
  block stay intact as the LLM-echo backstop. Successor / contrasts
  sentences are hedged ("…と推定") to state the inference basis since
  these are heuristic, not LLM, judgements. Audit's
  `template_rationale_ratio` drops toward zero — the old collapse signal.
  Adds 14 new tests + updates 3 existing tests (902 total pass).

- **#285 prompt rewrite: per-relation definitions + supersedes/ablation
  examples.** `CLASSIFY_SYSTEM_PROMPT` (`paperpilot/llm/base.py`) previously
  listed only the relation enum NAMES with no definitions, so the LLM could
  not tell `supersedes`/`successor`/`extends`/`ablation`/`baseline_only`/
  `contrasts` apart — audit #286 showed `supersedes`=0 / `ablation`=0 across
  452 calls. Added a terse per-relation definition (verbatim from
  docs/design/08-lineage-roadmap.md §関係種別ラベルの定義) plus two few-shot
  examples (the canonical FlashAttention-2 supersedes case + an ablation
  case). Prompt grew 855 → 1,191 chars, still under the 1,200-char Groq TPM
  budget cap. Caveat: the primary measurable target is `supersedes` (7 gold
  records); cross-paper `ablation` is near-absent in real lineages (1 gold
  record) because ablations live within single papers, so its definition +
  example are kept terse rather than over-engineered.

> **過去の履歴** — 完了済みの詳細セクション 20 本（#209 S2-free 移行、CF Worker
> 復活 #233–#238、unarXive Phase J #222、lineage 品質改善 Tier 1 / edge audit、
> #285 prep など）は [`CHANGELOG-archive.md`](CHANGELOG-archive.md) へ一字一句
> そのまま退避した（無損失・md5 検証済み）。

## [0.1.0] — 2026-04-17

Initial release. Implements all stages of the v2.1 design spec except
SPECTER2 Embedding (a lighter MiniLM alternative is provided instead).

### Added

#### Pipeline
- **Stage 0** — async parallel collection from arXiv, Semantic Scholar,
  OpenAlex (`pipeline/stage_collect.py`).
- **Stage 1** — category / date / exclude-words / seen-ids filter
  (`pipeline/stage_rule_filter.py`).
- **Stage 2** — signal enrichment + weighted scoring + top-N cut
  (`pipeline/stage_metric_score.py`). Signals order enforced so
  GitHubSignal can use keyword_score in its lookup-budget priority.
- **Stage 3** — pluggable embedding similarity with the default
  `MiniLMEncoder` (~80MB `sentence-transformers/all-MiniLM-L6-v2`).
  Skipped unless `embedding.enabled: true`.
  Alternative encoders (SPECTER2, BGE, Cohere) can be slotted in by
  subclassing `AbstractEncoder`.
- **Stage 4** — LLM rerank with JSON-structured evaluations
  (`relevance`, `summary_ja`, `reason`, `tags`). Three backends:
  - `OllamaProvider` — local, free
  - `GeminiProvider` — Google AI Studio free tier
  - `ClaudeProvider` — Anthropic Messages API (spec's primary)

#### Sources
- `ArxivSource` — arXiv `export.arxiv.org` API, version stripped from IDs.
- `S2Source` — Semantic Scholar `/paper/search`, x-api-key header.
- `OpenAlexSource` — `/works` with `primary_location.source` (new field)
  and polite-pool mailto.

#### Signals (all normalized to [0, 100])
- `VenueSignal` — regex on arXiv comment field; Tier 1-3 + Workshop.
  Stress-tested on 60 patterns, 100% detection rate.
- `CitationSignal` — S2 `/paper/batch` (500 IDs/req). Future-date
  publications are clamped to today to avoid velocity inflation.
- `AuthorSignal` — S2 `/author/batch` (1000 IDs/req), h-index / 50.
- `GitHubSignal` — Papers with Code → GitHub Stars, log-scale
  normalization (MAX_STARS = 10000).
- `KeywordSignal` — match_count / 3 × 100, hyphen-insensitive.

#### Exporters
- `CSVExporter`, `JSONExporter` — daily dated files.
- `SlackExporter` — Incoming Webhook, no-op when URL is unset.
- `EmailExporter` — STARTTLS/SMTP, HTML + plain-text multipart.

#### Infrastructure
- `pyproject.toml` with `[dev]` and `[embedding]` optional-deps.
- Ruff (lint + format) and MyPy (strict) configuration.
- Pre-commit hooks (trailing-ws, private-key detection, ruff, mypy).
- `Dockerfile` multi-stage build (builder → runtime), non-root user.
- `docker-compose.yml` for local runs with env-file + volume mounts.
- `.github/workflows/publish.yml` — PyPI trusted-publisher on release.
- `.github/workflows/collect.yml` — daily cron at 22:00 UTC (requires
  PAT with `workflow` scope; tracked in Issue #14).

#### CLI
- `python -m paperpilot.collector` — main run.
  - `--days N` / `--keyword ...` / `--full` / `--skip-llm` flags.
- `python -m paperpilot.collector expand-keywords --write` — LLM-driven
  keyword synonym expansion.

#### Project-specific Claude Code configuration
- `CLAUDE.md` with architectural principles and 10 absolute rules.
- `.claude/skills/add-plugin`, `.claude/skills/run-verification`.
- Five specialized sub-agents (source/signal/exporter/test + reviewer).

#### Tests
- **278 tests, 97%+ coverage**.
- Mock-only policy for all external APIs and subprocess calls.
- Venue regex stress test enforcing ≥95% detection rate.

### Fixed (vs. initial review iterations)

- Gemini: API key moved from URL query param to `x-goog-api-key`
  header (security).
- GitHub signal: SSRF + path traversal hardening via strict
  `urlparse`-based repo URL validation.
- OpenAlex: venue now reads the v2 `primary_location.source.display_name`
  first; legacy `host_venue` retained as fallback.
- HTTP utils: added `overall_deadline` (default `timeout * 3`) so
  stacked 429/5xx retries can't burn ~90s.
- Citation velocity: future `publicationDate` is clamped to today.
- Email exporter: `OSError` / `ssl.SSLError` now caught alongside
  `SMTPException`; `quit()` always runs via `contextlib.suppress`.
- Stage 1 filter: papers with empty `categories` (S2 / OpenAlex style)
  now pass through the category filter instead of being silently dropped.
- Signal order: `KeywordSignal` runs before `GitHubSignal` so the
  latter's budget prioritization reflects keyword match.

### Deferred (tracked as open issues)

- #9  venue_cache + OpenReview integration
- #11 Altmetric social signal (paid API friction)
- #12, #14 CI workflows (PAT `workflow` scope blocker)

[Unreleased]: https://github.com/taichiiiiiiii/automatic-paper-search/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/taichiiiiiiii/automatic-paper-search/releases/tag/v0.1.0
