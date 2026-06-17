# Changelog

All notable changes to PaperPilot are documented here. This project
follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added

- **Family-tree viewer "仕組み" explainer page (#324).**
  `docs/how-it-works/` — an editorial page that explains what the coloured
  lineage edges mean (the six relation types: supersedes / successor /
  extends / ablation / baseline / contrasts) as a specimen list using the
  viewer's actual `--rel-*` edge colours, plus an honest short "how it's
  classified" section. Linked from the landing hero caption.

### Changed

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

### Added — Lineage edge provenance field + audit migration (#285 prep, 2 PRs)

Two PRs land the schema work that the upcoming LLM relation prompt
rewrite (#285 step 4-5) will measure against. Splitting field-add
from audit-migration kept the diff readable and let the field shape
be validated against real data between the two merges.

- **#290** `paperpilot/scripts/_lineage_classify.py` + `build_theme_lineage.py`:
  add a closed-enum `provenance` field to every edge emit path
  (`context_pattern` / `intent_map` / `year_cite` /
  `foundational_allowlist` / `llm`) and persist it through BFS,
  descendants, and cross-node serialization into
  `docs/themes/<slug>/lineage.json`. `_make_derived` asserts the
  value is in the closed set at runtime so typos surface immediately.
  Aggregate `meta.provenance_breakdown` Counter added to the payload.
- **#291** `paperpilot/scripts/audit_lineage_classification_breakdown`:
  migrate from rationale-string match to field-read with rationale
  fallback for legacy lineage.json (pre-#290 themes). Output reshapes
  from the old 3-bucket form to the new 5-enum, with all 5 buckets
  pre-initialized so empty ones still print n=0. Legacy normalization
  map covers all 6 `TEMPLATE_RATIONALES` values (not just the 2
  post-#283 survivors). Forward-compat: unknown future enum values
  warned once via dedup set, bucketed dynamically via `setdefault`.

### Added — Lineage classification audit & evaluation infrastructure (#285 in flight)

Three PRs ship the measurement scaffolding required before the LLM
relation-classification prompt rewrite (#285 step 4-5) can be merged
under a real macro-F1 gate.

- **#286** `paperpilot/scripts/audit_lineage_classification_breakdown`:
  reads `docs/themes/*/lineage.json` plus
  `paperpilot/data/lineage-cache/classifications.json` and produces a
  per-provenance × per-relation distribution. Confirmed
  **`supersedes`=0 / `ablation`=0 across 452 wellformed LLM calls**,
  pinpointing the prompt (not the heuristic) as the bottleneck.
- **#287** `paperpilot/tests/fixtures/relation_gold_set.jsonl` +
  `paperpilot/scripts/eval_relation_prompt`: 29 human-labeled
  (parent, child) pairs from the published LLM-decided edges, plus
  a precision / recall / macro-F1 evaluator with `--predictor=current`
  (static snapshot, no API call) and `--predictor=live` (re-query the
  LLM with the bundled abstracts). Current baseline: macro-F1=0.237.
  Caveat: 4 of 7 classes are absent from the LLM output (`successor`,
  `unrelated`, `baseline_only` always; `supersedes`, `ablation`
  always), so the headline F1 is dragged down by the empty classes —
  binary-F1 over `extends` + `contrasts` alone is ~0.59. Whether to
  push the LLM to emit the absent labels (`successor` / `unrelated` /
  `baseline_only` / `supersedes` / `ablation`) is the open decision
  for step 4.
- **#288** `eval_relation_prompt --predictor=live` wiring fix: the
  initial cut left `GroqProvider` constructed without `api_key`, so
  `.enabled` evaluated False and the live mode aborted. Now loads the
  key via `config_loader.env.groq_api_key` and forces Groq (the only
  production-supported provider). The fix surfaces a 401 from the
  current `.env` key — rotate to unblock #285 step 5.
- **#293** `eval_relation_prompt --provider {auto,groq,gemini}`: adds a
  provider selector to live mode and produced the first live macro-F1
  numbers. **Key finding that revised #286's conclusion**: with the
  prompt unchanged, `gemini-2.5-flash` scored macro-F1 **0.372**
  (re-measured 2026-06-13: **0.354**) vs Groq llama-3.3-70b's 0.237 —
  Gemini emits `successor` / `unrelated`, the two relations Groq never
  produced across 452 calls. So the bottleneck is **model + prompt**,
  not prompt alone. Caveats baked into the docs: magnitude is noisy
  (n=29, single labeler, and free-tier Gemini 429-storms — the
  re-measurement saw **8/29 = 28% of calls fail to None=wrong**), and
  free-tier Gemini cannot survive a ~90-call production regen, so a
  production switch needs a paid tier plus a model-aware cache and a
  `PAPERPILOT_LLM_PROVIDER` override (neither exists yet). The provider
  switch decision and gold-set scaling (29→50+, add `ablation` /
  `supersedes` records, second labeler) remain open.

Open items recorded in `CLAUDE.md` § 既知のオープン項目 and
`docs/design/08-lineage-roadmap.md` § 判定品質の改善計画.

### Refactored — Removed dead heuristic emit paths (#283)

`paperpilot/scripts/_lineage_classify.py` previously emitted
`supersedes` / `ablation` / `baseline_only` candidates with the
canonical template rationales, which `_apply_llm_classification`
unconditionally dropped whenever the LLM returned `None` (the
steady-state condition under Groq free-tier quota exhaustion).
Net effect on published lineage: zero edges of those three relations
across 99 production edges (vision-transformer + flash-attention).

This release rips those three emit paths out of the heuristic:

- `_INTENT_RELATION_MAP` no longer maps `background → baseline_only`
  (unreachable on the OpenAlex-primary pipeline since OpenAlex
  provides no S2 intent labels at all)
- The year/cite block no longer emits `supersedes_year_cite`
  (was: `delta >= 3 AND parent_cite > 100 AND child_cite >= parent_cite * 1.5`)
- The year/cite block no longer emits `ablation_year_cite`
  (was: `delta <= 2 AND child_cite < 100 AND parent_cite > 1000`)

A side-effect worth flagging: `background`-only intent edges are
now `_is_ambiguous == True`, so under `--llm-strict=ambiguous`
(production default) they route to the LLM instead of being silently
skipped after the template reject. Net effect under quota exhaustion
is the same (no edge), but with budget the LLM can now rescue them.

Kept alive (regression-guarded by `test_year_cite_still_emits_*`):
`contrasts_year_cite` (16/99 edges real) and `successor_result`
(out of scope; deferred until LLM-only-edge subset measurement).

Also closes a single-source-of-truth violation flagged by parallel
review: `paperpilot/scripts/build_deep_lineage.py:_FALLBACK_RATIONALE`
previously duplicated `paperpilot/llm/base.py:TEMPLATE_RATIONALES`
byte-for-byte. Replaced with a derived mapping that fails at import
time on any drift.

Follow-up issue tracks the prompt rewrite phase (per-relation 1-line
description + 2 good examples for supersedes/ablation, char cap
unchanged, mirroring `docs/design/08-lineage-roadmap.md:136-142`
verbatim — pending LLM-only subset measurement and 50-edge gold-set
manual labels before the prompt change ships).

### Changed — Theme submission deployment: CF Worker resurrected (#233-#238)

CF Worker (`worker/index.ts`) is the live theme-submission API again.
The architecture flip-flopped twice through May-June: original CF
Pages + CF Worker setup (working) → CF Access blocked the Worker URL
→ migrated viewer to GH Pages + dropped the form (#229) → re-added
form via Vercel Function as a workaround (#231) → discovered CF
Access can be toggled off from the Workers Settings tab, restored
the original CF Worker design, removed the Vercel detour (#233).

Today's surface area:

- **`worker/index.ts` + `wrangler.jsonc` + 54 tests restored** from
  `0add33b^` (parent of the original retirement commit). Includes
  the per-IP KV rate limiter (5 req/h/IP + 100/day global cap), the
  manifest-dedup fast path (raw.githubusercontent.com), and the
  /api/themes/status endpoint for client polling. `paperpilot/tests/
  test_worker_slug_parity.py` re-pins the Python ↔ JS slug derivation
  (`themeSlug()` in `worker/slug.js` vs `theme_slug()` in
  `paperpilot/scripts/_common.py`).
- **Vercel surface deleted**: `api/themes.js`, `api/themes.test.mjs`,
  `vercel.json`, `.github/workflows/dispatch-on-theme-request.yml`,
  `.github/ISSUE_TEMPLATE/theme-request.yml` all removed. PAT scope
  collapses back to `actions:write` only (no separate `issues:write`
  PAT for Vercel) — the Worker dispatches `theme-on-demand.yml`
  directly via the GitHub Actions REST API.
- **Frontend re-wired** (`docs/themes/index.html`,
  `docs/assets/theme.js`): meta `paperpilot-api-base` points at
  `https://automatic-paper-search.puuptdbkh082.workers.dev`. CSP
  `connect-src` allows `*.workers.dev`. Submit logic handles the
  Worker response shape (`{ok, status: queued|exists|invalid|
  rate_limited|error, slug, message?}`) — no Vercel-specific
  `pending` branch or `issue_url`/`issue_number` reads.
- **Degraded-mode hardened** (#235): when the Worker is briefly
  unreachable (typical during CF Access toggle), the form's error
  banner now offers a "GitHub Issue で送信 →" link instead of just
  "送信できませんでした", so users always have a path forward.
- **Dead code removed** (#237, #238): `env.ASSETS` branch in
  `worker/index.ts` (always undefined under the GH Pages deploy
  shape — `if (env.ASSETS)` always took `else`), `THEME_PATTERN`
  alias for `THEME_INPUT_PATTERN`, `RunFromApi` type duplicating
  `RunSummary`, verbose wrangler.jsonc preamble re-explaining setup
  steps that live in CLAUDE.md, unused `els.reqHint` DOM ref.
- **CI noise reduction** (#236): `data-audit` `paths:` filter
  narrowed from `docs/themes/**` to `docs/themes/*/lineage.json`,
  so viewer-shell PRs (CSP / CSS / api-base tweaks) no longer
  spuriously report the pre-existing 3-themes-flagged audit
  failure. `audit_theme_seeds.py` footer rewrites operator hint
  from "re-dispatch for every flagged theme" to "inspect each paper
  first — audit only sees title+tldr, not the full abstract
  production filtering uses, so it routinely flags foundational
  papers like the ViT or InstructGPT seeds as false positives".

**Slug parity invariant**: collapses back from 3-way (Python ↔
front-end SLUG_RE ↔ Vercel `api/themes.js`) to 2-way (Python ↔
`worker/slug.js`). Pinned by `test_worker_slug_parity.py`.

Operator setup post-merge (one-time): toggle CF Access OFF for the
Worker URL (Workers Settings tab in dash.cloudflare.com or
Applications in one.dash.cloudflare.com), `wrangler secret put
GH_DISPATCH_PAT` with a fine-grained PAT (this repo, Actions: RW
only), push to develop — CF Workers Builds auto-deploys.

5 PRs (#233 / #234 / #235 / #236 / #237 / #238), 779 total Python
tests pass, 54 Worker tests pass, ruff clean.

### Added — unarXive 2022 citation contexts, S2-free (#209 Phase J)

**Solves the 81% template-rationale problem without an S2 API key
and without LLM cost.** Uses the pre-extracted citation paragraphs
from Saier et al. (JCDL 2023, unarXive 2022, CC-BY-SA-4.0) as the
rationale source. The S2 context-regex classifier (originally
intended for PR #216) lands here, but now reads from a local
DuckDB instead of an S2 API call.

- **`paperpilot/utils/unarxive.py`** — DuckDB read-only lookup
  module. ``fetch_contexts(child_arxiv_id, parent_openalex_id)``
  returns citation paragraphs in O(log n). Graceful when DuckDB is
  absent: returns ``[]`` so the build pipeline degrades to year/cite
  fallback rather than crashing.
- **`paperpilot/scripts/build_unarxive_index.py`** — offline,
  one-shot script that downloads ``saier/unarXive_citrec`` from HF
  (~7 GB), joins the citrec rows with the ``license_info`` sidecar
  to recover the citing paper's arXiv id per row, and writes a
  DuckDB file (~2-3 GB) with a composite index on
  (citing_arxiv, cited_openalex_url). The DuckDB ships as a GitHub
  Release artifact, not in git.
- **`_classify_from_contexts` + `_CITATION_CONTEXT_PATTERNS`**
  (`paperpilot/scripts/build_theme_lineage.py`) — 6-relation regex
  classifier matching the actual citing sentence: ``outperforms`` →
  supersedes (priority 1), ``unlike`` → contrasts (priority 2),
  ``build on`` / ``extends`` / ``based on`` / ``following`` /
  ``inspired by`` → extends (priority 3), ``ablation`` → ablation,
  ``as a baseline`` / ``compared to`` → baseline_only, ``subsequent
  work`` → successor.
- **`fetch_related_via_openalex` enriches ``_contexts``** by calling
  ``_enrich_with_unarxive_contexts`` after the BFS query. For
  ``references`` it extracts the focal's arXiv id from the same
  OpenAlex Work payload (no extra round-trip); for ``citations``
  it uses each neighbour's own arXiv id as the citing side.
- **`derive_relation` tries `_classify_from_contexts` FIRST** —
  before the intent map, before year/cite contrast, before any LLM
  call. A successful regex match short-circuits the entire
  pipeline, including ``--llm-strict=all``.

**Coverage** (verified by the deep-dive research agent):
~60-70 % of (parent, child) edges with both papers in arXiv CS get
≥ 1 paragraph from unarXive. The remaining 30-40 % falls through
to the existing year/cite heuristic. 2023+ child papers are
silent (unarXive 2022 cutoff). Trade-off documented in CLAUDE.md.

**License**: unarXive is CC-BY-SA-4.0. Surfaced paragraphs are
short excerpts (academic fair use scope) with a "data: unarXive
2022 (CC-BY-SA-4.0)" attribution in the viewer footer.

15 new tests for the unarXive module + 10 new tests for the
regex classifier + ``derive_relation`` integration. 758 total
pass, ruff + mypy clean.

Operator: run `uv pip install duckdb datasets` then
`uv run python -m paperpilot.scripts.build_unarxive_index` once
to produce ``paperpilot/data/unarxive/unarxive.duckdb``; ship via
GitHub Release artifact for CI consumption. Pipeline degrades
gracefully without it (no crash, just no contexts).

### Fixed — Audit script false positives via light stemming (#209 Phase 1.6)

Operator noise reduction. Post-#220 audit still flagged legitimate
seeds as off-topic because `audit_theme_seeds.py` runs against the
viewer-side `title + tldr` (the lineage.json doesn't persist full
abstracts) and required exact substring matches. Inflectional
mismatches like the Knowledge Distillation theme over a paper that
says "distilled" (not "distillation") produced false positives the
operator had to manually verify.

- **`_stem` light suffix-stripping stemmer** added to
  `paperpilot/scripts/audit_theme_seeds.py`. Strips `ation` / `tion`
  / `ion` / `ying` / `ing` / `ies` / `ied` / `ier` / `est` / `ed`
  / `es` / `er` / `s` from words of length ≥ 5 (won't collapse short
  tokens like "self"). Recurses on multi-char suffixes so
  "ablations" → "ablation" → "ablat" reaches a fixed point in one
  call; the `s` suffix doesn't recurse to avoid collapsing
  "supervis" → "supervi" too far (would break the supervised/
  supervision equivalence).
- **`_stem_contains` substring check** uses the stem as fallback
  when the literal word isn't in the haystack — so "distillation"
  matches a haystack containing "distilled".
- **`_is_on_topic` 3+ word path** uses stem matching for word hits.
  The 2-word path keeps its strict phrase / title-only rule because
  stemming alone can't recover words that are entirely absent.
- Tests: 8 new (stem mechanics + idempotency + DistilBERT /
  SimCLR / ViT / Neural Architecture Search seed-keep regressions).
  733 total pass, ruff + mypy clean.

### Fixed — OpenAlex topic field gate (#209 Phase 1.5b)

Pre-#209-Phase-1.5b audit found Planck cosmology, AlphaFold biology,
and similar physical-science papers leaking into AI/ML themes
(state-space-model, variational-autoencoder etc.). Root cause: the
legacy `concepts.id:C41008148|C33923547|C137293760` (CS|Math|Linguistics)
filter is multi-label — a paper passes if ANY of its concepts at any
score matches. "Planck 2018 results" had a level-0 Mathematics concept
at score 0.23, enough to match.

- **Replaced `concepts.id:...` with `primary_topic.field.id:fields/17`**
  (`paperpilot/scripts/build_theme_lineage.py`,
  `discover_seeds_via_openalex`). The 2024 OpenAlex topics taxonomy
  is single-label: a paper's `primary_topic` resolves to exactly one
  `field`, and we require Computer Science (field 17). Verified by
  manual curl 2026-05-28 that Planck cosmology papers are now
  excluded structurally.
- **Test pin updated**: `test_openalex_fallback_invoked_when_s2_returns_zero`
  + `test_discover_seeds_via_openalex_uses_relevance_sort_default` now
  assert the `primary_topic.field.id:fields/17` substring.
- **Trade-off**: pure-math papers whose primary_topic field is
  "Mathematics" (e.g. some optimization-theory work) are now dropped.
  Acceptable for AI/ML lineage; revisit when a Math-heavy theme regresses.

### Fixed — OpenAlex search relevance (#209 Phase 1.5)

Post-#217 first-regen audit: 6 of 19 themes (Chain of Thought, DPO,
Flash Attention, MoE, Vector Database, World Model) returned 0 seeds.
Root cause: `discover_seeds_via_openalex` set `sort=cited_by_count:desc`
which overrode OpenAlex's default `relevance_score:desc`. For
ambiguous theme names, OpenAlex's BM25 + cite-count ranking would
surface high-cite papers that merely contained the query tokens —
bioinformatics, crystallography, climate — and the downstream
topic-relevance filter dropped 100 % of them.

- **`sort=cited_by_count:desc` removed from OpenAlex query**
  (`paperpilot/scripts/build_theme_lineage.py`,
  `discover_seeds_via_openalex`). OpenAlex's default is BM25 over
  title + abstract — exactly what we want. `_rank_and_truncate`
  re-orders the relevance-ranked pool by velocity before truncating
  to top-N, so the seminal-over-survey preference still applies.
- **Regression test pin** (`test_discover_seeds_via_openalex_uses_relevance_sort_default`)
  asserts the absence of a `sort` key in the OpenAlex params, so a
  future refactor can't silently reintroduce the override.
- **Verified by manual curl** on 2026-05-28: same `Chain of Thought`
  query returns Wei et al. seminal paper at #2 (was rank 432+ when
  sorted by cited_by_count).

### Added — OpenAlex-primary architecture (#209 S2-free Phase 1)

Foundation for running the lineage pipeline without any S2 API
dependency. S2 free-tier on shared GitHub-Actions CI IPs hits the
throttle pool too aggressively; signing up for a free S2 key
requires a non-gmail organisational email which most indie users
don't have. OpenAlex offers no-auth access at 10 req/s in the
polite pool (with `mailto`) — enough for full bulk regen — and
returns equivalent metadata (with the trade-off of no `intents`
and no `citation contexts`).

- **`_work_to_paper_dict`** (`paperpilot/scripts/build_theme_lineage.py`)
  converts an OpenAlex Work to an S2-shape paper dict. `paperId` is
  prefixed `openalex:W...` so the BFS layer can route by prefix.
- **`_decode_abstract_inverted_index`** reconstructs OpenAlex's
  word-position-encoded abstracts to plain text — needed for the
  topic-relevance gate and LLM rationale paths to see real
  abstract text.
- **`discover_seeds(..., primary_source="openalex")`** runs an
  OpenAlex-only seed discovery path with no S2 calls anywhere on
  the success path. Defaults to `"s2"` so existing callers behave
  unchanged.
- **`fetch_related_via_openalex`** (BFS): `references` resolves via
  `GET /works/{id}.referenced_works` + batch fetch; `citations`
  uses `GET /works?filter=cites:W{id}&sort=cited_by_count:desc`.
  Each result is shaped like an S2 paper response.
- **`fetch_related` dispatch** (`paperpilot/scripts/build_lineage.py`)
  detects the `openalex:` prefix and routes BFS to the OpenAlex
  path without S2 calls; cache layer is shared so re-runs are cheap
  on either backend.
- **CLI `--primary-source {s2,openalex}`** flag exposed on
  `build_theme_lineage` (default `s2` for backwards compat).
  Workflows opt in to `openalex`.
- **`.github/workflows/theme-on-demand.yml` + `regen-themes.yml`**
  now invoke `--primary-source openalex` so the production CI runs
  without any S2 API key requirement.

Trade-offs:
- OpenAlex doesn't expose citation `intents`, `contexts`, or
  `isInfluential` → these fields are `None` on OpenAlex-sourced
  paper dicts. The relation classifier falls through to year/cite
  contrast or LLM. Phase 2 (#52, SciCite local) and the later
  unarXive integration close that gap without S2.
- arXiv-only papers without DOIs surface fine via OpenAlex; older
  journal-only papers without DOIs may not.

### Changed — Non-LLM seed quality (#209 Tier 1)

Pure-code seed-side improvements that work regardless of LLM choice.
Designed to land before the LLM swap (#213) so the LLM only has to
classify edges over already-clean seed pools.

- **Citation velocity ranking** (`_compute_seed_score`,
  `_rank_and_truncate`) — replaces raw `citationCount desc` with
  `(cites + 1) / max(current_year - year, 0.5)`. The 2026-05-27 audit
  found graph-neural-network's top-5 returning 3 surveys instead of
  GCN / GraphSAGE / GAT because the surveys had accumulated more raw
  cites despite being years younger than the seminal works. Velocity
  normalisation makes age comparable: a 2017 seminal at 15k cites
  (~1.7k velocity) now beats a 2021 survey at 6k cites (~1.2k velocity).
- **Survey / review penalty** (`_is_survey`,
  `_SURVEY_VELOCITY_PENALTY = 0.30`) — title-regex detector for
  ``A Survey of X``, ``Foo: A Survey``, ``Review / Tutorial /
  Overview / Perspective / Roadmap / Primer``; scored seeds get a
  70 % velocity penalty (multiplicative, not zero, so genuinely
  seminal surveys can still surface when no better candidate exists).
  Title-only to avoid false positives from
  ``we survey related work``-style abstract phrasings.
- **Per-theme keyword blacklist**
  (`paperpilot/data/theme_blacklist.json` +
  `_filter_theme_blacklist`) — theme-specific veto layered on top
  of the theme-independent
  `_is_implementation_foundation` denylist. Catches the long tail
  of cross-domain leakage S2's
  `fieldsOfStudy=Math` accepts (microbiome / clinical / homology
  modelling). Initial entries from the 2026-05-27 audit cover the
  9 themes flagged as having off-topic seeds. New entries are
  cheap to add — one JSON tweak per regression.

### Added — Edge-level lineage audit (#209)

- **`audit_lineage_quality.py` extended with edge metrics**
  (`edge_metrics()` + `_audit_edges()`) computing:
    * `template_rationale_ratio` — fraction of edges whose rationale
      is byte-for-byte one of `TEMPLATE_RATIONALES.values()`. Hard
      fail above 80 %, warn above 60 %.
    * `popularity_sinks` — nodes with ≥ 8 incoming edges. Hard fail
      above 5 sinks/lineage; warn on any.
    * `year_reversals` — edges where parent year > child year + 1
      (1-year window absorbs preprint/conference overlap). Hard fail
      above 10/lineage.
  Pre-#209 audit found 93.7 % of theme edges were template + 4-5
  popularity sinks per theme — the new metrics make these regressions
  CI-visible instead of buried in JSON.
- **Themes opt-in via `--include-themes`** (default OFF). The
  data-audit CI keeps walking only conferences until the bulk
  theme regeneration lands clean; flip the flag in the workflow
  after the #210 + #211 + regen sequence finishes.
- **`--themes-only`** convenience flag for operators auditing just
  the theme corpus locally.
- **Theme paths skip the focus-paper-recency check** — themes
  legitimately seed on seminal 2017-2020 papers (DDPM, GANs,
  Transformer) and would otherwise drown the failure list in
  false positives.

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

### Fixed — Lineage edge fabrication (#209)

- **Drop `_DEFAULT_DERIVED` "extends" fallback**
  (`paperpilot/scripts/build_theme_lineage.py`,
  `_derive_relation_heuristic`) — 2026-05-27 audit found 1222/1304
  (93.7 %) of edges across 18 published themes were emitted by this
  fallback with a single template rationale (`論文 B は論文 A の
  手法を異なる領域・タスク・スケールに拡張している`). The fallback
  is gone; edges with no S2 intent AND no year/cite contrast now
  return `None` (drop). In strict modes the LLM is the only path to
  recover the edge — if it also doesn't fire, the edge stays
  dropped instead of being fabricated. (PR #2xx, closes #209)
- **Use LLM confidence verbatim + threshold-drop weak edges**
  (`_apply_llm_classification`) — pre-#209 the merge took
  `max(heuristic 0.7, llm)`, hiding a "timid LLM" (conf 0.3) behind
  a heuristic floor. The new policy uses LLM confidence directly
  and drops edges where the LLM's own confidence is below
  `_MIN_LLM_CONFIDENCE = 0.4` — the LLM has actually read both
  abstracts; trusting its uncertainty is more honest than masking
  it. LLM hiccup (`None`) still falls back to a non-None heuristic.
- **`scripts/purge_template_classifications.py`** — one-shot purge
  of cached LLM classifications whose rationale is one of
  `TEMPLATE_RATIONALES.values()`. The 2026-05-27 audit found 123
  of 407 cache entries (~30 %) were template-poisoned from pre-#131
  runs — these short-circuit future LLM rescue calls forever
  because `_CachedClassifyProvider` hits the cache first and
  `from_dict` rejects the entry. Initial run dropped 123 entries
  (cache 407 → 284). Idempotent on already-clean caches; covered
  by 10 unit tests including CLI dry-run / write-back / malformed
  cache paths.

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
