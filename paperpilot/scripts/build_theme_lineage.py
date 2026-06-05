"""Build a chronological family tree for a free-text research theme.

Pipeline:
  1. Sanitise the theme (strip control chars, cap length).
  2. Expand the theme into related keywords via AbstractLLMProvider.
  3. For each keyword, GET S2 ``/paper/search`` → dedupe by paperId →
     filter by ``--since-year`` → sort by citationCount desc → take
     ``--seeds`` papers as the focus set.
  4. BFS ancestors for each seed up to ``--depth`` hops via
     ``build_lineage.fetch_related``.
  5. Classify each ``(parent, child)`` edge through
     ``provider.classify_relation``; drop ``unrelated`` and edges with
     empty rationale (silent tooltips are worse than no edge).
  6. Sort nodes by year ascending so the chronological viewer's
     rank-based Y axis renders deterministically.
  7. Write to ``docs/themes/<slug>/lineage.json`` (run
     ``generate_themes_manifest.py`` afterwards to refresh the picker).

Per CLAUDE.md absolute rules:
  - §11: All LLM calls go through ``AbstractLLMProvider`` (never
    urllib / requests directly to Groq / Gemini / Claude).
  - §14 (new): This script is the sole writer of
    ``docs/themes/<slug>/lineage.json``; the slug is derived from the
    theme via ``theme_slug()`` and is the only thing spliced into the
    output path. The raw ``--theme`` string never reaches a ``Path``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import unicodedata
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlparse

# Make `paperpilot.*` importable when run as `python paperpilot/scripts/...`
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpilot.llm.base import (  # noqa: E402
    TEMPLATE_RATIONALES,
    AbstractLLMProvider,
    RelationClassification,
)
from paperpilot.scripts._common import theme_slug  # noqa: E402
from paperpilot.scripts.build_lineage import (  # noqa: E402
    CACHE_DIR,
    build_provider,
    fetch_related,
    persist_classifications,
    to_node,
)
from paperpilot.utils.config_loader import load_env  # noqa: E402
from paperpilot.utils.github import (  # noqa: E402
    fetch_repo_stars,
    load_curated_map,
    parse_github_repo_url,
    search_repo_by_title,
)
from paperpilot.utils.http import request_with_retry  # noqa: E402
from paperpilot.utils.logger import get_logger, setup_logging  # noqa: E402

logger = get_logger(__name__)

# ---- Paths & directories ----
DOCS_ROOT = ROOT / "docs"
# Shared classification cache (also used by build_lineage.py). See
# _CachedClassifyProvider for the design; ignoring/un-ignoring rules in
# .gitignore allow this single file to be committed while the rest of
# paperpilot/data/lineage-cache/ stays untracked.
_CLASSIFICATION_CACHE_PATH = ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"
# Curated denylist of implementation-foundation papers (Adam, PyTorch,
# Scikit-learn, NumPy, ...) that S2's methodology intent would otherwise
# drag into every topic. See _is_implementation_foundation.
_DENYLIST_PATH = ROOT / "paperpilot" / "data" / "lineage_denylist.json"

# Optional alternate-keyword map used when the primary theme returns 0
# seeds. Lives in a JSON file so operators can tweak the alias list
# without editing the script. Loaded once per process.
_THEME_ALIASES_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "theme_aliases.json"
)

# ---- S2 endpoints ----
_S2_FIELDS_SEARCH = (
    "paperId,title,year,venue,citationCount,authors,abstract,externalIds"
)
_S2_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_SEARCH_LIMIT = 50
# Limit search to AI/CS-adjacent fields so the topic-relevance filter
# isn't the only thing standing between us and medical / biology / global
# health papers that share generic theme words ("World Model" hitting
# Global Burden of Disease, "Flash Attention" hitting hyperglycemia
# management, etc — verified on 2026-05-26 post-regen audit). S2
# documents valid values at /api-docs/graph#tag/Paper-Data — we ship
# the umbrella ML / AI / DS triplet plus Linguistics for NLP themes.
_S2_FIELDS_OF_STUDY = (
    "Computer Science,Mathematics,Linguistics"
)
_S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
# /paper/batch caps at 500 ids per call (https://api.semanticscholar.org
# /api-docs/graph#tag/Paper-Data/operation/post_graph_get_papers); cap our
# own send to half of that so even a wide OpenAlex page can never overflow.
_S2_BATCH_MAX_IDS = 250

# ---- OpenAlex fallback ----
# /paper/search on S2's free tier is the steady-state failure point on
# GitHub Actions — the shared IP pool is throttled by S2 — so a 429
# there nukes the entire build. We fall back to OpenAlex's /works (free,
# no key, much higher per-IP allowance) and resolve the DOIs through
# S2's /paper/batch endpoint, which has a separate budget from
# /paper/search.
_OPENALEX_WORKS_URL = "https://api.openalex.org/works"
_OPENALEX_PER_PAGE_MAX = 200
# Bare-DOI extraction collapses any of these URL hosts to a plain "10.x/y"
# for /paper/batch (which rejects URL-form DOIs).
_DOI_HOSTS = frozenset({"doi.org", "www.doi.org", "dx.doi.org"})

# ---- Theme input + BFS limits ----
_THEME_MAX_LEN = 500
_KEYWORD_EXPANSIONS = 8
# Cross-node lookup (#54) only checks for in-graph hits, so 100 refs is
# more than enough to surface any cohort-internal citation. fetch_related
# already caps at 100 (S2's per-page max).
_CROSS_NODE_LIMIT = 100

# ---- Trending threshold (#68) ----
# citations / year for *recent* papers. Limiting to the last 3 years
# keeps the badge meaning "fast-moving right now" — not "established
# classic". 200 cites/year for a 2024 paper means ~600 cites by
# mid-2026, well above noise.
_TRENDING_VELOCITY_THRESHOLD = 200.0
_TRENDING_AGE_LIMIT_YEARS = 3

# ---- Seed topic-relevance filter (#127) ----
# Multi-word themes whose words are all 3+ chars get a relevance gate:
# at least half of the words must appear (case-insensitively) somewhere
# in the seed's title or abstract. Short or single-word themes (RAG,
# MoE, BERT) skip the gate because their tokens produce too many false
# matches and S2's own search ranking is the better signal.
_TOPIC_RELEVANCE_MIN_WORD_LEN = 3
_TOPIC_RELEVANCE_THRESHOLD_RATIO = 0.5

# ---- Off-topic foundational-ref filter (#127 / #128) ----
# Anything cited more than `_OFF_TOPIC_CITE_MULTIPLIER × max(seed cites)`
# is treated as a foundational paper that's likely tangential to the
# theme (ResNet/Attention-Is-All-You-Need landing in a GNN tree because
# every modern ML paper cites them). The methodology-intent overrides
# this for non-denylisted papers. Multiplier lowered from 3.0 to 2.0 in
# #127 followup so the cite-only check catches more candidates.
_OFF_TOPIC_CITE_MULTIPLIER = 2.0

# ---- Seed scoring (#209 Tier 1) ----
# Replaces raw citationCount-desc with citation *velocity* (cites/year)
# multiplied by a survey penalty. Pre-#209 audit found graph-neural-network
# returning 3 surveys/reviews in its top 5 seeds because old surveys had
# accumulated more raw cites than seminal-but-young foundational papers
# (GCN / GraphSAGE / GAT). Velocity + survey penalty restores those as
# the natural top-N.
#
# Velocity floor of 0.5 years guards against same-year div-by-zero and
# absorbs preprint-vs-conference timing noise (paper dated 2026 but
# accessible since 2025).
_SEED_VELOCITY_AGE_FLOOR_YEARS = 0.5
# Survey detection — title-prefix patterns + colon-suffix patterns.
# "A Comprehensive Survey on Graph Neural Networks" → match
# "ResNet: A Brief Survey" → match (colon form)
# "Deep Residual Learning" → no match
_SURVEY_TITLE_RE = re.compile(
    r"""
    ^(?:[Aa]n?\s+)?                        # Optional "A " / "An "
    (?:Comprehensive\s+|Brief\s+|Short\s+|Recent\s+)?  # adjective
    (?:Survey|Review|Tutorial|Overview|Perspective|Roadmap|Primer)
    \b
    |
    \:\s*[Aa]\s+(?:Survey|Review|Tutorial|Overview)\b    # "Foo: A Survey"
    """,
    re.VERBOSE,
)
# Pure penalty multiplier — a survey at velocity=1000 effectively
# competes as if it had velocity=300, well below seminal works that
# typically clear 800+. Not 0 because some "Surveys" really are
# seminal (e.g. Goodfellow's GAN tutorial NeurIPS 2016 became *the*
# entry point for the field), so we soft-rank rather than drop.
_SURVEY_VELOCITY_PENALTY = 0.30

# ---- Theme-specific keyword blacklist (#209 Tier 1) ----
# Per-theme list of substrings to drop at the seed phase. Complements
# the theme-INDEPENDENT _is_implementation_foundation check (which
# drops Adam / SciPy / etc. for every theme); this file catches the
# long tail of cross-domain leakage where S2's `fieldsOfStudy=Math`
# accepts microbiome / clinical / homology modelling papers that
# share generic ML vocabulary. Curated from the 2026-05-27 audit.
_THEME_BLACKLIST_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "theme_blacklist.json"
)

# ---- GitHub stars enrichment ----
_GITHUB_CACHE_FILE = "github_stars.json"
_GITHUB_CACHE_TTL_DAYS = 7
# Default per-run lookup budget — the workflow has no need to resolve
# more than a couple of dozen repos per theme, and the GitHub Search
# API's unauthenticated quota is 30 req/min.
_GITHUB_DEFAULT_BUDGET = 80


def _is_trending(paper: dict, current_year: int) -> bool:
    """True when citation velocity (cites/year) clears the threshold AND
    the paper is recent enough that "trending" makes sense. ResNet has
    a high velocity too, but it's a 10-year-old classic — calling it
    trending dilutes the signal for genuinely hot 2024–2026 papers.
    """
    cit = paper.get("citationCount") or 0
    year = paper.get("year")
    if not isinstance(year, int) or year > current_year:
        return False
    age = current_year - year
    if age > _TRENDING_AGE_LIMIT_YEARS:
        return False
    # 0.5y floor guards against same-year div; widen to float deliberately.
    age_years: float = max(float(age), 0.5)
    return (cit / age_years) >= _TRENDING_VELOCITY_THRESHOLD


# Issue #53: heuristic templates that mirror build_deep_lineage's lenient
# fallback rationales. derive_relation() picks one based on S2's intent
# array so we get a non-empty rationale for free (the stage-4 'drop empty
# rationale' filter would otherwise silently kill every derived edge).
# Rationale strings are sourced from base.TEMPLATE_RATIONALES so the
# heuristic-emitted text matches the reject set used by
# RelationClassification.from_dict (#131 / #145 followup) — the two
# CANNOT drift.
_INTENT_RELATION_MAP: list[tuple[str, str, str]] = [
    # (intent name, relation enum, rationale template) — order matters:
    # methodology > result > background when an entry has multiple
    # intents, since methodology implies the citing paper actually built
    # on top of the referenced work.
    ("methodology", "extends", TEMPLATE_RATIONALES["extends_methodology"]),
    ("result", "successor", TEMPLATE_RATIONALES["successor_result"]),
    ("background", "baseline_only", TEMPLATE_RATIONALES["baseline_only_background"]),
]
_DERIVED_CONFIDENCE = 0.7  # constant — heuristic, not LLM probability

# Minimum LLM confidence to keep an edge (#209). Below this, the LLM
# itself is signalling that the relation is weak; emitting it as a
# styled arrow misleads the reader. Threshold chosen at 0.4 so a "low
# but real" 0.5 still passes (the LLM has actually read both abstracts
# and judged a connection), while a tentative 0.3 is dropped. This
# only applies when classify_relation() returned a real result — LLM
# hiccups (None) still fall back to the heuristic at the merge step.
_MIN_LLM_CONFIDENCE = 0.4

# ---- #209 Phase J: unarXive citation-context classifier ----
# Pattern table for the S2-free regex classifier. When the BFS layer
# attaches `_contexts` (citation paragraphs from unarXive 2022) to an
# edge, ``_classify_from_contexts`` scans these patterns in priority
# order and the first match wins. The matched paragraph becomes the
# edge rationale verbatim (trimmed to _MAX_CONTEXT_RATIONALE_LEN),
# the relation enum + confidence come from the pattern entry.
#
# Why patterns, not an LLM: the citing sentence itself is direct
# evidence. "we extend [12]" is more reliable than asking an LLM
# "what's the relation between these two papers" with no context.
# Patterns also keep cost at ¥0 — no API call per edge.
#
# Priority order matters because some sentences match multiple
# patterns (e.g. "we extend [X], outperforming the baseline" matches
# both extends and supersedes — supersedes wins).
_MAX_CONTEXT_RATIONALE_LEN = 280
_CITATION_CONTEXT_PATTERNS: list[tuple[str, float, list[re.Pattern[str]]]] = [
    (
        "supersedes",
        0.88,
        [
            re.compile(r"\boutperform(s|ed|ing)?\b", re.IGNORECASE),
            re.compile(r"\bsupersed(es|ed|e)\b", re.IGNORECASE),
            re.compile(r"\bsurpass(es|ed|ing)?\b", re.IGNORECASE),
            re.compile(
                r"\bnew\s+state[\s\-]of[\s\-]the[\s\-]art\b", re.IGNORECASE
            ),
            re.compile(r"\bachiev(es|ed|ing)\s+sota\b", re.IGNORECASE),
        ],
    ),
    (
        "contrasts",
        0.86,
        [
            re.compile(r"\bunlike\b", re.IGNORECASE),
            re.compile(r"\bin\s+contrast\s+to\b", re.IGNORECASE),
            re.compile(r"\bdiffer(s|ent)?\s+from\b", re.IGNORECASE),
            re.compile(r"\bas\s+opposed\s+to\b", re.IGNORECASE),
        ],
    ),
    (
        "extends",
        0.84,
        [
            re.compile(r"\bbuild(s|ing)?\s+(on|upon)\b", re.IGNORECASE),
            re.compile(r"\bextend(s|ing|ed)?\b", re.IGNORECASE),
            # Tightened (#222 review MEDIUM): plain "based on" matched
            # background sentences ("evaluated based on F1 score") and
            # bibliographic introductions ("Based on previous work
            # by [12]…"). Require a self-referential subject ("our X",
            # "this X") so the phrase only fires when the CITING paper
            # claims to build on the cited one.
            re.compile(
                r"\b(?:our|this)\s+(?:model|method|approach|work|paper|system|framework|architecture)\s+is\s+based\s+on\b",
                re.IGNORECASE,
            ),
            re.compile(r"\bfollowing\s+\[?", re.IGNORECASE),
            re.compile(r"\bimprov(e|es|ing|ed)\s+(on|upon)\b", re.IGNORECASE),
            re.compile(r"\binspired\s+by\b", re.IGNORECASE),
            re.compile(r"\badapt(s|ed|ing)?\s+from\b", re.IGNORECASE),
        ],
    ),
    (
        "ablation",
        0.82,
        [
            re.compile(r"\bablation\b", re.IGNORECASE),
            re.compile(r"\bablate(s|d|ing)?\b", re.IGNORECASE),
        ],
    ),
    (
        "baseline_only",
        0.78,
        [
            re.compile(r"\bas\s+a\s+baseline\b", re.IGNORECASE),
            re.compile(r"\bbaseline(s)?\b", re.IGNORECASE),
            re.compile(r"\bcompare(d|s)?\s+(to|with|against)\b", re.IGNORECASE),
            re.compile(r"\bcomparison\s+(to|with|against)\b", re.IGNORECASE),
        ],
    ),
    (
        "successor",
        0.75,
        [
            re.compile(r"\bsubsequent\s+work\b", re.IGNORECASE),
            re.compile(r"\bsuccessor\b", re.IGNORECASE),
            re.compile(r"\bfollow[\-\s]?up\b", re.IGNORECASE),
        ],
    ),
]


def _classify_from_contexts(
    contexts: list[str] | None,
) -> dict[str, Any] | None:
    """Match citation-paragraph text against the relation pattern
    table. First match wins (priority order: supersedes > contrasts >
    extends > ablation > baseline_only > successor).

    Returns ``{relation, confidence, rationale}`` where ``rationale``
    is the matched paragraph trimmed to ``_MAX_CONTEXT_RATIONALE_LEN``
    chars. ``None`` if no context provided or no pattern fires —
    callers (``derive_relation``) fall through to the intent-map /
    year-cite heuristic.

    Multiple contexts: scan each in turn under the same pattern; once
    any context matches a higher-priority pattern, return immediately.
    This lets the strongest single piece of evidence win even when
    other paragraphs would land on weaker relations.
    """
    if not contexts or not isinstance(contexts, list):
        return None
    for relation, confidence, patterns in _CITATION_CONTEXT_PATTERNS:
        for ctx in contexts:
            if not isinstance(ctx, str) or not ctx.strip():
                continue
            for pattern in patterns:
                if pattern.search(ctx):
                    rationale = ctx.strip()
                    if len(rationale) > _MAX_CONTEXT_RATIONALE_LEN:
                        rationale = (
                            rationale[: _MAX_CONTEXT_RATIONALE_LEN - 1] + "…"
                        )
                    return {
                        "relation": relation,
                        "confidence": confidence,
                        "rationale": rationale,
                    }
    return None


def _add_cross_node_edges(
    nodes: dict[str, dict],
    edges: list[dict],
    *,
    seed_ids: set[str] | None = None,
    cohort_min_year: int | None = None,
    provider: AbstractLLMProvider | None = None,
    strict_mode: str = "off",
) -> int:
    """Find citation links between nodes already in the graph.

    Issue #54 / #55: BFS only emits (parent → seed) edges, but the
    collected node set frequently contains intra-cohort citations — e.g.
    one 2024 paper citing another 2024 paper that's also a seed, or two
    parents where one cites the other.

    Issue #55 followup: when `seed_ids` and/or `cohort_min_year` are
    given, only emit edges where at least one endpoint is a seed *or* a
    paper from the requested cohort year. This stops foundational papers
    (ResNet ↔ U-Net) from polluting the view with many old-year arrows
    the user didn't ask for.

    Returns the number of edges added.
    """
    existing = {(e["src"], e["dst"]) for e in edges}
    node_ids = set(nodes.keys())
    seed_ids = seed_ids or set()
    added = 0

    def _is_anchor(nid: str) -> bool:
        if nid in seed_ids:
            return True
        if cohort_min_year is None:
            return True  # no constraint configured → accept all
        year = nodes.get(nid, {}).get("year")
        return isinstance(year, int) and year >= cohort_min_year

    for citing_id in list(node_ids):
        try:
            refs = fetch_related(citing_id, "references", _CROSS_NODE_LIMIT)
        except Exception as exc:  # pragma: no cover - S2 fail-safe
            logger.warning("cross-node: fetch_related failed for %s: %s", citing_id, exc)
            continue
        for ref in refs:
            ref_id = ref.get("paperId")
            if ref_id not in node_ids:
                continue
            if ref_id == citing_id:
                # S2 occasionally lists a paper among its own references
                # (data anomaly); a self-loop in the chronological tree
                # would render as a degenerate edge.
                continue
            # Anchor constraint: at least one endpoint must be a seed or
            # a cohort-year paper. Skip pure ancestor↔ancestor edges.
            if not (_is_anchor(citing_id) or _is_anchor(ref_id)):
                continue
            # Edge convention is parent → child. References = ancestors;
            # cited paper is the parent (= ref), citing paper is the
            # child (= node already in graph).
            edge_key = (ref_id, citing_id)
            if edge_key in existing:
                continue
            citing_node = nodes.get(citing_id)
            cls = derive_relation(
                ref, parent=ref, child=citing_node,
                provider=provider, strict_mode=strict_mode,
            )
            if cls is None:
                continue
            edges.append({
                "src": ref_id,
                "dst": citing_id,
                "rel": cls["relation"],
                "conf": cls["confidence"],
                "rationale": cls["rationale"],
            })
            existing.add(edge_key)
            added += 1
    return added


class _CachedClassifyProvider(AbstractLLMProvider):
    """Decorate an LLM provider so classify_relation() hits a shared
    persistent cache keyed by ``f"{a.paperId}->{b.paperId}"`` first.

    Why this exists (#131-followup): theme rebuilds on the free Groq
    tier were re-querying the LLM for every edge in every run. With the
    shared cache from build_lineage.py wired in, the SECOND build of a
    given theme — and any cross-theme overlap — is served from disk at
    zero LLM cost. The cache is a plain dict on disk so it composes with
    the existing build_lineage flow without further coordination.

    Behaviour matches build_lineage.py's ``_classify_cached``:
      * Hit: deserialize through ``RelationClassification.from_dict``
        (which now also rejects #131 template echoes — those entries
        fall back to the heuristic via _apply_llm_classification).
      * Miss with successful inner call: store + persist atomically.
      * Miss with inner returning None (LLM throttle / parse error):
        do NOT poison the cache — let the next attempt retry the LLM.
      * Missing paperIds on either side: skip cache entirely (defensive
        — the theme pipeline always populates paperIds, but a regression
        elsewhere shouldn't silently cache an empty key).

    Wraps any AbstractLLMProvider; evaluate_batch is delegated through
    unchanged because the cache only meaningfully applies to per-edge
    classify_relation calls.
    """

    def __init__(
        self,
        inner: AbstractLLMProvider,
        cache: dict[str, dict],
        *,
        cache_path: Path | None,
    ) -> None:
        # We deliberately do NOT call super().__init__() because
        # AbstractLLMProvider sets a bunch of config-derived state we
        # don't need (timeout, batch_size etc.) — the inner provider
        # already owns those. Set the class-level `name` and `enabled`
        # attributes directly so they're plain attributes (matching the
        # base's declared shape) rather than properties (which mypy
        # rejects as an override mismatch).
        self.name = f"{inner.name}+cache"
        self.enabled = bool(getattr(inner, "enabled", True))
        self._inner = inner
        self._cache = cache
        self._cache_path = cache_path

    def evaluate_batch(self, papers, profile):  # pragma: no cover - delegated
        return self._inner.evaluate_batch(papers, profile)

    def classify_relation(
        self, a: dict, b: dict
    ) -> RelationClassification | None:
        a_id = a.get("paperId") if isinstance(a, dict) else None
        b_id = b.get("paperId") if isinstance(b, dict) else None
        if not (isinstance(a_id, str) and a_id and isinstance(b_id, str) and b_id):
            # Defensive: defer to inner provider but do NOT cache.
            return self._inner.classify_relation(a, b)
        key = f"{a_id}->{b_id}"
        cached = self._cache.get(key)
        if cached is not None:
            return RelationClassification.from_dict(cached)
        rc = self._inner.classify_relation(a, b)
        if rc is not None:
            self._cache[key] = {
                "relation": rc.relation,
                "confidence": rc.confidence,
                "rationale": rc.rationale,
            }
            # Persist only when the parent directory exists. Tests that
            # don't care about on-disk state point the path at a stub
            # like /nonexistent/... — silently skipping persist keeps
            # the in-memory cache intact for the rest of the run.
            if (
                self._cache_path is not None
                and self._cache_path.parent.exists()
            ):
                try:
                    persist_classifications(self._cache, self._cache_path)
                except OSError as exc:
                    logger.warning(
                        "classifications cache persist failed (%s) — "
                        "in-memory state still consistent",
                        exc,
                    )
        return rc


def _load_classification_cache(
    cache_path: Path,
) -> dict[str, dict]:
    """Load the shared classifications cache from disk; return ``{}`` on
    missing or malformed file. Mirrors the bootstrap snippet in
    build_lineage.py so callers don't reimplement the same guards."""
    if not cache_path.exists():
        return {}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(
            "classifications cache at %s unreadable (%s) — starting empty",
            cache_path, exc,
        )
        return {}
    return data if isinstance(data, dict) else {}


def _wrap_provider_with_cache(
    inner: AbstractLLMProvider,
) -> tuple[_CachedClassifyProvider, dict[str, dict]]:
    """Wrap ``inner`` with the shared classification cache so theme
    rebuilds reuse classified (parent, child) pairs at zero LLM cost.

    Returns ``(wrapped_provider, loaded_cache)`` so the caller can log
    the entry count without reaching into the wrapper's internals.
    The cache path is the module-level ``_CLASSIFICATION_CACHE_PATH``
    constant so tests can monkeypatch it.
    """
    cache = _load_classification_cache(_CLASSIFICATION_CACHE_PATH)
    return (
        _CachedClassifyProvider(
            inner, cache, cache_path=_CLASSIFICATION_CACHE_PATH
        ),
        cache,
    )


def derive_relation(
    intent_record: dict,
    *,
    parent: dict | None = None,
    child: dict | None = None,
    provider: AbstractLLMProvider | None = None,
    strict_mode: str = "off",
) -> dict | None:
    """Classify how the cited paper relates to the citing paper.

    Heuristic path (S2 intents + year/citation contrast) is the default,
    matching the LLM-free post-#54 behavior. When ``strict_mode`` is
    ``"ambiguous"`` or ``"all"``, the result of the heuristic is then
    refined by a real LLM classification via ``provider.classify_relation``.

    Modes:
      * ``"off"``       (default): heuristic only. ``provider`` is ignored
        even if supplied — Phase 0c compat.
      * ``"ambiguous"`` : LLM is called only when S2 intents do not pick
        a key in ``_INTENT_RELATION_MAP`` (= the heuristic fell through
        to year/citation or the default rule).
      * ``"all"``       : LLM is called on every influential edge.
        Cost warning: a wide graph (e.g. seeds=8, width=8, depth=2) can
        produce a few hundred calls/run; depth 3+ can exceed 1000. On
        Groq this is throttled via 429s (we fall back to heuristic);
        on Claude/Gemini paid plans the operator bears the cost. Follow-up
        issue #119 will add an explicit per-run cap. Use ``"ambiguous"``
        unless you have a budget cap in place.

    Direction conventions are unchanged from the pre-Step 1 contract:
      * BFS (references): parent = intent_record, child = citing paper.
      * Descendants: parent = seed, child = intent_record.
      * Cross-node: parent = intent_record (cited), child = citing node.

    Returns ``None`` when S2 flagged the citation as non-influential,
    when neither the heuristic nor the LLM produced an edge, or when
    the LLM judges the relation as ``unrelated`` / low-confidence.

    LLM-call failure (provider returns ``None``) falls back to the
    heuristic edge IF the heuristic had real signal — we never silently
    drop a methodology-intent edge because Groq hiccupped. But when the
    heuristic itself had no signal (no S2 intent + no year/cite
    contrast), we no longer fabricate an "extends" template (#209): we
    either invoke the LLM in strict modes, or drop the edge entirely.
    """
    # _is_influential=False is an explicit drop signal from S2 — never
    # spend an LLM call on a citation we'd discard anyway.
    if intent_record.get("_is_influential") is False:
        return None

    # #209 Phase J: try unarXive citation contexts FIRST — these are
    # actual sentences the citing paper wrote about the cited paper
    # (paper-specific, evidence-based, no LLM cost). When a pattern
    # match fires, the matched paragraph becomes the edge rationale
    # verbatim and we skip every downstream heuristic.
    context_edge = _classify_from_contexts(intent_record.get("_contexts"))
    if context_edge is not None:
        return context_edge

    heuristic = _derive_relation_heuristic(intent_record, parent=parent, child=child)

    if heuristic is None:
        # Pre-#209: this path fabricated _DEFAULT_DERIVED ("extends"
        # template). The audit found 1222/1304 (93.7%) of published
        # edges came from this fallback — pure noise. Now we only emit
        # an edge if the LLM produces one; otherwise drop.
        if strict_mode == "off" or provider is None:
            return None
        llm_result = provider.classify_relation(parent or {}, child or {})
        return _build_edge_from_llm(llm_result)

    if strict_mode == "off" or provider is None:
        return heuristic
    if strict_mode == "ambiguous" and not _is_ambiguous(intent_record):
        return heuristic
    llm_result = provider.classify_relation(parent or {}, child or {})
    return _apply_llm_classification(heuristic, llm_result)


def _derive_relation_heuristic(
    intent_record: dict,
    *,
    parent: dict | None = None,
    child: dict | None = None,
) -> dict | None:
    """Heuristic LLM-free classifier — extracted from derive_relation in
    Phase A Step 1 so the public ``derive_relation`` can compose the
    heuristic with an optional LLM pass.

    Returns ``None`` when there is no real signal (no matching S2
    intent and no year/cite contrast trigger). Pre-#209 this path
    fabricated an "extends" template; the audit found that fallback
    was the source of 93.7% of published edges (1222/1304) and the
    main reason the lineage view felt junk. ``derive_relation`` now
    treats ``None`` as "let LLM decide; drop if it can't".

    The ``_is_influential`` check has moved up to ``derive_relation``
    so callers that bypass this helper still get the same drop.
    """
    intents = intent_record.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    for keyword, relation, rationale in _INTENT_RELATION_MAP:
        if keyword in intents_set:
            return _make_derived(relation, rationale)

    # No matching intent — try year + citation contrast.
    if parent is not None and child is not None:
        py = parent.get("year")
        cy = child.get("year")
        pc = parent.get("citationCount") or parent.get("citation_count") or 0
        cc = child.get("citationCount") or child.get("citation_count") or 0
        if isinstance(py, int) and isinstance(cy, int):
            delta = cy - py
            if delta >= 3 and pc > 100 and cc >= pc * 1.5:
                return _make_derived(
                    "supersedes",
                    TEMPLATE_RATIONALES["supersedes_year_cite"],
                )
            if delta <= 1 and pc > 100 and 0.5 <= cc / max(pc, 1) <= 2.0:
                return _make_derived(
                    "contrasts",
                    TEMPLATE_RATIONALES["contrasts_year_cite"],
                )
            if delta <= 2 and cc < 100 and pc > 1000:
                return _make_derived(
                    "ablation",
                    TEMPLATE_RATIONALES["ablation_year_cite"],
                )
            if 1 <= delta <= 5:
                return _make_derived(
                    "successor",
                    TEMPLATE_RATIONALES["successor_result"],
                )
    return None


def _is_ambiguous(intent_record: dict) -> bool:
    """True iff S2 intents fail to pick a key in ``_INTENT_RELATION_MAP``.

    Gating predicate for ``--llm-strict=ambiguous``: edges whose intent
    set matches a known key are kept on the cheap heuristic path; the
    rest get the LLM treatment. Phase A Step 1 / CRITICAL C7.
    """
    intents = intent_record.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    return all(keyword not in intents_set for keyword, _, _ in _INTENT_RELATION_MAP)


_TEMPLATE_RATIONALES_SET: frozenset[str] = frozenset(TEMPLATE_RATIONALES.values())


def _apply_llm_classification(
    heuristic: dict, llm_result: RelationClassification | None
) -> dict | None:
    """Merge an LLM classification into an existing heuristic edge.

    Decision matrix (#118 / #209 / 2026-06-05 followup):
      * ``llm_result is None`` AND heuristic rationale IS a template
        from ``TEMPLATE_RATIONALES``                  → drop the edge.
        The template adds zero signal to the viewer (it reads
        identically across hundreds of edges) and inflates the
        lineage's template_ratio without telling the user anything
        about *why* the two papers are linked. With the LLM unable
        to provide a paper-specific rationale, the honest move is
        no edge at all. See the 2026-06-05 quality investigation
        for the data — 14 of 21 themes were >= 95 % template-rationale
        because this branch used to keep them.
      * ``llm_result is None`` AND heuristic rationale is paper-
        specific (Phase J unarXive context, etc.)    → keep heuristic.
        Phase J already gave us a citing-sentence excerpt; the LLM
        was just an optional refinement step.
      * ``relation == "unrelated"``                   → drop the edge
        (LLM positively rejects the relation).
      * ``llm_result.confidence < threshold``         → drop the edge
        (LLM has read both abstracts and judged the connection weak;
        the heuristic's 0.7 confidence is an artefact, not a signal —
        trusting it over the LLM's own assessment misleads the user).
      * otherwise                                     → use LLM verbatim
        (#209: was max(heuristic, llm) — pinning conf to 0.7 floor
        hid the LLM's own uncertainty signal).

    Why rationale must come from the LLM (or Phase J) when kept: a
    heuristic-template rationale reads the same across every edge it
    decorates ("論文 B は論文 A の研究ラインを継承し自然に発展さ
    せている。" hit 27 / 41 edges of Mixture of Experts), so it tells
    the reader nothing specific about A → B. The from_dict
    template-echo reject (#131) means an LLM-supplied template would
    have already been turned into ``None`` by RelationClassification,
    so reaching this point with a non-None llm_result means the
    rationale is paper-specific.
    """
    if llm_result is None:
        heuristic_rationale = (heuristic.get("rationale") or "").strip()
        if heuristic_rationale in _TEMPLATE_RATIONALES_SET:
            return None
        return heuristic
    if llm_result.relation == "unrelated":
        return None
    if float(llm_result.confidence) < _MIN_LLM_CONFIDENCE:
        return None
    return {
        "relation": llm_result.relation,
        "confidence": float(llm_result.confidence),
        "rationale": llm_result.rationale,
    }


def _build_edge_from_llm(
    llm_result: RelationClassification | None,
) -> dict | None:
    """Build an edge dict from an LLM-only classification.

    Used by ``derive_relation`` when the heuristic produced no signal
    (#209). Distinct from ``_apply_llm_classification`` because there
    is no heuristic to fall back to — if the LLM didn't produce a
    confident, non-unrelated result, the edge is dropped entirely.

    Same thresholds as the merge path: ``unrelated`` and confidence
    below ``_MIN_LLM_CONFIDENCE`` both yield ``None``.
    """
    if llm_result is None:
        return None
    if llm_result.relation == "unrelated":
        return None
    if float(llm_result.confidence) < _MIN_LLM_CONFIDENCE:
        return None
    return {
        "relation": llm_result.relation,
        "confidence": float(llm_result.confidence),
        "rationale": llm_result.rationale,
    }


def _make_derived(relation: str, rationale: str) -> dict:
    return {
        "relation": relation,
        "confidence": _DERIVED_CONFIDENCE,
        "rationale": rationale,
    }


# ---------- Theme input ----------


def sanitize_theme(theme: str) -> str:
    """Strip control characters, trim whitespace, validate length.

    Why: ``--theme`` is free-form text that flows into the LLM prompt
    (``expand_keywords``), the S2 query string, and (after slug
    derivation) the filesystem path / URL param. Control chars enable
    prompt-injection tricks like fake instruction breaks; very long
    inputs trigger slow / 414-rejected S2 queries with noisy retries.

    Raises:
        ValueError: input is empty / whitespace-only after stripping
        control characters, or exceeds ``_THEME_MAX_LEN``.
    """
    if not theme:
        raise ValueError("theme must be non-empty")
    cleaned = "".join(c for c in theme if unicodedata.category(c)[0] != "C")
    cleaned = cleaned.strip()
    if not cleaned:
        raise ValueError("theme is empty after stripping control chars / whitespace")
    if len(cleaned) > _THEME_MAX_LEN:
        raise ValueError(
            f"theme exceeds {_THEME_MAX_LEN} chars (got {len(cleaned)})"
        )
    return cleaned


# ---------- Seed discovery ----------


def _seed_cache_path(keyword: str, since_year: int | None) -> Path:
    """Stable cache filename for a (keyword, since_year) pair.

    Uses a short SHA-1 prefix instead of slugifying the keyword so
    near-duplicates that collapse to the same slug stay distinct, and
    the filename is filesystem-safe regardless of unicode in the
    keyword.
    """
    digest = hashlib.sha1(keyword.lower().strip().encode("utf-8")).hexdigest()[:12]
    suffix = f"y{since_year}" if since_year is not None else "yany"
    return CACHE_DIR / f"search_{digest}_{suffix}.json"


def _decode_abstract_inverted_index(inverted: object) -> str:
    """Reconstruct an abstract from OpenAlex's ``abstract_inverted_index``.

    OpenAlex licences abstracts in inverted form: ``{word: [positions, ...]}``
    instead of a single string, so the API response stays compact even
    for long abstracts. Walk every (word, position) pair to recover the
    original sentence-ordered text. Missing positions in the resulting
    sparse map are filled with an empty string so consecutive words still
    join with a single space.

    Returns the empty string when the input is missing, malformed, or
    yields no positions — callers treat empty as "no abstract" and fall
    through gracefully.
    """
    if not isinstance(inverted, dict):
        return ""
    by_position: dict[int, str] = {}
    for word, positions in inverted.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            continue
        for pos in positions:
            if isinstance(pos, int) and pos >= 0:
                by_position[pos] = word
    if not by_position:
        return ""
    max_pos = max(by_position.keys())
    return " ".join(by_position.get(i, "") for i in range(max_pos + 1)).strip()


def _openalex_short_id(work_url_or_id: str) -> str | None:
    """Extract the ``W...`` short ID from an OpenAlex Work URL or id.

    OpenAlex returns IDs in two shapes:
      * full URL: ``https://openalex.org/W2962917714``
      * short:    ``W2962917714``

    Anywhere we use the ID as a primary key, we want the short form.
    Returns None for non-string / malformed inputs.
    """
    if not isinstance(work_url_or_id, str) or not work_url_or_id:
        return None
    tail = work_url_or_id.rsplit("/", 1)[-1].strip()
    return tail if tail.startswith("W") else None


# Prefix that marks a paper dict whose ``paperId`` came from OpenAlex
# rather than S2. fetch_related (build_lineage.py) routes BFS calls by
# checking this prefix — papers with S2 hash IDs hit the S2 endpoints
# as before; ``openalex:W...`` papers route to OpenAlex's referenced_works
# / cites filter so the lineage can be built without any S2 access.
_OPENALEX_PAPER_ID_PREFIX = "openalex:"


def _work_to_paper_dict(work: dict) -> dict[str, Any] | None:
    """Convert an OpenAlex ``/works`` payload to an S2-shape paper dict.

    The returned dict is compatible with the rest of the lineage pipeline
    (``_filter_topic_relevant_seeds``, ``_rank_and_truncate``, BFS via
    ``fetch_related``) so callers can use OpenAlex Works as a drop-in
    replacement for S2 search results.

    ``paperId`` is set to ``f"openalex:{short_id}"`` (e.g.
    ``"openalex:W2962917714"``). The ``openalex:`` prefix tells
    ``fetch_related`` to dispatch to the OpenAlex BFS path; S2 doesn't
    recognise these IDs so we must never let one leak into an S2 call.

    Fields not provided by OpenAlex (``_intents``, ``_is_influential``,
    ``_contexts``) are not set here — they're populated by ``fetch_related``
    when it builds the parent/child edge records. For seed-only use, the
    intent map gracefully falls through to year/cite contrast.

    Returns ``None`` when the Work is missing an OpenAlex ID, has no
    title, or is otherwise unusable. Callers filter ``None`` out.
    """
    short = _openalex_short_id(work.get("id") or "")
    if not short:
        return None
    title = work.get("title") or work.get("display_name") or ""
    if not title:
        return None

    doi = _extract_doi(work) or ""
    external_ids: dict[str, str] = {"OpenAlex": short}
    if doi:
        external_ids["DOI"] = doi
    # Pull out arxiv / mag / pmid if present so downstream code that
    # checks externalIds.ArXiv (e.g. arXiv-category gate work) keeps
    # working unchanged.
    ids_block = work.get("ids") or {}
    for k_oa, k_out in [
        ("arxiv_id", "ArXiv"),
        ("mag", "MAG"),
        ("pmid", "PMID"),
    ]:
        v = ids_block.get(k_oa)
        if isinstance(v, str) and v.strip():
            external_ids[k_out] = v.strip()

    abstract = _decode_abstract_inverted_index(
        work.get("abstract_inverted_index")
    )
    primary_location = work.get("primary_location") or {}
    source = primary_location.get("source") or {}
    venue = source.get("display_name") or ""

    authors: list[dict[str, str]] = []
    for authorship in work.get("authorships") or []:
        if not isinstance(authorship, dict):
            continue
        author = authorship.get("author") or {}
        name = author.get("display_name") or ""
        if isinstance(name, str) and name.strip():
            authors.append({"name": name.strip()})

    return {
        "paperId": f"{_OPENALEX_PAPER_ID_PREFIX}{short}",
        "title": title,
        "year": work.get("publication_year"),
        "venue": venue,
        "citationCount": int(work.get("cited_by_count") or 0),
        "abstract": abstract,
        "authors": authors,
        "externalIds": external_ids,
    }


def _extract_doi(work: dict) -> str | None:
    """Pull the bare DOI (no URL prefix) out of an OpenAlex Work dict.

    OpenAlex returns DOIs as full URLs (``https://doi.org/10.x/y``) in
    both the top-level ``doi`` field and ``ids.doi``. Older records
    occasionally carry ``http://`` or ``dx.doi.org`` host variants.
    S2's ``/paper/batch`` expects the prefix ``DOI:10.x/y`` — passing
    the URL form yields a "No valid paper ids given" parser error
    (verified in branch commit history). Use ``urlparse`` so all
    scheme/host variants collapse to the bare DOI; if the input
    already arrives as a bare DOI (no scheme) it passes through.
    """
    raw = work.get("doi") or (work.get("ids") or {}).get("doi")
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    # When the input is a doi.org URL (any scheme/case variant), pull the
    # path. Bare DOI ("10.x/y") or non-doi.org URLs pass through — S2
    # rejects truly malformed values downstream.
    bare = (
        parsed.path.lstrip("/")
        if parsed.scheme and parsed.netloc.lower() in _DOI_HOSTS
        else raw
    )
    bare = bare.strip()
    return bare or None


def discover_seeds_via_openalex(
    *,
    query: str,
    top_n: int,
    since_year: int | None,
    email: str | None = None,
) -> list[dict[str, Any]]:
    """Search OpenAlex ``/works`` for the theme; return raw Work dicts.

    OpenAlex is the primary fallback when S2 ``/paper/search`` throttles
    on shared CI runner IPs — its rate budget is independent and far
    more permissive (10 req/sec free, 100k/day in the polite pool).
    Returned works carry DOIs which the caller resolves through S2
    ``/paper/batch`` to obtain S2-shape paper dicts that the rest of
    the pipeline (BFS, classification) can consume unchanged.

    The ``mailto`` polite-pool query param is sent when ``email`` is
    provided. OpenAlex puts polite-pool requests on a separate, more
    reliable queue under load — required for batch CI runs.

    Returns ``[]`` on any error (None response / non-200 / parse fail)
    so callers degrade gracefully instead of crashing the pipeline.
    """
    if not query or not query.strip():
        return []
    # Pull a wider page than top_n so dedup against any S2 hits still
    # leaves headroom; the pipeline truncates to top_n at the end.
    page_size = max(top_n * 3, 25)
    page_size = min(page_size, _OPENALEX_PER_PAGE_MAX)

    # IMPORTANT (#209 Phase 1.5): don't override sort. OpenAlex's default
    # is relevance_score:desc (BM25 over title + abstract). The pre-
    # 2026-05-28 override of `sort=cited_by_count:desc` was a bug carried
    # over from the S2-fallback days — it returned the highest-cited
    # papers MATCHING the query regardless of relevance. For ambiguous
    # theme names ("Chain of Thought" → bioinformatics + crystallography
    # papers; "World Model" → climate / economics papers) the downstream
    # filter dropped 100% of candidates, leaving 0 seeds. Verified by
    # manual curl on 2026-05-28: with sort removed, the same query
    # returns the Wei et al. Chain-of-Thought paper at #2.
    #
    # _rank_and_truncate re-orders the relevance-ranked pool by velocity
    # to apply our seminal-over-survey preference for the final top-N.
    params: dict[str, Any] = {
        "search": query,
        "per-page": page_size,
    }
    # OpenAlex topic-taxonomy gate (#209 Phase 1.5 / 2026-05-28).
    # Uses the 2024 topics hierarchy `primary_topic.field.id` rather
    # than the legacy `concepts.id` multi-label score graph.
    #
    # field 17 = Computer Science (stable OpenAlex field ID, see
    # https://api.openalex.org/fields/17).
    #
    # Why moved from concepts.id: the legacy concepts taxonomy is
    # multi-label — each paper carries many concepts with scores. The
    # filter `concepts.id:C41008148|C33923547|C137293760` (CS|Math|
    # Linguistics) matched any paper carrying ANY of those concepts at
    # any score. "Planck 2018 results" (cosmology, field=Physics) had a
    # level-0 Mathematics concept at score 0.23 — enough to match
    # `C33923547` — and surfaced as a State Space Model seed. New 2024
    # topics taxonomy is single-label: only papers whose primary_topic's
    # field IS Computer Science pass. Verified by manual curl 2026-05-28
    # that Planck cosmology papers are excluded.
    #
    # Trade-off: a pure-math paper whose primary_topic.field is
    # "Mathematics" (e.g. some optimization-theory work) would be
    # dropped even if it's relevant to an ML theme. Acceptable for AI/ML
    # lineage; revisit if a Math-heavy theme regresses.
    concept_filter = "primary_topic.field.id:fields/17"
    if since_year is not None:
        params["filter"] = (
            f"from_publication_date:{since_year}-01-01,{concept_filter}"
        )
    else:
        params["filter"] = concept_filter
    if email:
        params["mailto"] = email

    resp = request_with_retry(
        "GET",
        _OPENALEX_WORKS_URL,
        params=params,
        headers={"User-Agent": "PaperPilot/0.1"},
        timeout=20,
    )
    if resp is None or resp.status_code != 200:
        logger.warning(
            "openalex search failed (status=%s) — fallback contributes 0 seeds",
            getattr(resp, "status_code", None),
        )
        return []
    try:
        payload = resp.json()
    except ValueError as exc:
        logger.warning("openalex JSON parse failed: %s", exc)
        return []
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        return []
    return [w for w in results if isinstance(w, dict)]


def _fetch_openalex_works_by_ids(
    short_ids: list[str], *, email: str | None = None
) -> list[dict[str, Any]]:
    """Batch-fetch OpenAlex Works by short ID via the ``filter=openalex:W1|W2``
    parameter. Returns S2-shape paper dicts (via ``_work_to_paper_dict``).

    OpenAlex's filter pipeline accepts up to ~100 IDs per request; we
    chunk above that to stay safely inside the limit. Failed pages
    contribute zero (graceful degrade). Order is not preserved — the
    BFS layer already de-duplicates and re-ranks.
    """
    cleaned: list[str] = [
        sid for sid in short_ids
        if isinstance(sid, str) and sid.startswith("W")
    ]
    if not cleaned:
        return []
    results: list[dict[str, Any]] = []
    chunk_size = 50
    for i in range(0, len(cleaned), chunk_size):
        chunk = cleaned[i : i + chunk_size]
        params: dict[str, Any] = {
            "filter": f"openalex:{'|'.join(chunk)}",
            "per-page": len(chunk),
        }
        if email:
            params["mailto"] = email
        resp = request_with_retry(
            "GET",
            _OPENALEX_WORKS_URL,
            params=params,
            headers={"User-Agent": "PaperPilot/0.1"},
            timeout=20,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "openalex batch fetch failed (status=%s, chunk=%d ids)",
                getattr(resp, "status_code", None), len(chunk),
            )
            continue
        try:
            payload = resp.json()
        except ValueError:
            continue
        works = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(works, list):
            continue
        for work in works:
            if not isinstance(work, dict):
                continue
            paper = _work_to_paper_dict(work)
            if paper is not None:
                results.append(paper)
    return results


def _enrich_parent_with_unarxive(
    parent: dict[str, Any], *, citing_arxiv_id: str
) -> dict[str, Any]:
    """Attach citing-side citation contexts for the ``references``
    BFS direction: focal cites ``parent``, so the unarXive lookup is
    ``(citing=focal.arxiv_id, cited=parent.openalex_id)``.

    Split from ``_enrich_child_with_unarxive`` (#222 review HIGH-1)
    because the two BFS directions take parameters of completely
    different shape (arXiv id vs OpenAlex id), and overloading one
    parameter to mean both was misleading.

    Mutates ``parent`` in place (sets ``_contexts``) and returns it
    for convenience chaining. Silent on missing arXiv id / missing
    DuckDB / no match — caller treats empty contexts as "fall through
    to heuristic" downstream.
    """
    from paperpilot.utils import unarxive

    parent.setdefault("_contexts", [])
    ctxs = unarxive.fetch_contexts(
        child_arxiv_id=citing_arxiv_id,
        parent_openalex_id=parent.get("paperId") or "",
    )
    if ctxs:
        parent["_contexts"] = ctxs
    return parent


def _enrich_child_with_unarxive(
    child: dict[str, Any], *, cited_openalex_id: str
) -> dict[str, Any]:
    """Attach citing-side citation contexts for the ``citations`` BFS
    direction: ``child`` cites focal, so the unarXive lookup is
    ``(citing=child.arxiv_id, cited=focal.openalex_id)``.

    Mirror of ``_enrich_parent_with_unarxive`` — the two are split
    rather than unified because the parameter semantics flip between
    BFS directions (#222 review HIGH-1).

    The child's arXiv id is read from ``child['externalIds']['ArXiv']``
    which OpenAlex returns when the cited paper has an arXiv preprint.
    Papers without arXiv preprints (journal-only) skip the lookup
    silently and fall through to the heuristic.
    """
    from paperpilot.utils import unarxive

    child.setdefault("_contexts", [])
    child_arxiv = (child.get("externalIds") or {}).get("ArXiv")
    ctxs = unarxive.fetch_contexts(
        child_arxiv_id=child_arxiv,
        parent_openalex_id=cited_openalex_id,
    )
    if ctxs:
        child["_contexts"] = ctxs
    return child


def fetch_related_via_openalex(
    openalex_short_id: str,
    kind: str,
    limit: int,
    *,
    email: str | None = None,
) -> list[dict[str, Any]]:
    """OpenAlex BFS — return parent/child papers for a given Work.

    Mirrors the contract of ``build_lineage.fetch_related`` so callers
    can dispatch by paperId prefix without code-path forks. Each
    returned dict is shaped like an S2 paper response (via
    ``_work_to_paper_dict``) with ``paperId='openalex:W...'`` so the
    next BFS hop recursively routes back here.

    ``kind`` selects the relationship:
      * ``references`` — fetch this Work's ``referenced_works`` (parents),
        then batch-resolve the IDs to full Work metadata.
      * ``citations`` — query ``/works?filter=cites:W{id}`` for papers
        that cite this Work (children), sorted by ``cited_by_count``
        so the top hits are the most-influential descendants.

    Limit is capped at ``_OPENALEX_PER_PAGE_MAX`` (200) per OpenAlex.

    Unarxive context enrichment (#209 Phase J): each returned paper
    has ``_contexts`` populated from the local unarXive DuckDB when
    the relevant arXiv ↔ OpenAlex pair is in the corpus. For
    ``references`` the focal's arXiv id is read from the same
    ``/works/{id}`` payload that provides ``referenced_works``; for
    ``citations`` each neighbour's own arXiv id is used as the
    citing side. The lookup is silent when unarXive isn't built
    (``_contexts=[]`` → downstream year/cite fallback).
    """
    if not openalex_short_id or not openalex_short_id.startswith("W"):
        return []
    page_size = min(max(1, limit), _OPENALEX_PER_PAGE_MAX)
    if kind == "references":
        # `ids` is included so we can extract the focal's arXiv ID
        # for the unarXive context lookup on the citing side (#209
        # Phase J). It's a small payload addition (~30 bytes) and
        # avoids a second OpenAlex round-trip.
        params: dict[str, Any] = {
            "select": "id,referenced_works,ids",
        }
        if email:
            params["mailto"] = email
        resp = request_with_retry(
            "GET",
            f"{_OPENALEX_WORKS_URL}/{openalex_short_id}",
            params=params,
            headers={"User-Agent": "PaperPilot/0.1"},
            timeout=20,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "openalex work fetch failed (id=%s, status=%s)",
                openalex_short_id, getattr(resp, "status_code", None),
            )
            return []
        try:
            payload = resp.json()
        except ValueError:
            return []
        ref_urls = (payload or {}).get("referenced_works") or []
        ref_ids = [
            sid for sid in (
                _openalex_short_id(u) for u in ref_urls if isinstance(u, str)
            )
            if sid
        ]
        # Extract focal's arXiv id for the unarXive lookup. Missing
        # arxiv_id is fine — _enrich_parent_with_unarxive returns []
        # and the edge falls through to year/cite heuristic later.
        focal_arxiv = ((payload or {}).get("ids") or {}).get("arxiv_id")
        # Cap before the batch fetch to avoid wasting OpenAlex quota
        # on papers we'd discard anyway.
        parents = _fetch_openalex_works_by_ids(ref_ids[:page_size], email=email)
        enriched = [_attach_empty_intent_fields(p) for p in parents]
        if focal_arxiv:
            # focal cites each parent → citing=focal.arxiv, cited=parent
            for p in enriched:
                _enrich_parent_with_unarxive(
                    p, citing_arxiv_id=focal_arxiv
                )
        return enriched
    if kind == "citations":
        params = {
            "filter": f"cites:{openalex_short_id}",
            "per-page": page_size,
            "sort": "cited_by_count:desc",
        }
        if email:
            params["mailto"] = email
        resp = request_with_retry(
            "GET",
            _OPENALEX_WORKS_URL,
            params=params,
            headers={"User-Agent": "PaperPilot/0.1"},
            timeout=20,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "openalex cites query failed (id=%s, status=%s)",
                openalex_short_id, getattr(resp, "status_code", None),
            )
            return []
        try:
            payload = resp.json()
        except ValueError:
            return []
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            return []
        children: list[dict[str, Any]] = []
        focal_paper_id = f"{_OPENALEX_PAPER_ID_PREFIX}{openalex_short_id}"
        for work in results:
            if not isinstance(work, dict):
                continue
            paper = _work_to_paper_dict(work)
            if paper is None:
                continue
            paper = _attach_empty_intent_fields(paper)
            # child cites focal → citing=child.arxiv, cited=focal.openalex
            _enrich_child_with_unarxive(
                paper, cited_openalex_id=focal_paper_id
            )
            children.append(paper)
        return children
    return []


def _attach_empty_intent_fields(paper: dict[str, Any]) -> dict[str, Any]:
    """Add the entry-level fields that BFS callers rely on (``_intents``,
    ``_is_influential``, ``_contexts``) when they're not provided by the
    data source. OpenAlex doesn't expose citation intent / contexts, so
    OpenAlex-sourced papers always carry None / [] here and the
    downstream classifier falls through to year/cite contrast or LLM.
    """
    paper.setdefault("_intents", None)
    paper.setdefault("_is_influential", None)
    paper.setdefault("_contexts", [])
    return paper


def _resolve_openalex_to_s2(works: list[dict]) -> list[dict[str, Any]]:
    """POST OpenAlex DOIs to S2 ``/paper/batch``; return S2-shape dicts.

    Uses ``/paper/batch`` (one request, up to 500 ids) instead of N
    parallel ``/paper/{id}`` lookups because batch counts as a single
    call against the shared-IP rate limit on GitHub Actions runners
    (S2's primary throttle vector for this pipeline). Works without a
    DOI are silently skipped — they cannot be resolved through this
    endpoint.

    Returns ``[]`` on error (None response, non-200, parse fail) so
    callers can fall through to whatever S2 search managed to surface.
    """
    ids: list[str] = []
    for work in works:
        doi = _extract_doi(work)
        if not doi:
            continue
        ids.append(f"DOI:{doi}")
        if len(ids) >= _S2_BATCH_MAX_IDS:
            break
    if not ids:
        return []

    resp = request_with_retry(
        "POST",
        _S2_BATCH_URL,
        params={"fields": _S2_FIELDS_SEARCH},
        json_body={"ids": ids},
        headers={"User-Agent": "PaperPilot/0.1"},
        timeout=30,
    )
    if resp is None or resp.status_code != 200:
        logger.warning(
            "S2 /paper/batch failed (status=%s) — OpenAlex DOIs unresolved",
            getattr(resp, "status_code", None),
        )
        return []
    try:
        data = resp.json()
    except ValueError as exc:
        logger.warning("S2 /paper/batch JSON parse failed: %s", exc)
        return []
    if not isinstance(data, list):
        return []
    # /paper/batch returns nulls in-place for unmatched ids; drop them.
    resolved: list[dict[str, Any]] = []
    for entry in data:
        if isinstance(entry, dict) and entry.get("paperId") and entry.get("title"):
            resolved.append(entry)
    return resolved


def _apply_seed_filters(
    by_id: dict[str, dict[str, Any]],
    *,
    theme: str | None,
    top_n: int,
    since_year: int | None,
) -> list[dict[str, Any]]:
    """Run the standard seed-filter chain (denylist → topic relevance →
    per-theme blacklist) on the candidate pool, then rank-and-truncate.

    Extracted so the S2-primary and OpenAlex-primary paths share an
    identical filter chain — drifting the two would silently cause
    different seed sets depending on which data source the throttle
    happened to spare today.
    """
    candidates: list[dict[str, Any]] = list(by_id.values())
    candidates = _filter_denylisted_seeds(candidates)
    if theme:
        candidates = _filter_topic_relevant_seeds(candidates, theme=theme)
        candidates = _filter_theme_blacklist(candidates, theme=theme)
    return _rank_and_truncate(candidates, top_n=top_n, since_year=since_year)


def _discover_seeds_openalex_primary(
    *,
    keywords: list[str],
    top_n: int,
    since_year: int | None,
    openalex_email: str | None,
    theme: str | None,
) -> list[dict[str, Any]]:
    """OpenAlex-first seed discovery path (#209 S2-free Phase 1).

    Mirrors the structure of the S2-primary path but uses OpenAlex
    Works as the seed source and converts each to an S2-shape paper
    dict via ``_work_to_paper_dict``. The resulting ``paperId`` is
    prefixed ``openalex:`` so the BFS layer (``fetch_related``) routes
    to the OpenAlex back-end for parent/child traversal — no S2 call
    is needed anywhere on this path.

    Unlike the legacy S2 fallback, we do NOT call ``/paper/batch`` to
    map DOIs onto S2 paperIds: that endpoint shares S2's IP-pool
    throttle and was the choke point pre-#209. Skipping it makes the
    pipeline robust to S2 outages.

    Single OpenAlex search per keyword (their relevance ranker is fine
    on multi-word strings); dedup by OpenAlex short ID.
    """
    by_id: dict[str, dict[str, Any]] = {}
    for kw in keywords:
        if not kw or not kw.strip():
            continue
        works = discover_seeds_via_openalex(
            query=kw,
            top_n=top_n,
            since_year=since_year,
            email=openalex_email,
        )
        for work in works:
            paper = _work_to_paper_dict(work)
            if paper is None:
                continue
            by_id.setdefault(paper["paperId"], paper)
    return _apply_seed_filters(
        by_id, theme=theme, top_n=top_n, since_year=since_year
    )


def discover_seeds(
    *,
    keywords: list[str],
    top_n: int,
    since_year: int | None,
    use_openalex_fallback: bool = True,
    openalex_email: str | None = None,
    theme: str | None = None,
    primary_source: str = "s2",
) -> list[dict[str, Any]]:
    """Find seed papers for the theme via S2 ``/paper/search`` (default)
    or OpenAlex ``/works`` (``primary_source="openalex"``).

    Calls the search endpoint once per keyword, dedupes by paperId,
    filters by ``since_year``, sorts by citationCount desc, returns
    top ``top_n``. Each per-keyword call is cached to disk (mirrors
    ``fetch_related``'s cache pattern in build_lineage.py) so re-runs
    are cheap.

    Network failures (resp is None / non-200) are written as an empty
    cache entry — same fail-safe behaviour as the rest of the pipeline.

    OpenAlex fallback (``use_openalex_fallback=True``, default): when
    S2 yields fewer than ``top_n`` seeds — the steady-state failure
    mode on shared GitHub Actions runner IPs throttled by S2 — search
    OpenAlex for the theme, resolve the resulting DOIs through S2
    ``/paper/batch`` (separate rate budget from ``/paper/search``),
    and merge the new papers in (dedup by paperId). ``openalex_email``
    enables OpenAlex's polite pool for higher reliability under load.

    ``primary_source="openalex"`` (#209 S2-free Phase 1): inverts the
    priority. OpenAlex becomes the primary data source and S2 is only
    consulted as a top-up when OpenAlex returns fewer than ``top_n``
    seeds. Used by production workflows that can't rely on S2 (no API
    key, shared CI IP throttle) — paperIds are emitted with an
    ``openalex:`` prefix so BFS routes to OpenAlex.
    """
    if primary_source == "openalex":
        primary = _discover_seeds_openalex_primary(
            keywords=keywords,
            top_n=top_n,
            since_year=since_year,
            openalex_email=openalex_email,
            theme=theme,
        )
        # No S2 top-up here: the whole point of this path is to avoid
        # S2 entirely. If OpenAlex under-delivered, the lineage will
        # be sparser but the build still completes.
        return primary

    by_id: dict[str, dict[str, Any]] = {}

    for kw in keywords:
        if not kw or not kw.strip():
            continue
        cache = _seed_cache_path(kw, since_year)
        if cache.exists():
            try:
                cached = json.loads(cache.read_text())
            except json.JSONDecodeError:
                cached = []
            if isinstance(cached, list):
                for p in cached:
                    if isinstance(p, dict) and p.get("paperId"):
                        by_id.setdefault(p["paperId"], p)
            continue

        params = {
            "query": kw,
            "fields": _S2_FIELDS_SEARCH,
            "limit": _S2_SEARCH_LIMIT,
            # CS-adjacent gate at the API level — see _S2_FIELDS_OF_STUDY
            # comment for the medical / biology contamination this guards
            # against. S2 returns a subset of the natural relevance
            # ranking; if the user-typed theme is unambiguously CS this
            # is a clean win, and the (rare) CS / interdisciplinary
            # theme will still surface its top CS papers.
            "fieldsOfStudy": _S2_FIELDS_OF_STUDY,
        }
        resp = request_with_retry(
            "GET",
            _S2_SEARCH_URL,
            params=params,
            headers={"User-Agent": "PaperPilot/0.1"},
            timeout=20,
        )
        cache.parent.mkdir(parents=True, exist_ok=True)
        if resp is None or resp.status_code != 200:
            cache.write_text("[]")
            continue
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        items: list[dict[str, Any]] = []
        for p in payload.get("data") or []:
            if isinstance(p, dict) and p.get("paperId") and p.get("title"):
                items.append(p)
                by_id.setdefault(p["paperId"], p)
        cache.write_text(json.dumps(items, ensure_ascii=False, indent=2))

    # Topic relevance gate: drop seeds whose title+abstract don't include
    # enough of the theme's words. ``theme`` is optional for backwards
    # compatibility with callers that already pre-filter their input;
    # production passes the original theme string so the GNN→Pandas
    # bug can't recur (issue #126 followup). Warn when omitted so the
    # regression can't slip back in via a forgotten kwarg.
    if theme is None:
        logger.warning(
            "discover_seeds called without theme= ; topic-relevance filter "
            "is bypassed and off-topic seeds may slip in (caller should pass "
            "the sanitised theme string)"
        )
    candidates: list[dict[str, Any]] = list(by_id.values())
    # Denylist runs ahead of the topic gate — it's a hard veto on a
    # known canonical-but-off-topic list (SciPy / NumPy / QIIME etc.)
    # and is theme-independent. Cheap to run; never causes loss.
    candidates = _filter_denylisted_seeds(candidates)
    if theme:
        candidates = _filter_topic_relevant_seeds(candidates, theme=theme)
        # Per-theme keyword blacklist (#209 Tier 1) runs after the
        # topic-relevance gate — it's a hard veto on cross-domain
        # leakage (microbiome / clinical / homology modelling) that
        # the substring relevance filter doesn't catch.
        candidates = _filter_theme_blacklist(candidates, theme=theme)
    primary = _rank_and_truncate(candidates, top_n=top_n, since_year=since_year)
    if not use_openalex_fallback or len(primary) >= top_n:
        return primary

    # Fallback path: top up the seed pool when S2 alone wasn't enough.
    # Build the OpenAlex query from all non-empty keywords; for the
    # current single-keyword default (theme as one keyword) this
    # collapses to the theme string itself.
    query = " ".join(k for k in keywords if k and k.strip())
    if not query:
        return primary
    logger.info(
        "S2 yielded %d/%d seeds; trying OpenAlex fallback (theme=%r)",
        len(primary), top_n, query,
    )
    works = discover_seeds_via_openalex(
        query=query,
        top_n=top_n,
        since_year=since_year,
        email=openalex_email,
    )
    if not works:
        return primary
    resolved = _resolve_openalex_to_s2(works)
    if not resolved:
        return primary

    for paper in resolved:
        pid = paper.get("paperId")
        if pid and pid not in by_id:
            by_id[pid] = paper

    # Re-apply the topic gate after the OpenAlex top-up — fallback can
    # introduce a brand new off-topic paper that the S2-only path would
    # have filtered. Without this, off-topic seeds slip in only when S2
    # fell short, producing flaky before/after comparisons.
    #
    # Invariant note: with the current substring-only filter, every
    # element of ``primary`` also passes the second filter pass, so
    # ``len(merged) >= len(primary)`` holds. If the filter is ever
    # tightened (e.g. embedding similarity), revisit the log delta below
    # which assumes that invariant.
    candidates_after_fallback: list[dict[str, Any]] = list(by_id.values())
    candidates_after_fallback = _filter_denylisted_seeds(
        candidates_after_fallback
    )
    if theme:
        candidates_after_fallback = _filter_topic_relevant_seeds(
            candidates_after_fallback, theme=theme
        )
        candidates_after_fallback = _filter_theme_blacklist(
            candidates_after_fallback, theme=theme
        )
    merged = _rank_and_truncate(
        candidates_after_fallback, top_n=top_n, since_year=since_year
    )
    logger.info(
        "OpenAlex fallback added %d new seeds (final=%d)",
        len(merged) - len(primary), len(merged),
    )
    return merged


def _is_survey(paper: dict[str, Any]) -> bool:
    """True iff the paper title matches the survey / review pattern.

    Pinned to title-only because abstracts often mention "we survey
    related work" in the first sentence of non-survey papers, which
    would false-positive. The regex covers both prefix form ("A
    Survey of ...") and colon-suffix form ("Foo: A Survey").
    """
    title = paper.get("title") or ""
    if not isinstance(title, str):
        return False
    return _SURVEY_TITLE_RE.search(title) is not None


def _compute_seed_score(paper: dict[str, Any], *, current_year: int) -> float:
    """Velocity-based ranking score for a seed candidate (#209 Tier 1).

    Replaces raw citationCount desc. Computation:

        score = (cites + 1) / max(age_years, 0.5)
        if _is_survey(paper):
            score *= _SURVEY_VELOCITY_PENALTY

    Properties:
      - Penalises 10-year-old high-cite surveys that accumulated more
        raw cites than 2017 seminal works of the same field.
      - Preserves ResNet-style classics — their velocity is still
        massive even after age normalisation.
      - Survey penalty is multiplicative (not zero) so genuinely
        seminal surveys still appear in the top-N when no better
        candidate exists.

    Why ``(cites + 1)``: avoids ranking unwithdrawn 2026 papers with
    0 cites at score=0 (same as never-published); the +1 keeps them
    in the ordering by year alone.
    """
    cites = paper.get("citationCount") or 0
    year = paper.get("year")
    if not isinstance(year, int) or year > current_year:
        age = _SEED_VELOCITY_AGE_FLOOR_YEARS
    else:
        age = max(float(current_year - year), _SEED_VELOCITY_AGE_FLOOR_YEARS)
    score = (cites + 1) / age
    if _is_survey(paper):
        score *= _SURVEY_VELOCITY_PENALTY
    return score


def _rank_and_truncate(
    papers: Iterable[dict[str, Any]],
    *,
    top_n: int,
    since_year: int | None,
) -> list[dict[str, Any]]:
    """Apply since_year filter, score by velocity + survey penalty
    (#209 Tier 1), return top_n.

    Extracted so the S2-only path and the merged-with-OpenAlex path
    share identical filtering and ranking semantics — otherwise the
    fallback could surface a paper that the primary path would have
    rejected, producing surprising before/after deltas in the seed list.

    Pre-#209 used raw ``citationCount desc``. That favoured 10-year-
    old surveys with accumulated cites over young seminal works:
    graph-neural-network's top 5 returned 3 surveys instead of
    GCN/GraphSAGE/GAT. The new scorer normalises by paper age and
    penalises surveys 70 % so the natural top-N becomes the seminal
    works the user actually wants.
    """
    candidates = list(papers)
    if since_year is not None:
        candidates = [
            p for p in candidates
            if isinstance(p.get("year"), int) and p["year"] >= since_year
        ]
    current_year = datetime.now().year
    candidates.sort(
        key=lambda p: _compute_seed_score(p, current_year=current_year),
        reverse=True,
    )
    return candidates[:top_n]


def _normalize_relevance_text(text: str) -> str:
    """Lower-case, replace hyphens with spaces, collapse whitespace.

    Used by the topic-relevance gate so "self-supervised learning"
    (theme) matches "self supervised learning" (paper abstract with
    space) and vice versa. Without this normalisation the gate's
    phrase check was brittle to a single punctuation difference
    between the typed theme and the canonical paper wording.
    """
    return re.sub(r"\s+", " ", text.replace("-", " ").lower()).strip()


# Maximum token-position distance between the two theme words in the
# title-only fallback for 2-word themes (2026-06-05 audit). Without
# this guard, "Real-World-Weight Cross-Entropy Loss Function: Modeling
# the Costs" passed the World Model theme because both 'world' and
# 'model' appeared in the title — but 6 tokens apart, in two unrelated
# compound terms. K=3 was picked from the 70-seed audit corpus:
#   - keeps every legitimate seed (DDPM dist=2, FSMANet dist=3,
#     Encoder-Decoder ... Semantic Segmentation dist=2)
#   - drops every off-topic seed (World Model's 3 seeds at dist=6/11/6)
# The phrase route (theme verbatim in title+abstract) is untouched
# because that path's evidence is already much stronger.
_TWO_WORD_FALLBACK_MAX_DISTANCE = 3


def _min_token_distance(text: str, word_a: str, word_b: str) -> int | None:
    """Smallest token-index distance between any occurrence of word_a
    and any occurrence of word_b in ``text``.

    Both ``text`` and the words must already be lowercased + hyphen-
    normalised. Match is substring-within-token so ``model`` finds
    ``modeling`` (matches the stem-aware behaviour the rest of this
    gate has). Returns ``None`` when either word fails to match.
    """
    tokens = text.split()
    positions_a = [i for i, t in enumerate(tokens) if word_a in t]
    positions_b = [i for i, t in enumerate(tokens) if word_b in t]
    if not positions_a or not positions_b:
        return None
    return min(abs(a - b) for a in positions_a for b in positions_b)


def _filter_topic_relevant_seeds(
    seeds: list[dict[str, Any]],
    *,
    theme: str,
) -> list[dict[str, Any]]:
    """Drop seeds whose title+abstract don't include the theme as a
    phrase (2-word themes) or enough of the theme's words (3+ word
    themes). All comparisons run on hyphen-normalised lowercase text
    so "self-supervised learning" and "self supervised learning"
    match interchangeably.

    Threshold scaling, by count of eligible (≥3 char) words after the
    stopword-ish drop:

    - 0 or 1 word eligible — short queries like "RAG" or "DPO" where
      the abbreviation rarely appears literally. Skip the gate and
      let S2 ranking do the work.
    - 2 words eligible — **phrase in title+abstract OR both words in
      title (#209).** The previous "both words anywhere in
      title+abstract" rule passed LPIPS as a Self-Supervised Learning
      seed because its abstract reviewed multiple paradigms
      ("supervised, self-supervised, and even unsupervised") and
      separately mentioned "deep learning" — neither was the theme.
      The phrase check (after hyphen normalisation) drops LPIPS; the
      title-only fallback keeps papers like "Denoising Diffusion
      Probabilistic Models" against the "Diffusion Models" theme,
      where the title carries both words but the phrase order
      differs.
    - 3+ words eligible — phrase OR ``ceil(N / 2)`` distinct words
      anywhere in title+abstract. The 50 % rule survives here because
      longer themes like "Direct Preference Optimization" routinely
      surface relevant papers titled "Preference Optimization without
      DPO" that drop one of the theme's tokens.
    """
    if not seeds:
        return []
    words = [
        w.lower()
        for w in theme.split()
        if len(w) >= _TOPIC_RELEVANCE_MIN_WORD_LEN
    ]
    if len(words) < 2:
        return seeds
    phrase = _normalize_relevance_text(theme)
    normalised_words = [_normalize_relevance_text(w) for w in words]
    kept: list[dict[str, Any]] = []
    if len(words) == 2:
        for p in seeds:
            title_only = _normalize_relevance_text(p.get("title") or "")
            haystack = _normalize_relevance_text(
                f"{p.get('title') or ''} {p.get('abstract') or ''}"
            )
            if phrase and phrase in haystack:
                kept.append(p)
                continue
            # Fallback: both words must appear *in the title* AND be
            # within _TWO_WORD_FALLBACK_MAX_DISTANCE token positions
            # of each other. Title-only is much higher signal than
            # title+abstract (LPIPS had both words in its abstract but
            # neither in its title), and the distance bound catches
            # compound-term false matches like World Model accepting
            # "Real-World-Weight ... Modeling" (world at pos 1,
            # modeling at pos 7).
            if not all(w and w in title_only for w in normalised_words):
                continue
            distance = _min_token_distance(
                title_only, normalised_words[0], normalised_words[1]
            )
            if distance is not None and distance <= _TWO_WORD_FALLBACK_MAX_DISTANCE:
                kept.append(p)
        return kept
    threshold = max(
        2, math.ceil(len(words) * _TOPIC_RELEVANCE_THRESHOLD_RATIO)
    )
    for p in seeds:
        haystack = _normalize_relevance_text(
            f"{p.get('title') or ''} {p.get('abstract') or ''}"
        )
        if phrase and phrase in haystack:
            kept.append(p)
            continue
        hits = sum(1 for w in normalised_words if w and w in haystack)
        if hits >= threshold:
            kept.append(p)
    return kept


def _filter_denylisted_seeds(
    seeds: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Drop seed candidates that match the implementation-foundation
    denylist (#209).

    Same denylist already used by ``_filter_off_topic_refs`` for BFS
    parent / child candidates — applied at seed phase now too because
    the 2026-05-27 audit found state-space-model surfacing SciPy 1.0
    and QIIME 2 (microbiome) as seeds. The S2
    ``fieldsOfStudy=Mathematics`` gate accepts those papers
    indistinguishably from research-line predecessors of state-space
    models; the denylist is a clean veto on a fixed list of
    canonical-but-off-topic paperIds and title regexes. Calls the
    same ``_is_implementation_foundation`` helper as
    ``_filter_off_topic_refs`` so the two filters can't drift.
    """
    return [p for p in seeds if not _is_implementation_foundation(p)]


@lru_cache(maxsize=1)
def _load_theme_aliases() -> dict[str, list[str]]:
    """Return the alias map from theme_aliases.json.

    Keys are lower-cased theme strings; values are lists of alternate
    keywords to try when the primary keyword returned 0 seeds. Missing
    file is silently treated as "no aliases" so the pipeline degrades
    gracefully when this optional override doesn't exist.
    """
    try:
        raw = json.loads(_THEME_ALIASES_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[str]] = {}
    for k, v in raw.items():
        if k.startswith("_") or not isinstance(k, str) or not isinstance(v, list):
            continue
        clean = [s for s in v if isinstance(s, str) and s.strip()]
        if clean:
            out[k.lower()] = clean
    return out


def _aliases_for(theme: str) -> list[str]:
    """Return any alternate keywords for ``theme``, normalised to lower
    case + whitespace-stripped (matches the loader's key shape)."""
    return _load_theme_aliases().get(theme.strip().lower(), [])


@lru_cache(maxsize=1)
def _load_theme_blacklist() -> dict[str, tuple[str, ...]]:
    """Return per-theme keyword blacklist from theme_blacklist.json.

    Keys are theme slugs (output of ``theme_slug``); values are tuples
    of lower-cased substrings. Any seed candidate whose lower-cased
    title+abstract contains any substring is dropped. Theme-specific
    veto layered on top of the theme-independent
    ``_is_implementation_foundation`` denylist (#209 Tier 1).

    The JSON file's top-level shape: ``{"themes": {<slug>: [<kw>...]}}``;
    the ``_comment`` / ``_format`` keys at the root are ignored. Missing
    or malformed file → empty mapping (graceful degrade).
    """
    try:
        raw = json.loads(_THEME_BLACKLIST_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        logger.warning(
            "theme blacklist at %s missing/malformed — no per-theme blacklist applied",
            _THEME_BLACKLIST_PATH,
        )
        return {}
    if not isinstance(raw, dict):
        return {}
    themes: dict[str, Any] = (
        raw["themes"] if isinstance(raw.get("themes"), dict) else raw
    )
    out: dict[str, tuple[str, ...]] = {}
    for slug, kws in themes.items():
        if not isinstance(slug, str) or slug.startswith("_") or not isinstance(kws, list):
            continue
        cleaned = tuple(
            kw.strip().lower() for kw in kws if isinstance(kw, str) and kw.strip()
        )
        if cleaned:
            out[slug] = cleaned
    return out


def _filter_theme_blacklist(
    seeds: list[dict[str, Any]], *, theme: str
) -> list[dict[str, Any]]:
    """Drop seeds whose title or abstract contains any of the theme's
    blacklisted substrings (#209 Tier 1).

    Resolves the theme to its slug via ``theme_slug`` so the file's
    keys (slugs) match what's looked up here regardless of the
    user's capitalisation or hyphenation of the theme input. Missing
    slug entry → no-op (returns seeds unchanged).
    """
    slug = theme_slug(theme)
    blacklist = _load_theme_blacklist().get(slug)
    if not blacklist:
        return seeds
    kept: list[dict[str, Any]] = []
    for p in seeds:
        haystack = f"{p.get('title') or ''} {p.get('abstract') or ''}".lower()
        if any(kw in haystack for kw in blacklist):
            continue
        kept.append(p)
    return kept


@lru_cache(maxsize=1)
def _load_denylist() -> tuple[frozenset[str], tuple[re.Pattern[str], ...]]:
    """Return (paperId set, compiled title-regexes) from the data file.

    Cached so the JSON is parsed once per process — the BFS calls
    ``_is_implementation_foundation`` once per candidate ref, and re-
    reading a 500-byte JSON each time was wasteful (and made the test
    setup brittle when monkeypatching ``ROOT``).
    """
    try:
        raw = json.loads(_DENYLIST_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        logger.warning(
            "denylist file missing or malformed at %s — proceeding with empty list",
            _DENYLIST_PATH,
        )
        return frozenset(), ()
    paper_ids = frozenset(
        pid for pid in raw.get("paper_ids", []) if isinstance(pid, str)
    )
    patterns = tuple(
        re.compile(p, re.IGNORECASE)
        for p in raw.get("title_patterns", [])
        if isinstance(p, str)
    )
    return paper_ids, patterns


def _is_implementation_foundation(paper: dict[str, Any]) -> bool:
    """True iff ``paper`` is on the implementation-foundation denylist.

    A match on either paperId or title regex is enough — they
    complement each other. paperId catches the specific S2 IDs we've
    observed leaking into themes; title pattern catches future
    variants of the same canonical paper (e.g. TensorFlow has at
    least two papers with different IDs, and new lib release notes
    could acquire fresh IDs over time).
    """
    paper_ids, patterns = _load_denylist()
    pid = paper.get("paperId") or paper.get("id")
    if isinstance(pid, str) and pid in paper_ids:
        return True
    title = paper.get("title") or ""
    if not isinstance(title, str):
        return False
    return any(pat.search(title) for pat in patterns)


def _filter_off_topic_refs(
    refs: list[dict[str, Any]],
    *,
    max_seed_cite: int,
) -> list[dict[str, Any]]:
    """Drop BFS reference candidates (either parents or children) whose
    citationCount is wildly above the theme's max-cited seed AND that
    lack a methodology intent. Applied symmetrically on both BFS directions
    because foundational refs leak into both (ancestor: citing paper cites
    ResNet; descendant: a survey citing the seed is also cited by every
    modern ML paper). See the block comment above ``_OFF_TOPIC_CITE_MULTIPLIER``
    for the rationale.

    When ``max_seed_cite`` is 0 (e.g. S2 returned the seed without cite
    info), the multiplier collapses and we pass everything through —
    blindly dropping all refs would be worse than the original noise.
    """
    ceiling = max_seed_cite * _OFF_TOPIC_CITE_MULTIPLIER if max_seed_cite > 0 else None
    kept: list[dict[str, Any]] = []
    for p in refs:
        # Denylist is unconditional — applies regardless of cite count or
        # intent. Without this guard, Adam-as-optimizer slips through every
        # methodology-flavoured citation it accumulates.
        if _is_implementation_foundation(p):
            continue
        cites = int(p.get("citationCount") or 0)
        if ceiling is None or cites <= ceiling:
            kept.append(p)
            continue
        intents = {
            str(i).lower()
            for i in (p.get("_intents") or [])
            if isinstance(i, str)
        }
        if "methodology" in intents:
            kept.append(p)
    return kept


# ---------- GitHub stars enrichment ----------

# Conference lineage gets stars from papers.json (Stage 2 catalog), but the
# theme pipeline crawls S2 directly so to_node() always sees stars=0.
# This post-pass resolves arxiv_id -> GitHub repo via two layers and then
# fetches the live star count from the GitHub API:
#
#   1. paperpilot/data/paper_repos.json — curated arxiv_id -> "owner/repo"
#      mapping. Hand-maintained, 100% accurate within coverage.
#   2. GitHub Search — paper title fed into /search/repositories with a
#      title-similarity filter so a "Segment Anything" paper does not
#      accidentally pick up a tutorial repo.
#
# Why not Papers with Code: PwC was permanently shut down in 2026 (every
# paperswithcode.com URL 302-redirects to huggingface.co/papers/trending,
# and the production-media data dumps return TLS errors / 404). The HF
# papers endpoint does not expose a githubRepo field, so we cannot just
# swap one third-party for another.
# Budget rationale (kept here near _enrich_github_stars callers): a
# typical theme has ~50–60 nodes. Curated hits use 1 GitHub API call
# each, search fallbacks use 2 (search + repo). 80 lookups → ~160 calls
# max, well under the 5000/h PAT limit. Without a PAT the
# unauthenticated cap is 60/h overall (10/min for search) so the
# operator should set PAPERPILOT_GITHUB_TOKEN for bulk regen.
# (Constants moved to the top of the file; only this comment remains
# alongside the code that uses them.)


def _load_github_stars_cache(cache_path: Path) -> dict[str, dict]:
    """Load the GitHub-stars cache; return ``{}`` on missing or
    malformed file. Extracted so the resolution loop in
    ``_enrich_github_stars`` reads as a single linear flow."""
    if not cache_path.exists():
        return {}
    try:
        data = json.loads(cache_path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_github_stars_cache(cache: dict[str, dict], cache_path: Path) -> None:
    """Atomically persist the GitHub-stars cache. Concurrent theme
    runs are kept safe by the temp-file + rename pattern; on OSError
    we warn but don't fail the build (in-memory cache stays
    consistent for the rest of the run)."""
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2))
        tmp.replace(cache_path)
    except OSError as exc:
        logger.warning("failed to persist github_stars cache: %s", exc)


def _enrich_github_stars(
    nodes: dict[str, dict],
    *,
    max_lookups: int = _GITHUB_DEFAULT_BUDGET,
    github_token: str | None = None,
    curated: dict[str, str] | None = None,
    fetch_stars: Callable[..., int | None] | None = None,
    search_repo: Callable[..., str | None] | None = None,
) -> int:
    """Resolve GitHub stars for theme nodes that have an arxiv_id.

    Resolution order (per node, until a repo is found):
      1. ``curated[arxiv_id]`` — hand-maintained mapping in
         ``paperpilot/data/paper_repos.json``.
      2. ``search_repo(title)`` — GitHub Search by paper title with a
         title-similarity filter (``_TITLE_SIM_THRESHOLD``) to avoid
         false positives on common-word titles.

    Once a repo is resolved, ``fetch_stars`` returns the live stargazer
    count. The trio of resolvers is exposed as parameters for tests; the
    defaults wire up the real GitHub API.

    Side-effects: mutates ``nodes`` in-place, setting ``github_stars``
    and ``github_url`` on resolved entries. Persists a JSON cache at
    ``CACHE_DIR/github_stars.json`` so subsequent runs reuse fresh
    lookups (TTL = ``_GITHUB_CACHE_TTL_DAYS``).

    Returns the count of nodes whose final ``github_stars`` > 0
    (cache hits + freshly resolved).
    """
    cache_path = CACHE_DIR / _GITHUB_CACHE_FILE
    cache = _load_github_stars_cache(cache_path)

    if curated is None:
        curated = load_curated_map()
    fetch = fetch_stars or fetch_repo_stars
    search = search_repo or search_repo_by_title

    fresh_cutoff = (
        datetime.now(timezone.utc) - timedelta(days=_GITHUB_CACHE_TTL_DAYS)
    ).isoformat()

    enriched = 0
    targets: list[tuple[dict, str]] = []  # (node, arxiv_id)
    for node in nodes.values():
        ax = node.get("arxiv_id")
        if not ax:
            continue
        cached = cache.get(ax)
        if cached and cached.get("fetched_at", "") >= fresh_cutoff:
            # A corrupted cache entry (e.g. stars="abc" or stars=[1,2])
            # would crash the enrichment loop here; fall back to 0 so
            # the run continues and the entry is refreshed on next pass.
            try:
                stars = int(cached.get("stars") or 0)
            except (ValueError, TypeError):
                stars = 0
            if stars > 0:
                node["github_stars"] = stars
                cached_url = cached.get("url")
                # Re-validate the cached URL through the same parser the
                # write path uses. A poisoned cache entry (corrupt file
                # or attacker-supplied) cannot inject ``javascript:`` /
                # ``data:`` / off-host URLs into the generated
                # lineage.json this way — only well-formed
                # ``https://github.com/owner/repo`` URLs survive.
                if cached_url and parse_github_repo_url(cached_url):
                    node["github_url"] = cached_url
                enriched += 1
            continue
        targets.append((node, ax))

    if not targets:
        return enriched

    # Slice to the lookup budget BEFORE issuing any API call. Papers past
    # the budget are NOT cached as 0 — they re-enter the queue on the
    # next run instead of being suppressed for the full TTL window.
    looked_up = targets[:max_lookups]

    fetched_ts = datetime.now(timezone.utc).isoformat()
    # Tally resolution paths separately from fetch outcomes:
    #   curated_hits / search_hits  → which layer found a repo
    #   stars_positive               → how many of those resolved repos
    #                                  ended up with stars > 0
    # Bookkeeping at resolution time (rather than inside a stars > 0
    # branch) means the log line stays correct even when a curated
    # repo turned out to be private / deleted / 0-starred.
    curated_hits = 0
    search_hits = 0
    stars_positive = 0
    for node, ax in looked_up:
        # 1. Curated map (authoritative).
        repo_full = curated.get(ax)
        if repo_full:
            curated_hits += 1
        else:
            # 2. GitHub Search fallback for everything else.
            try:
                repo_full = search(node.get("title") or "", github_token=github_token)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("search_repo failed for %s: %s", ax, exc)
                repo_full = None
            if repo_full:
                search_hits += 1

        stars = 0
        url: str | None = None
        if repo_full:
            try:
                fetched = fetch(repo_full, github_token=github_token)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("fetch_stars failed for %s: %s", repo_full, exc)
                fetched = None
            if fetched is not None and fetched > 0:
                stars = int(fetched)
                url = f"https://github.com/{repo_full}"
                stars_positive += 1

        # Cache the result regardless of stars value — caching 0 prevents
        # weekly re-querying for papers without a public GitHub repo.
        cache[ax] = {
            "stars": stars,
            "url": url,
            "fetched_at": fetched_ts,
        }
        if stars > 0:
            node["github_stars"] = stars
            if url:
                node["github_url"] = url
            enriched += 1

    if curated_hits or search_hits:
        logger.info(
            "github stars resolution: curated=%d, search=%d, stars>0=%d "
            "(of %d looked up)",
            curated_hits,
            search_hits,
            stars_positive,
            len(looked_up),
        )

    _save_github_stars_cache(cache, cache_path)

    return enriched


# ---------- Build pipeline ----------


class _BFSResult(NamedTuple):
    """Bundles the per-build state produced by ``_run_bfs_and_descendants``
    so ``build_theme_lineage`` can reason about the BFS output as a single
    object instead of juggling five locals. Each field is mutable
    (``nodes``, ``edges``) or trivially copyable (counters), so passing
    by reference is fine for the rest of the pipeline."""
    nodes: dict[str, dict]
    edges: list[dict]
    seed_ids: list[str]
    classify_attempted: int
    classify_succeeded: int


def _run_bfs_and_descendants(
    seeds: list[dict],
    *,
    depth: int,
    width: int,
    max_seed_cite: int,
    provider: AbstractLLMProvider,
    llm_strict: str,
) -> _BFSResult:
    """BFS ancestor traversal up to ``depth`` hops, then a 1-hop
    descendants pass from each seed (issue #55).

    Behaviour intentionally identical to the inlined version this
    replaced — the only change is encapsulating the four output values
    (nodes, edges, seed_ids, classify counters) into ``_BFSResult``.

    BFS direction conventions:
      * ancestors: parent (cited, carries intents) → current (citing)
      * descendants: seed (older, focus) → child (newer, carries intents)
    """
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    # #68: stamp the build year so _is_trending() can compute citation
    # velocity. Single fetch keeps every node's badge consistent.
    current_year = datetime.now(timezone.utc).year

    seed_ids: list[str] = []
    frontier: list[tuple[dict, int]] = []
    for seed in seeds:
        sid = seed["paperId"]
        nodes[sid] = to_node(
            seed, focus=True, trending=_is_trending(seed, current_year)
        )
        seed_ids.append(sid)
        frontier.append((seed, 0))

    # Issue #45: silent fallback masking (LLM quota / RPM throttling)
    # produced 0-edges themes during bulk runs. Track classify outcomes
    # so we can warn loudly at the end of the build.
    classify_attempted = 0
    classify_succeeded = 0

    visited: set[str] = set(seed_ids)
    while frontier:
        current, current_depth = frontier.pop(0)
        if current_depth >= depth:
            continue

        # Pull a wide pool, prioritise influential refs, then fall back to
        # citation-count desc — same heuristic build_deep_lineage uses to
        # keep BFS cost bounded.
        all_parents = fetch_related(current["paperId"], "references", width * 4)
        all_parents = [p for p in all_parents if p.get("abstract")]

        # #126 followup: drop foundational off-topic refs before partitioning.
        # The methodology-intent guard inside _filter_off_topic_refs lets
        # truly load-bearing foundationals (ones the citing paper explicitly
        # uses as its method) survive — only the ResNet-in-a-GNN-tree class
        # of accidental ancestors gets removed.
        all_parents = _filter_off_topic_refs(
            all_parents, max_seed_cite=max_seed_cite
        )

        # Issue #50 (followup): the previous order — sort all by citationCount
        # then filter by isInfluential — let foundational papers (ResNet,
        # Transformer, etc.) dominate the top-N and crowd out the actually-
        # influential niche refs. Partition first so the LLM budget hits the
        # specific refs the citing paper built upon, then top-up with high-
        # citation candidates if there's room left.
        influential = [
            p for p in all_parents if p.get("_is_influential") is not False
        ]
        non_influential = [
            p for p in all_parents if p.get("_is_influential") is False
        ]
        influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        non_influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        parents = (influential + non_influential)[:width]

        for parent in parents:
            pid = parent.get("paperId")
            if not pid:
                continue
            if pid not in nodes:
                nodes[pid] = to_node(
                    parent, trending=_is_trending(parent, current_year)
                )
            # Issue #53: derive the relation from S2 intents instead of
            # firing an LLM classify call. derive_relation() returns None
            # when S2 says the parent is non-influential (we drop the
            # edge), and otherwise picks a relation enum + rationale by
            # mapping the intents array via _INTENT_RELATION_MAP.
            classify_attempted += 1
            # BFS: parent (cited) carries intents; current is the citing
            # child being processed (parent → current edge).
            cls = derive_relation(
                parent, parent=parent, child=current,
                provider=provider, strict_mode=llm_strict,
            )
            if cls is not None:
                classify_succeeded += 1
                edges.append(
                    {
                        "src": pid,
                        "dst": current["paperId"],
                        "rel": cls["relation"],
                        "conf": cls["confidence"],
                        "rationale": cls["rationale"],
                    }
                )
            if pid not in visited:
                visited.add(pid)
                frontier.append((parent, current_depth + 1))

    # Issue #55: descendants direction. BFS only goes UP (parents) so the
    # graph cuts off at the seed year — newer papers that cite the seeds
    # (and represent the field's *next* step) never appear. Fetch each
    # seed's top-N citing papers, add them as nodes, and emit seed → child
    # edges. derive_relation() handles the relation type from intents.
    desc_added = 0
    # Descendants intentionally use a tighter cap than parents (#56): a
    # popular seed paper has hundreds of citers and the chronological
    # viewer rendered them as a 26-paper-wide row. Keep the budget to
    # half the BFS width so the recent-year side of the tree stays
    # readable. Halve the parent width but keep at least 4.
    desc_width = max(width // 2, 4)
    for seed in seeds:
        sid = seed["paperId"]
        # Wide pool then influential-first, citation-count desc — mirrors
        # the parent partition above so descendants stay quality-anchored.
        all_children = fetch_related(sid, "citations", desc_width * 4)
        all_children = [c for c in all_children if c.get("abstract")]
        # Same off-topic guard as the parent path — a foundational paper
        # masquerading as a descendant (e.g. a survey that cites the seed
        # while also being cited by every modern ML paper) would similarly
        # pollute the tree. The methodology-intent override keeps real
        # extensions in place.
        all_children = _filter_off_topic_refs(
            all_children, max_seed_cite=max_seed_cite
        )
        influential = [c for c in all_children if c.get("_is_influential") is not False]
        non_influential = [c for c in all_children if c.get("_is_influential") is False]
        influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        non_influential.sort(key=lambda x: x.get("citationCount") or 0, reverse=True)
        children = (influential + non_influential)[:desc_width]

        for child in children:
            cid = child.get("paperId")
            if not cid or cid == sid:
                continue
            if cid not in nodes:
                nodes[cid] = to_node(
                    child, trending=_is_trending(child, current_year)
                )
            # Descendants direction: seed → child edge. The CHILD carries
            # intents (S2 citations endpoint annotates the citing paper).
            # parent=seed (older), child=child (newer) for year/cite logic.
            cls = derive_relation(
                child, parent=seed, child=child,
                provider=provider, strict_mode=llm_strict,
            )
            if cls is None:
                continue
            if any(e["src"] == sid and e["dst"] == cid for e in edges):
                continue
            edges.append({
                "src": sid,
                "dst": cid,
                "rel": cls["relation"],
                "conf": cls["confidence"],
                "rationale": cls["rationale"],
            })
            desc_added += 1
    if desc_added:
        logger.info(
            "descendants pass added %d edges (seed → newer citing papers)",
            desc_added,
        )

    return _BFSResult(
        nodes=nodes,
        edges=edges,
        seed_ids=seed_ids,
        classify_attempted=classify_attempted,
        classify_succeeded=classify_succeeded,
    )


def _log_classify_summary(
    classify_attempted: int,
    classify_succeeded: int,
    *,
    has_extra_nodes: bool,
    has_edges: bool,
) -> None:
    """Emit the post-build LLM-failure-rate summary + the three distinct
    degraded-data warnings (#45). Pulled out of ``build_theme_lineage``
    so the caller flow reads as one line — the conditions are subtle
    enough (LLM quota vs. influential-filter vs. zero-edges) that they
    warrant a dedicated home.
    """
    classify_failed = classify_attempted - classify_succeeded
    fail_rate = classify_failed / classify_attempted if classify_attempted else 0.0
    logger.info(
        "classify summary: attempted=%d, success=%d, failed=%d (%.1f%% failure)",
        classify_attempted,
        classify_succeeded,
        classify_failed,
        fail_rate * 100,
    )
    if classify_attempted and fail_rate > 0.30:
        logger.warning(
            "high LLM failure rate (%.1f%%) — likely Groq RPM/daily quota; "
            "consider re-running after quota resets",
            fail_rate * 100,
        )
    # All parents skipped by the isInfluential filter (#50) — produces a
    # node-only graph that looks healthy but is structurally empty.
    # Surface this distinct from the LLM-quota path so the operator can
    # widen the seed pool / loosen the filter rather than wait for quota.
    if classify_attempted == 0 and has_extra_nodes:
        logger.warning(
            "no classify calls attempted — every parent was filtered out "
            "(non-influential per S2). Theme may be too narrow."
        )
    if not has_edges:
        logger.warning(
            "produced 0 edges — data quality is degraded; the JSON is still "
            "written but the viewer will show nodes only. See issue #45."
        )


def _pick_root_seed(
    seed_ids: list[str],
    cleaned_edges: list[dict],
) -> str | None:
    """Pick the focus seed with the most relations (in OR out edges) as
    the lineage root. Returns ``None`` for an edgeless / seedless graph
    so the JSON encoder writes ``null`` instead of an empty string.
    """
    if not seed_ids:
        return None
    edge_count: dict[str, int] = {}
    for e in cleaned_edges:
        edge_count[e["src"]] = edge_count.get(e["src"], 0) + 1
        edge_count[e["dst"]] = edge_count.get(e["dst"], 0) + 1
    return max(seed_ids, key=lambda nid: edge_count.get(nid, 0))


def build_theme_lineage(
    *,
    theme: str,
    depth: int,
    seeds_count: int,
    width: int,
    since_year: int | None,
    output: Path | None = None,
    use_openalex_fallback: bool = True,
    llm_strict: str = "off",
    primary_source: str = "s2",
) -> Path:
    """Run the full theme-to-family-tree pipeline; return the output path.

    ``primary_source`` (#209 S2-free Phase 1): selects the primary
    data source for seed discovery and BFS.
      * ``"s2"`` (default): legacy behaviour — S2 ``/paper/search`` and
        ``/{id}/references|citations``, with OpenAlex top-up fallback.
      * ``"openalex"``: OpenAlex ``/works`` for seed + BFS via
        ``referenced_works`` / ``cites:`` filter. No S2 calls anywhere
        on the success path — survives without ``PAPERPILOT_S2_API_KEY``
        and without CI runner IP throttle.
    """
    sanitised = sanitize_theme(theme)
    slug = theme_slug(sanitised)

    # Load env once at the top — both the seed-discovery fallback
    # (openalex_email) and the github-stars enrichment further down
    # (github_token) read from the same env dict.
    try:
        env = load_env()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("load_env failed (continuing with empty env): %s", exc)
        env = {}
    openalex_email = (env or {}).get("openalex_email")

    # Issue #53: relation classification is now LLM-free (derive_relation),
    # but build_provider is still used downstream by other scripts; here
    # we no longer need it for the theme pipeline. Keep the call so the
    # provider is constructed (logs config errors etc.) but we won't ever
    # invoke .classify_relation / ._chat from this script.
    inner_provider, _ = build_provider()
    provider, cache = _wrap_provider_with_cache(inner_provider)
    logger.info(
        "theme=%r slug=%r provider=%s (cache=%d entries)",
        sanitised, slug, provider.name, len(cache),
    )

    # Stage 1: keyword expansion is skipped — the LLM call here was the
    # last reason this script needed a working provider. Use the raw
    # theme as the single search keyword. Multi-keyword expansion was
    # nice for seed diversity but is no longer worth a TPM-burdened
    # round-trip; the theme name itself is usually the strongest signal
    # (per the DPO experience where 1-keyword fallback still produced
    # good seeds when paired with citation-desc ranking).
    keywords = [sanitised]
    logger.info("using raw theme as single keyword: %r", keywords[0])

    # Stage 2: discover seeds.
    seeds = discover_seeds(
        keywords=keywords,
        top_n=seeds_count,
        since_year=since_year,
        use_openalex_fallback=use_openalex_fallback,
        openalex_email=openalex_email,
        theme=sanitised,
        primary_source=primary_source,
    )
    # Alias fallback: when the canonical theme name doesn't surface any
    # seeds (S2 indexed under a different spelling, abbreviation
    # mismatch, etc), retry with operator-curated alternates from
    # theme_aliases.json. Only fires on 0-seed outcomes so the common
    # path stays a single search. See the doc string of
    # _load_theme_aliases for the file shape.
    if not seeds:
        for alt_kw in _aliases_for(sanitised):
            logger.info(
                "primary keyword %r returned 0 seeds; trying alias %r",
                sanitised, alt_kw,
            )
            alt_seeds = discover_seeds(
                keywords=[alt_kw],
                top_n=seeds_count,
                since_year=since_year,
                use_openalex_fallback=use_openalex_fallback,
                openalex_email=openalex_email,
                theme=sanitised,
            )
            if alt_seeds:
                seeds = alt_seeds
                break
    logger.info(
        "discovered %d seeds: %s",
        len(seeds),
        [s.get("paperId") for s in seeds],
    )

    # Foundational filter calibration: cap BFS parent citations at
    # `_OFF_TOPIC_CITE_MULTIPLIER × max(seed cites)`, so the citing paper's
    # references can't drag in a globally-foundational paper that the
    # theme has nothing to do with. Computed once so every BFS node uses
    # the same ceiling.
    max_seed_cite = max(
        (int(s.get("citationCount") or 0) for s in seeds),
        default=0,
    )

    # Stage 3: BFS ancestors + descendants pass (see _run_bfs_and_descendants).
    bfs_result = _run_bfs_and_descendants(
        seeds,
        depth=depth,
        width=width,
        max_seed_cite=max_seed_cite,
        provider=provider,
        llm_strict=llm_strict,
    )
    nodes = bfs_result.nodes
    edges = bfs_result.edges
    seed_ids = bfs_result.seed_ids
    classify_attempted = bfs_result.classify_attempted
    classify_succeeded = bfs_result.classify_succeeded

    # Issue #54 / #57: cross-node edges. The BFS only adds (parent → seed)
    # edges, so two seeds that cite each other, or a parent that cites
    # another parent in the same graph, never produce a visible relation.
    # Scan the full collected node set against each node's references and
    # add any in-graph citation links we find — purely a cache + Python
    # operation (no LLM, references fetched from disk cache when present).
    #
    # Issue #57 reverted: the cohort-anchor constraint introduced earlier
    # was over-aggressive — it hid foundational-era cross-references the
    # user wanted visible ("全体的に矢印を作成して"). Re-enable the
    # full pass; volume is acceptable given the seeded influence filter
    # already culls non-influential refs upstream.
    cross_added = _add_cross_node_edges(
        nodes, edges, provider=provider, strict_mode=llm_strict,
    )
    if cross_added:
        logger.info(
            "cross-node pass added %d edges (in-graph citations not seen by BFS)",
            cross_added,
        )

    # GitHub stars enrichment (issue #89). Conference lineage pulls stars
    # from papers.json; the theme pipeline crawls S2 directly so every
    # node had stars=0 — the ⭐ row in the viewer never rendered. Look up
    # via PwC + GitHub for nodes that carry an arxiv_id, with a 7-day
    # disk cache so the weekly cron doesn't re-query the whole graph.
    # `env` was loaded at the top of build_theme_lineage().
    github_token = (env or {}).get("github_token")
    github_added = _enrich_github_stars(nodes, github_token=github_token)
    if github_added:
        logger.info(
            "github stars: enriched %d nodes (cache + fresh)", github_added
        )

    # Stage 4: drop edges with empty rationale (matches build_lineage policy).
    cleaned_edges = [e for e in edges if (e.get("rationale") or "").strip()]
    dropped = len(edges) - len(cleaned_edges)
    if dropped:
        logger.warning("dropped %d edges with empty rationale", dropped)

    # Issue #45: surface LLM-failure rate so silent quota throttling
    # doesn't hide as a successful "0 edges" build in CI logs.
    _log_classify_summary(
        classify_attempted,
        classify_succeeded,
        has_extra_nodes=len(nodes) > len(seed_ids),
        has_edges=bool(cleaned_edges),
    )

    # Stage 5: pick root = focus seed with most relations.
    root_id = _pick_root_seed(seed_ids, cleaned_edges)

    # Stage 6: sort nodes by year ascending (None years sink to the bottom).
    sorted_nodes = sorted(
        nodes.values(),
        key=lambda n: (
            n.get("year") if isinstance(n.get("year"), int) else 9999,
            -(n.get("citation_count") or 0),
        ),
    )

    payload = {
        "root": root_id,
        "nodes": sorted_nodes,
        "edges": cleaned_edges,
        "meta": {
            "source": "build_theme_lineage.py",
            "theme": sanitised,
            "slug": slug,
            "keywords": keywords,
            "seeds": seed_ids,
            "depth": depth,
            "since_year": since_year,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }

    out_path = output if output is not None else (
        DOCS_ROOT / "themes" / slug / "lineage.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    logger.info(
        "wrote %s (nodes=%d edges=%d root=%s)",
        out_path,
        len(sorted_nodes),
        len(cleaned_edges),
        root_id,
    )
    return out_path


# ---------- CLI ----------


def _build_arg_parser() -> argparse.ArgumentParser:
    """argparse parser for build_theme_lineage CLI.

    Extracted so unit tests can pin the flag set without invoking main().
    """
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--theme", required=True,
        help="Free-text research theme (e.g. 'Mixture of Experts').",
    )
    ap.add_argument(
        "--depth", type=int, default=2,
        help="BFS depth from each seed (default 2).",
    )
    ap.add_argument(
        "--seeds", type=int, default=8, dest="seeds_count",
        help="Number of seed papers from the theme search (default 8).",
    )
    ap.add_argument(
        "--width", type=int, default=8,
        help="Max parents fetched per BFS hop (default 8).",
    )
    ap.add_argument(
        "--since-year", type=int, default=None, dest="since_year",
        help="Only consider papers with year >= this value.",
    )
    ap.add_argument(
        "--output", default=None,
        help="Override output path (default docs/themes/<slug>/lineage.json). "
             "Intended for CI / tests — bypasses the theme_slug() gate, so do "
             "not use with untrusted input.",
    )
    ap.add_argument(
        "--no-openalex-fallback",
        dest="use_openalex_fallback",
        action="store_false",
        default=True,
        help="Disable the OpenAlex fallback used when S2 /paper/search "
             "returns < seeds_count results (e.g. on throttled CI IPs). "
             "By default the fallback runs whenever S2 alone is short.",
    )
    ap.add_argument(
        "--llm-strict",
        dest="llm_strict",
        choices=["off", "ambiguous", "all"],
        default="off",
        help="Optional LLM refinement of the heuristic relation classifier. "
             "off (default): heuristic only, no LLM calls. "
             "ambiguous: LLM only on edges whose S2 intents do not map to a "
             "known relation key (most edges, but cheap to bulk-skip). "
             "all: LLM on every influential edge (high cost — bounded by "
             "Groq per-minute rate limits in practice).",
    )
    ap.add_argument(
        "--primary-source",
        dest="primary_source",
        choices=["s2", "openalex"],
        default="s2",
        help="Data source for seed discovery + BFS (#209 S2-free Phase 1). "
             "s2 (default): legacy path with S2 search + OpenAlex top-up. "
             "openalex: OpenAlex /works for seed + referenced_works / "
             "cites: filter for BFS — no S2 calls anywhere, survives "
             "without PAPERPILOT_S2_API_KEY and shared-IP throttle.",
    )
    ap.add_argument(
        "--auto-expand",
        dest="auto_expand",
        action="store_true",
        default=False,
        help="Retry with larger BFS parameters when the first pass "
             "produces a sparse lineage (< SPARSE_NODES nodes or < "
             "SPARSE_EDGES edges). New themes whose citation graph "
             "hasn't built up yet (e.g. 2024-2025 ideas like Mixture "
             "of Depths) routinely undershoot at the workflow defaults "
             "of --depth 1 --seeds 5 --width 8; retrying with depth+1, "
             "seeds*2, width+4 typically densifies them. The retry uses "
             "the same classifications.json cache so the LLM cost is "
             "near-zero on the second pass. Off by default so bulk "
             "regen-themes runs aren't doubled on every theme.",
    )
    return ap


# --auto-expand thresholds. A lineage with fewer than SPARSE_NODES nodes
# OR fewer than SPARSE_EDGES edges is considered sparse and triggers the
# retry. Numbers picked from the smallest themes that still felt useful
# in the viewer (Speculative Decoding ~12 nodes / 14 edges) and the
# Mixture of Depths regen that was visibly too thin (9 / 3).
SPARSE_NODES = 15
SPARSE_EDGES = 5


def _expand_params(depth: int, seeds_count: int, width: int) -> tuple[int, int, int]:
    """Compute the larger BFS parameters used on the auto-expand retry.

    Each axis bumps independently so that callers with already-high
    values don't bloat further than necessary: depth never exceeds 3
    (BFS frontier explodes), seeds at least doubles but caps at 12
    (Groq TPM bound on theme-on-demand.yml), width adds +4 with a 12 cap.
    """
    return (
        min(3, depth + 1),
        min(12, max(10, seeds_count * 2)),
        min(12, width + 4),
    )


def main(argv: list[str] | None = None) -> int:
    ap = _build_arg_parser()
    args = ap.parse_args(argv)

    # CLI invocations need an explicit setup_logging() call (collector.py
    # does the same in its main); without it Python's root defaults to
    # WARNING and our logger.info progress messages would silently drop.
    setup_logging()

    # Validate theme up-front so a bad CLI value fails fast with a clear
    # message — long pipelines that error out half-way are a bad UX.
    try:
        sanitize_theme(args.theme)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output = Path(args.output) if args.output else None
    try:
        out_path = build_theme_lineage(
            theme=args.theme,
            depth=args.depth,
            seeds_count=args.seeds_count,
            width=args.width,
            since_year=args.since_year,
            output=output,
            use_openalex_fallback=args.use_openalex_fallback,
            llm_strict=args.llm_strict,
            primary_source=args.primary_source,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # Auto-expand: detect a sparse lineage and rebuild with larger BFS
    # parameters. The classification cache (lineage-cache/classifications.json)
    # is shared between the two passes, so the LLM cost of the retry is
    # bounded by the *new* parent/child pairs that the wider BFS surfaces —
    # typically a small minority. Same out_path so the viewer URL is
    # stable across retries.
    if args.auto_expand:
        try:
            initial = json.loads(out_path.read_text())
        except (OSError, json.JSONDecodeError):
            initial = {"nodes": [], "edges": []}
        n_nodes = len(initial.get("nodes") or [])
        n_edges = len(initial.get("edges") or [])
        if n_nodes < SPARSE_NODES or n_edges < SPARSE_EDGES:
            d2, s2, w2 = _expand_params(args.depth, args.seeds_count, args.width)
            print(
                f"auto-expand: first pass {n_nodes} nodes / {n_edges} edges below "
                f"({SPARSE_NODES} / {SPARSE_EDGES}); retrying with "
                f"--depth {d2} --seeds {s2} --width {w2}",
                file=sys.stderr,
            )
            try:
                out_path = build_theme_lineage(
                    theme=args.theme,
                    depth=d2,
                    seeds_count=s2,
                    width=w2,
                    since_year=args.since_year,
                    output=output,
                    use_openalex_fallback=args.use_openalex_fallback,
                    llm_strict=args.llm_strict,
                    primary_source=args.primary_source,
                )
            except ValueError as exc:
                # Expansion failed but the first pass is already on disk —
                # report the cause and keep the smaller lineage rather than
                # crashing the entire CI run.
                print(
                    f"auto-expand retry failed; keeping initial lineage: {exc}",
                    file=sys.stderr,
                )

    # Issue #45: non-fatal exit code 3 distinguishes "ran cleanly but
    # produced no edges" from a normal success. CI / bulk scripts can
    # detect this and trigger an alert without having to grep logs.
    try:
        payload = json.loads(out_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        # The file was just written by build_theme_lineage(); failing to
        # read it back means a write race / disk error. Don't mask that
        # as success — let CI see exit 2 and surface the cause.
        print(
            f"error: cannot re-read just-written {out_path}: {exc}",
            file=sys.stderr,
        )
        return 2
    if not payload.get("edges"):
        print(
            "warning: 0 edges produced — output written but viewer will show "
            "nodes only. Re-run after LLM quota resets (see issue #45).",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
