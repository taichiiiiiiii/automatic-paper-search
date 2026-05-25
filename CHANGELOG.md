# Changelog

All notable changes to PaperPilot are documented here. This project
follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added — Theme lineage quality + LLM cache amortisation

- **Foundational-ref filter** (`paperpilot/scripts/build_theme_lineage.py`
  `_filter_off_topic_refs`) — drops BFS parent/child candidates whose
  `citationCount > _OFF_TOPIC_CITE_MULTIPLIER × max(seed cites)` and
  that lack a `methodology` S2 intent. Catches "ResNet appearing in a
  GNN tree" without dropping refs the citing paper actually built on
  top of. Tightened from 3× to 2× in PR #128 followup. (PR #127, #128)
- **Seed topic-relevance filter** (`_filter_topic_relevant_seeds`) —
  multi-word themes (≥2 words of ≥3 chars) require at least half the
  words to appear in the seed's title or abstract, blocking the
  "Pandas paper surfaces as a Graph Neural Network seed" failure
  observed in production. Short themes (RAG, MoE) skip the gate.
  (PR #127)
- **Implementation-foundation denylist**
  (`paperpilot/data/lineage_denylist.json` +
  `_is_implementation_foundation`) — explicit list of paperIds +
  title patterns (Adam, TensorFlow, PyTorch, Scikit-learn, NumPy,
  SciPy, Batch Normalization, Dropout, Keras, pandas, ...) dropped
  unconditionally even with `methodology` intent. PyTorch Geometric
  and other topic-specific libs survive via the title-pattern
  carve-out. (PR #128)
- **`--llm-strict {off,ambiguous,all}`** flag on `build_theme_lineage`
  composes the heuristic relation classifier with an optional LLM
  refinement. Default `off` (heuristic only); `ambiguous` calls LLM
  only on edges whose S2 intents don't pick a known relation;
  `all` classifies every influential edge. (PR #120, #143)
- **`_CachedClassifyProvider`** decorator wraps any LLM provider
  with the shared `paperpilot/data/lineage-cache/classifications.json`
  used by `build_lineage.py`. Theme rebuilds + cross-theme overlap
  reuse already-classified `(parent, child)` pairs at zero LLM cost.
  The cache file is unignored selectively in `.gitignore` so it
  accumulates across CI runs. (PR #138, #139)
- **Groq rate limiter** (`paperpilot/llm/groq_provider.py`
  `_throttle_for_rate_limit`) — 60s / `rate_limit_rpm` spacing
  between calls keeps free-tier (30 RPM) builds within budget.
  Default 25 RPM with `time.monotonic` to survive wall-clock jumps.
  (PR #130)
- **`TEMPLATE_RATIONALES`** dict on `paperpilot/llm/base.py` —
  single source of truth for the six Japanese heuristic-template
  rationale strings. `_GENERIC_TEMPLATE_RATIONALES` (the LLM-echo
  reject set) and `build_theme_lineage`'s heuristic map both source
  from this dict, so the three consumers (heuristic emit / LLM
  reject / prompt MUST-NOT block) can no longer drift. (PR #146)
- **`CLASSIFY_SYSTEM_PROMPT` rewrite** — ~250 token Compare-A-then-B
  format with a MUST-NOT block listing the heuristic templates as
  forbidden outputs and a single paper-specific Good example. Token
  budget tuned for Groq free-tier TPM (6,000 / min). Production
  trace had shown Llama 3.3 70B regurgitating the heuristic
  templates instead of reading the abstracts; rewrite + reject set
  in `RelationClassification.from_dict` form a two-layer defence.
  (PR #132, #133)
- **`.github/scripts/commit-and-push.sh`** — git fetch + rebase +
  retry helper with multi-path stage support. Used by every
  data-writing workflow (theme-on-demand, regen-themes, collect-
  weekly, collect-daily-watch). Replaces the previous
  `git pull --rebase origin main || true && git push` pattern that
  silently swallowed rebase failures. (PR #122, #140)

### Changed — Theme generation flow

- `discover_seeds()` now accepts an optional `theme` kwarg and logs
  a warning when it's missing, so a forgotten kwarg can't silently
  re-introduce the off-topic-seed regression. (PR #127)
- `theme-on-demand.yml` runs with `--llm-strict=ambiguous` (was
  `off`); `regen-themes.yml` matches (was `off` until PR #143).
  Free-tier Groq cannot sustain `--llm-strict=all` — see #131 /
  #133 for the cancellation regression.
- `theme-on-demand.yml` timeout 8 → 15 min and `regen-themes.yml`
  60 → 120 min to absorb S2-throttle retries + LLM rate-limited
  spacing.
- All four data workflows migrated from `pip install -r
  requirements.txt` to `uv sync` (single source-of-truth from
  `pyproject.toml`, picks up numpy / python-dotenv that drifted
  out of requirements.txt). (PR #136, #142)
- `collect-weekly` and `collect-daily-watch` now push to `develop`
  (CF Pages auto-deploy target) instead of the abandoned `main`.
  (PR #141)
- Concurrency groups removed from theme workflows after #125
  experiment showed `cancel-in-progress: false` still drops the
  2nd-through-Nth queued dispatch — the retry loop alone handles
  5+ parallel pushes (verified by
  `test_five_parallel_runs_all_publish`). (PR #126)
- `build_theme_lineage()` refactored: scattered module constants
  centralised under section banners; Stage 3 BFS / Stage 4
  classify-summary / Stage 5 root-pick extracted into helpers.
  Main pipeline function 354 → 238 lines, no behaviour change.
  (PR #145, #146, #147, #148)

### Fixed — workflow + LLM regressions

- **collect-weekly.yml startup_failure** — step-level
  `if: ${{ secrets.GROQ_API_KEY != '' }}` is rejected by GitHub
  Actions at parse time (secrets context isn't allowed there).
  Resulted in a 0-second silent failure on every push for 3+ days
  with zero scheduled runs observed. Fix moves the check into the
  run script. Regression guard added in
  `paperpilot/tests/test_workflow_yaml_quality.py`. (PR #135)
- **regen-themes empty-dir guard** — `nullglob` made
  `ls "$conf"/papers_*.csv` succeed against an empty directory
  (ls with no args lists cwd), so the regen step crashed on the
  `paperpilot/output/daily/` placeholder. Replaced with explicit
  glob-expansion array length test. (PR #137)
- **Push race on `develop`** — multiple concurrent
  `workflow_dispatch` runs from the worker (rate-limit 5 / IP /
  hour) all pushed without rebasing, so all but one were rejected
  with `! [rejected] develop -> develop (fetch first)` and their
  generated `lineage.json` files silently lost. Five-attempt
  rebase+push retry with jittered backoff. (PR #122)
- **LLM prompt rationale quality** — Llama 3.3 70B was translating
  the prompt's English enum definitions into Japanese rather than
  reading the abstracts, producing byte-for-byte heuristic
  templates. Prompt rewrite + `_GENERIC_TEMPLATE_RATIONALES` reject
  set form a two-layer defence. (PR #132)

### Added — Day-1 authority signal & weekly/daily split

- **`FollowSignal`** (`paperpilot/signals/follow_signal.py`) — new
  `AbstractSignal` subclass that scores 100 when a paper is authored by
  someone in `profile.follow_authors`, or 50 when any affiliation
  contains a `profile.follow_orgs` substring. It's the only signal
  that's fully informative on publication day (venue / citation /
  stars all need time to mature).
- **Paper model** — `affiliations: list[str]`, `follow_score: float`,
  `follow_reason: str | None` fields.
- **OpenAlex source** extracts `authorships[].institutions[].display_name`
  into `Paper.affiliations` (deduped, first-seen order).
- **Runner** wires FollowSignal between VenueSignal and KeywordSignal
  so `follow_score` is available before the GitHub-lookup budget
  decision.
- **CSV exporter** exposes `follow_score`, `follow_reason`, and
  `affiliations` columns near the front for quick scanning.
- **`paperpilot/config.daily-watch.yaml`** — new companion config for
  the daily real-time watch workflow (lean: no LLM, no citation, just
  arXiv + OpenAlex + FollowSignal, 1-day window, 3-day seen-ids).
- **GitHub Actions split**:
  - `.github/workflows/collect-weekly.yml` — Saturday 07:00 JST deep
    survey (old `collect.yml`, renamed).
  - `.github/workflows/collect-daily-watch.yml` — daily 07:00 JST
    followed-author alerts.

### Changed

- Default `config.yaml` positioned as the weekly deep-survey config
  (header updated). `weights.follow: 3.5` added (highest weight — day-1
  authority beats venue/stars).

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
