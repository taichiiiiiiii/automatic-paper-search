# PaperPilot / automatic-paper-search

## Mission

Maintain `taichiiiiiiii/automatic-paper-search` as a reliable, low-cost paper discovery and lineage system. Work in Japanese unless asked otherwise. The active target branch is `develop`; merges there can publish GitHub Pages.

## Sources of truth

Prefer current code and tests, then `CLAUDE.md`, `docs/design/`, workflows, and generated-data contracts. Use `docs/design/13-agent-workboard.md` for active task routing; it does not override the architecture or implementation contracts. Verify paper metadata against primary APIs or original papers. Never fabricate titles, authors, identifiers, citations, venues, summaries, or lineage relations.

## Invariants

- Preserve the Stage 0-4 contracts, plugin base classes, configuration-driven behavior, idempotency, and fail-safe degradation.
- Store secrets only in environment variables or GitHub Secrets. Never write tokens to config, logs, fixtures, generated pages, or prompts.
- All external API calls need bounded retries, timeouts, rate limiting, caching where appropriate, and deterministic mocks in tests.
- Keep source identity and provenance. Deduplicate with stable identifiers and explicit fallback rules; do not merge papers by title alone.
- LLM summaries and relation labels are untrusted derived data. Preserve evidence links, schema validation, cache versioning, and an `unknown`/fallback path.
- `docs/assets/versions.json` is the source of truth for asset versions; do not hand-edit cache query strings.
- Docker is the selected target for the canonical production and integration-test path. For local Docker work, use `docker/paperpilot-compose`; do not bypass its digest/platform preflight with raw Compose. Existing GitHub workflows still use host `uv` until the approved-image runtime and CI-shadow gates pass, so do not claim that production or CI has already migrated.
- The checked-in Docker digest example is intentionally invalid. Do not pull/build images, choose a digest set, migrate CI, or claim runtime verification without the corresponding explicit approval and evidence. Host `uv` is limited to lock maintenance and short auxiliary checks during this transition, never evidence that the Docker gate passed.
- Never dispatch workflows, change Cloudflare/GitHub secrets, publish Pages, send Slack/email, merge to `develop`, or bulk regenerate themes without explicit user approval.

## Workflow

Research existing implementations first. Write a bounded plan and tests before code. Route bounded Python implementation to `paperpilot_backend_implementer` and bounded frontend implementation to `paperpilot_frontend_implementer`; both use GPT-5.6 Sol / medium. Use medium effort for routine bounded implementation and high only for security, provenance, schema, migration, or publication-risk work; do not use ultra. For retrieval or ranking work, define a frozen evaluation set and report recall, precision, duplicate rate, API cost, latency, and source coverage. For UI work, test keyboard access, narrow screens, large catalogs, empty/error states, and generated-asset consistency. Run ruff and pytest; treat mypy's known environment failure honestly. Review security and publication impact before merge.
