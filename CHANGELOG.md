# Changelog

All notable changes to PaperPilot are documented here. This project
follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

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
