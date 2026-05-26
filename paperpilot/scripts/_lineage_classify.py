"""Theme-lineage edge classification (heuristic + optional LLM).

Extracted from ``build_theme_lineage.py`` so the LLM classification
pipeline — heuristic intent map, ``--llm-strict`` decision tree,
cache-decorated provider, on-disk classifications cache — lives in a
single ~290-line file instead of being interleaved with seed discovery,
BFS, output writing, and CLI parsing.

Public surface (re-exported from ``build_theme_lineage`` for backwards
compatibility with tests that read these names off the script module):

  * ``derive_relation`` — entry point used by BFS + cross-node passes;
    composes the heuristic edge with an optional LLM refinement based
    on the ``--llm-strict`` mode.
  * ``_INTENT_RELATION_MAP`` / ``_DEFAULT_DERIVED`` — heuristic
    constants pinned by ``test_llm_base.test_template_rationales_used``.
  * ``_is_ambiguous`` / ``_apply_llm_classification`` — gating /
    merging helpers covered directly by
    ``test_build_theme_lineage_llm_strict``.
  * ``_CachedClassifyProvider`` / ``_wrap_provider_with_cache`` /
    ``_load_classification_cache`` — the on-disk cache layer wired in
    by ``build_theme_lineage()`` so theme rebuilds reuse classified
    ``(parent, child)`` pairs across runs.

All behaviour is byte-for-byte identical to the pre-extraction
implementation; see the original docstrings preserved on each function.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from paperpilot.llm.base import (
    TEMPLATE_RATIONALES,
    AbstractLLMProvider,
    RelationClassification,
)
from paperpilot.scripts.build_lineage import persist_classifications
from paperpilot.utils.logger import get_logger

logger = get_logger(__name__)

# Module path resolves to `.../paperpilot/scripts/_lineage_classify.py`.
# .parent.parent.parent climbs to the repo root so the cache path
# matches the constant in build_lineage.py / build_theme_lineage.py.
_ROOT = Path(__file__).resolve().parent.parent.parent
_CLASSIFICATION_CACHE_PATH = (
    _ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"
)

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
_DEFAULT_DERIVED = ("extends", TEMPLATE_RATIONALES["extends_methodology"])
_DERIVED_CONFIDENCE = 0.7  # constant — heuristic, not LLM probability


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
    *,
    cache_path: Path | None = None,
) -> tuple[_CachedClassifyProvider, dict[str, dict]]:
    """Wrap ``inner`` with the shared classification cache so theme
    rebuilds reuse classified (parent, child) pairs at zero LLM cost.

    Returns ``(wrapped_provider, loaded_cache)`` so the caller can log
    the entry count without reaching into the wrapper's internals.
    ``cache_path`` defaults to ``_CLASSIFICATION_CACHE_PATH``; the
    caller passes an explicit path so tests that monkeypatch the
    constant on a different module (e.g. ``build_theme_lineage``) get
    the override they configured.
    """
    path = cache_path if cache_path is not None else _CLASSIFICATION_CACHE_PATH
    cache = _load_classification_cache(path)
    return (
        _CachedClassifyProvider(inner, cache, cache_path=path),
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
    OR when the LLM (only invoked in strict modes) judges the relation
    as ``unrelated``. LLM-call failure (provider returns ``None``) falls
    back to the heuristic edge — we never silently drop a perfectly fine
    heuristic edge because the LLM hiccupped.
    """
    heuristic = _derive_relation_heuristic(intent_record, parent=parent, child=child)
    if heuristic is None:
        # _is_influential=False — LLM cost on a citation we'd drop anyway.
        return None
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

    Behavior is byte-for-byte identical to the pre-Step 1 derive_relation
    body (#53 introduced the intent map, #80 added the year/citation
    contrast pass). Existing 76 tests in test_build_theme_lineage.py pin
    this contract.
    """
    if intent_record.get("_is_influential") is False:
        return None
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
    relation, rationale = _DEFAULT_DERIVED
    return _make_derived(relation, rationale)


def _is_ambiguous(intent_record: dict) -> bool:
    """True iff S2 intents fail to pick a key in ``_INTENT_RELATION_MAP``.

    Gating predicate for ``--llm-strict=ambiguous``: edges whose intent
    set matches a known key are kept on the cheap heuristic path; the
    rest get the LLM treatment. Phase A Step 1 / CRITICAL C7.
    """
    intents = intent_record.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    return all(keyword not in intents_set for keyword, _, _ in _INTENT_RELATION_MAP)


def _apply_llm_classification(
    heuristic: dict, llm_result: RelationClassification | None
) -> dict | None:
    """Confluence point: merge an optional LLM classification into a heuristic edge.

    Decision matrix (#118 / CRITICAL C7):
      * ``llm_result is None``  → keep the heuristic (LLM hiccup,
        fail-safe). We never drop a good heuristic edge because the
        provider returned an unparseable JSON or hit a timeout.
      * ``relation == "unrelated"`` → drop the edge entirely
        (LLM positively rejects the relation; ``unrelated`` is never
        rendered in the viewer).
      * otherwise → take LLM's relation + rationale verbatim, but
        ``confidence = max(heuristic, llm)``. A timid LLM (conf 0.3)
        should not weaken a methodology-intent heuristic (conf 0.7);
        a confident LLM (0.95) should override the heuristic constant.

    Why rationale = LLM (when present): the heuristic rationale is a
    template; the LLM's rationale is grounded in the actual abstracts
    and carries far more user-facing signal.
    """
    if llm_result is None:
        return heuristic
    if llm_result.relation == "unrelated":
        return None
    return {
        "relation": llm_result.relation,
        "confidence": max(float(heuristic["confidence"]), float(llm_result.confidence)),
        "rationale": llm_result.rationale,
    }


def _make_derived(relation: str, rationale: str) -> dict[str, Any]:
    return {
        "relation": relation,
        "confidence": _DERIVED_CONFIDENCE,
        "rationale": rationale,
    }
