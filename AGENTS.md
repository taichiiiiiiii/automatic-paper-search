# PaperPilot / automatic-paper-search

## Mission

Maintain `taichiiiiiiii/automatic-paper-search` as a reliable, low-cost paper discovery and lineage system. Work in Japanese unless asked otherwise. The active target branch is `develop`; merges there can publish GitHub Pages.

## Sources of truth

Start with the requested files and their tests; do not preload all documentation. Read `docs/design/11-target-architecture.md` for service boundaries, `18-lineage-trust-and-focus-view.md` for lineage, `17-paper-slide-deck-contract.md` for slides, or `19-conference-release-watch-contract.md` for conference updates (all under `docs/design/`). Use the workboard only to resume tracked work. Current code, tests and contracts outrank historical notes. Verify paper metadata against primary APIs or original papers. Never fabricate titles, authors, identifiers, citations, venues, summaries, or lineage relations.

## Invariants

- Preserve the Stage 0-4 contracts, plugin base classes, configuration-driven behavior, idempotency, and fail-safe degradation.
- Store application secrets only in environment variables or GitHub Secrets; the approved development provider uses the existing OS Keychain. Never write tokens to config, logs, fixtures, generated pages, or prompts.
- All external API calls need bounded retries, timeouts, rate limiting, caching where appropriate, and deterministic mocks in tests.
- Keep source identity and provenance. Deduplicate with stable identifiers and explicit fallback rules; do not merge papers by title alone.
- LLM summaries and relation labels are untrusted derived data. Preserve evidence links, schema validation, cache versioning, and an `unknown`/fallback path.
- `docs/assets/versions.json` is the source of truth for asset versions; do not hand-edit cache query strings.
- Docker is the selected target for the canonical production and integration-test path. For local Docker work, use `docker/paperpilot-compose`; do not bypass its digest/platform preflight with raw Compose. Existing GitHub workflows still use host `uv` until the approved-image runtime and CI-shadow gates pass, so do not claim that production or CI has already migrated.
- The checked-in Docker digest example is intentionally invalid. Do not pull/build images, choose a digest set, migrate CI, or claim runtime verification without the corresponding explicit approval and evidence. Host `uv` is limited to lock maintenance and short auxiliary checks during this transition, never evidence that the Docker gate passed.
- Never dispatch workflows, change Cloudflare/GitHub secrets, publish Pages, send Slack/email, merge to `develop`, or bulk regenerate themes without explicit user approval.

## Commit and push

Only the parent agent may commit or push, and only after explicit user authorization for that action; Qwen and native subagents never do so. A commit must be one complete logical unit whose acceptance criteria are met, with relevant checks passing (or an explicit recorded reason they could not run), the final diff reviewed, and no secrets, generated publication output, or unrelated changes staged. Stage only the named paths and use an accurate conventional commit message. Push only at a genuine milestone from a non-protected task branch after a successful fetch proves the remote branch is not ahead or diverged. Never push directly to `main`, `master`, or `develop`, never force-push, and do not treat a push as authorization to merge or publish Pages. If any condition is uncertain, preserve the work locally and report the blocker.

## Workflow

### Qwen task routing (current user instruction)

Implementation, application-level analysis changes, literature-processing code and directly needed unit/functional tests use
exact `qwen3.8-flash`. The implementation launcher is `.codex/bin/qwen-implement`:
exact `qwen3.8-flash`, provider `qwen_token_plan`, Individual Token Plan endpoint
`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, existing
Keychain service `codex-qwen-token-plan`. Cloud-only; no PAYG, local Flash or
other model/provider fallback. Provider request/stream retries remain zero. Native support agents may investigate,
research, measure or review, but never implement or serve as fallback routes. System investigation and evaluation
use Terra/medium; retrieval research and security review use Sol/high. Delegate only one or two independent bounded
tasks, and workers cannot spawn children.
During an active Goal, the parent may automatically start a new bounded Flash invocation
after the prior process has ended and its diff/results were reviewed. There is no fixed
Flash-attempt cap for the Goal or a hypothesis while each invocation is materially different,
evidence-based and has explicit acceptance checks. Allow only one active implementation per
project/worktree and no identical blind retry. A pre-admission busy result may be retried once
after capacity is confirmed free. If the same failure repeats twice without new causal evidence,
reject only that hypothesis/checkpoint and automatically continue to the next distinct testable
hypothesis; do not block the whole Goal merely because one hypothesis failed or MAX is unavailable.
MAX is optional during development and required only before high-risk adoption. Stop at the Goal
success condition, eight consecutive valid non-improving hypotheses, or when no safe in-scope
testable hypothesis remains. Heartbeats
and schedules may not launch implementation. The parent reviews changes. Do not change shared queue defaults, credentials, global
Codex settings, or the product's Sol model. Outside an active Goal, configuration work does
not authorize starting implementation, paper processing, or publication. Do not routinely use xhigh, max or ultra.

Use `qwen3.8-max` only for evaluation of major paper conclusions, analysis methods,
statistics/reproducibility, external-publication candidates, cross-module changes, or another
materially stable candidate revision covered by these risks. MAX has no numeric, percentage,
Goal-wide or per-revision evaluation cap. The parent may invoke it whenever a fresh read-only
evaluation materially reduces adoption risk or resolves a concrete uncertainty, and records the
trigger, new evidence or changed risk plus the final decision. A materially changed candidate is
eligible again; an unchanged candidate may be re-evaluated only when acceptance criteria,
evidence or unresolved risk materially changes. Never repeat an identical packet without a stated
new reason, pad review activity or let MAX replace the parent decision. MAX unavailability
holds high-risk adoption but does not stop lower-risk investigation or the whole Goal. Send only acceptance criteria,
diff, changed files, relevant test/analysis results and minimal surrounding code—never
the whole repository, long conversation history or bulk logs. MAX must not reimplement:
return major defects, claim/evidence mismatches, reproducibility gaps and an adoption
recommendation briefly. The parent Codex makes final acceptance and integration decisions.
MAX is a separately selected review, never an implementation fallback. Use the existing
Cloud connection through `.codex/bin/qwen-evaluate --parent-reviewed < evaluation.json`;
never substitute a native profile or bypass launcher guards. The parent must inspect/redact
the packet before transmission; automated secret detection is not exhaustive. Publication and source/API access still need
their existing authorizations; model routing grants no new external-operation permission.

### Work to the acceptance criteria

Make the smallest change that meets the current request. Prefer existing structures, dependencies and abstractions. Do not add speculative frameworks, generalization, new documents, ceremonial reviews, or unnecessary fallback/compatibility layers; new mechanisms require a concrete current requirement.
Define scope and observable acceptance criteria, inspect the relevant diff, run proportionate checks, fix regressions caused by this change, and stop when the criteria are met. Report unperformed checks and known mypy failures honestly. For retrieval/ranking changes use a frozen evaluation set; for UI changes check affected accessibility, narrow-screen, empty/error and asset-generation behavior. Scientific human-review and publication gates cannot be replaced by agent review.

For an authorized task, provide only the goal, named files, relevant contract, safety constraints and acceptance checks. Do not duplicate tests for small reversible changes or repeat the worker's entire task for review.
Avoid short-cycle subagent polling. Do useful independent work first; otherwise wait twice the estimated remaining time, or 120 seconds when unknown, subject to the host tool's limits. Prefer completion notifications.
