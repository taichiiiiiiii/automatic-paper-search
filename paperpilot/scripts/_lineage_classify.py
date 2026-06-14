"""Relation classification for theme lineage edges.

Extracted from ``build_theme_lineage.py`` in #207 as the first step of
breaking that 3 K-line module into focused units. This file owns the
"how do we decide what relation an edge represents" responsibility,
across three layers in priority order:

1. **unarXive citation contexts** (#209 Phase J): regex patterns over
   the citing paper's own sentences about the cited work. Highest
   evidence quality, no LLM cost.
2. **S2 intent map**: ``_INTENT_RELATION_MAP`` translates S2-supplied
   intent labels (methodology / result / background) into a relation
   + heuristic rationale.
3. **Year + citation contrast**: when the intent map produces nothing,
   compare publication years and citation counts to pick a relation.

On top of that, the optional LLM pass (``derive_relation`` with
``provider`` + ``strict_mode``) either confirms or refutes the heuristic
edge.  ``_CachedClassifyProvider`` wraps any ``AbstractLLMProvider``
with a shared on-disk cache so re-runs and cross-theme overlap are
free.

What does NOT live here:

- ``_CLASSIFICATION_CACHE_PATH`` — kept as a ``build_theme_lineage``
  module-level constant because two test files (#207 plan) monkeypatch
  it as ``btl._CLASSIFICATION_CACHE_PATH``. ``_wrap_provider_with_cache``
  in this module takes ``cache_path`` as an explicit argument; the
  thin wrapper in ``build_theme_lineage`` is what binds that constant
  in, so monkeypatching keeps working.
"""
from __future__ import annotations

import functools
import json
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from paperpilot.llm.base import (
    TEMPLATE_RATIONALES,
    AbstractLLMProvider,
    RelationClassification,
)
from paperpilot.utils.logger import get_logger

logger = get_logger(__name__)


# ===== Constants =====

# Issue #53 / #300: the third tuple element is the LEGACY template
# rationale. Post-#300 the heuristic NO LONGER emits it — it builds a
# slot-filled, paper-specific rationale via `_slot_fill_rationale()`
# instead, so a signal-bearing edge survives `_apply_llm_classification`'s
# template-reject step when the LLM is None (the "relation collapse" root
# cause). The template strings are RETAINED here only to (a) keep the
# single-source-of-truth link to base.TEMPLATE_RATIONALES for the #131
# LLM-echo reject set (the two CANNOT drift), and (b) document which
# template each intent used to emit.
_INTENT_RELATION_MAP: list[tuple[str, str, str]] = [
    # (intent name, relation enum, legacy rationale template) — order matters:
    # methodology > result when an entry has multiple intents, since
    # methodology implies the citing paper actually built on top of the
    # referenced work.
    #
    # #283 removed the (background, baseline_only, ...) entry. It was
    # unreachable on the OpenAlex-primary pipeline (OpenAlex does not
    # supply S2 intent labels at all), and on S2 inputs the template
    # rationale was always stripped by `_apply_llm_classification`'s
    # template-reject step whenever the LLM was None (the steady-state
    # condition under Groq free-tier quota exhaustion). Net production
    # output: zero baseline_only edges across 99 published edges.
    ("methodology", "extends", TEMPLATE_RATIONALES["extends_methodology"]),
    ("result", "successor", TEMPLATE_RATIONALES["successor_result"]),
]
_DERIVED_CONFIDENCE = 0.7  # constant — heuristic, not LLM probability

# #300: max chars of a paper title embedded in a slot-filled rationale.
# Keeps the rationale within _MAX_RATIONALE_LEN (280) even when both
# titles + boilerplate are present, while staying long enough to identify
# the paper.
_SLOT_FILL_TITLE_TRIM = 60

# #300: placeholders for a missing title in a slot-filled rationale.
# Mirror _foundational_ancestor_edge's "the cited work" fallback so the
# degraded sentence is still paper-shaped and never empty. These must NOT
# collide with any TEMPLATE_RATIONALES value (they don't — they are bare
# noun phrases, not full template sentences).
_MISSING_TITLE_JA = "引用元の論文"

# Minimum LLM confidence to keep an edge (#209). Below this, the LLM
# itself is signalling that the relation is weak; emitting it as a
# styled arrow misleads the reader. Threshold chosen at 0.4 so a "low
# but real" 0.5 still passes (the LLM has actually read both abstracts
# and judged a connection), while a tentative 0.3 is dropped. This
# only applies when classify_relation() returned a real result — LLM
# hiccups (None) still fall back to the heuristic at the merge step.
_MIN_LLM_CONFIDENCE = 0.4

_TEMPLATE_RATIONALES_SET: frozenset[str] = frozenset(TEMPLATE_RATIONALES.values())

# Closed enum of valid provenance labels for lineage edges.
# Every emit path in this module MUST set one of these values on the
# returned dict. PR1 (lineage-edge-provenance-field) adds the field;
# PR2 (audit-script-provenance) will use it for breakdown reporting.
_VALID_PROVENANCES: frozenset[str] = frozenset(
    {
        "context_pattern",      # unarXive citation context regex matched
        "intent_map",           # S2 intent label matched _INTENT_RELATION_MAP
        "year_cite",            # year / citation-count contrast heuristic
        "foundational_allowlist",  # title matched lineage_foundational_allowlist.json
        "llm",                  # LLM provider returned a valid classification
    }
)

# ===== Phase J: unarXive citation-context classifier =====
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


# ===== Phase J: citation context classifier =====

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
                        "provenance": "context_pattern",
                    }
    return None


# ===== Shared classification cache =====

def _default_persist_classifications(
    classifications: dict[str, dict], cache_path: Path
) -> None:
    """Fallback persistence used when ``_CachedClassifyProvider`` is
    instantiated without an explicit ``persist_fn``.

    Production callers go through ``build_theme_lineage._wrap_provider_with_cache``
    which injects ``build_lineage.persist_classifications`` — that version
    merges concurrent writers' entries (CLAUDE.md §14). This default is
    the simple atomic-write equivalent: enough for tests and one-shot
    runs, without forcing ``_lineage_classify`` to import ``build_lineage``.
    """
    tmp = cache_path.with_suffix(cache_path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(
        json.dumps(classifications, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, cache_path)


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
        persist_fn: Callable[[dict[str, dict], Path], None] | None = None,
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
        self._persist_fn = persist_fn or _default_persist_classifications

    def evaluate_batch(  # pragma: no cover - delegated
        self,
        papers: list,
        profile: str,
    ) -> list:
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
                    self._persist_fn(self._cache, self._cache_path)
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
    cache_path: Path,
    persist_fn: Callable[[dict[str, dict], Path], None],
) -> tuple[_CachedClassifyProvider, dict[str, dict]]:
    """Wrap ``inner`` with the shared classification cache so theme
    rebuilds reuse classified (parent, child) pairs at zero LLM cost.

    Returns ``(wrapped_provider, loaded_cache)`` so the caller can log
    the entry count without reaching into the wrapper's internals.

    The caller passes its own ``cache_path`` (typically the module-level
    ``_CLASSIFICATION_CACHE_PATH`` in ``build_theme_lineage``) so tests
    can monkeypatch the path from outside this module. Same for the
    ``persist_fn`` — keeping it as a parameter prevents a hard
    dependency on ``build_lineage.persist_classifications`` from this
    file.
    """
    cache = _load_classification_cache(cache_path)
    return (
        _CachedClassifyProvider(
            inner,
            cache,
            cache_path=cache_path,
            persist_fn=persist_fn,
        ),
        cache,
    )


# ===== Heuristic + LLM merge =====

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

    # #277: foundational ancestor short-circuit, takes priority over the
    # heuristic. Two reasons it lives BEFORE the None/Some split:
    #
    #   1. Heuristic-None path: parents with no S2 intent + outside
    #      the year/cite contrast windows would otherwise reach the LLM
    #      strict-mode branch and likely come back as "unrelated".
    #   2. Heuristic-template path: parents like ResNet (2015) → ViT
    #      (2020) hit the year/cite "successor" branch which emits a
    #      template rationale. Pre-#277 that template would survive
    #      OR be dropped depending on whether the LLM rescued it. With
    #      Groq quota exhausted (a steady-state condition for free-tier
    #      bulk regen), every template edge dies at
    #      _apply_llm_classification's reject step. Replacing the
    #      template here with the foundational allowlist edge — which
    #      embeds the parent title in the rationale — keeps the
    #      seminal-ancestor link visible even when the LLM is dark.
    #
    # Tight allowlist (~30 regexes) bounds the number of synthesised
    # edges per theme to single digits; the #209 fabrication problem
    # (93.7% template-rationale rate) doesn't recur because we only
    # rescue canonical anchors, not arbitrary refs.
    if _is_foundational_ancestor(parent):
        return _foundational_ancestor_edge(parent)

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


def _slot_fill_title(paper: dict | None) -> str:
    """Extract + truncate a paper title for embedding in a slot-filled
    rationale. Falls back to ``_MISSING_TITLE_JA`` when the title is
    absent (mirrors ``_foundational_ancestor_edge``'s "the cited work"
    degrade), so the result is never empty and never a template member.
    """
    title = ""
    if isinstance(paper, dict):
        raw = paper.get("title")
        if isinstance(raw, str):
            # Strip the 「」 brackets used as the rationale's own delimiters
            # so an odd title can't produce confusing nested quoting (#300
            # review LOW). Plain string in JSON — no XSS, just cosmetics.
            title = raw.strip().replace("「", "").replace("」", "")
    if not title:
        return _MISSING_TITLE_JA
    if len(title) > _SLOT_FILL_TITLE_TRIM:
        return title[: _SLOT_FILL_TITLE_TRIM - 1] + "…"
    return title


def _slot_fill_year(paper: dict | None) -> str:
    """Render a paper's year for a rationale; '?' when missing/non-int."""
    if isinstance(paper, dict):
        year = paper.get("year")
        if isinstance(year, int):
            return str(year)
    return "?"


def _slot_fill_rationale(
    relation: str,
    parent: dict | None,
    child: dict | None,
    *,
    intent: str | None = None,
) -> str:
    """Build a paper-specific, Japanese rationale embedding the actual
    parent/child titles (truncated) + years + the signal (#300).

    This generalises the slot-fill pattern already used by
    ``_foundational_ancestor_edge``: by embedding the concrete titles the
    rationale can NEVER be a member of ``_TEMPLATE_RATIONALES_SET``, so a
    signal-bearing heuristic edge survives ``_apply_llm_classification``'s
    template-reject step even when the LLM is unavailable (the root cause
    of the "relation collapse" in the family tree).

    ``parent`` is the OLDER / cited paper (paper A), ``child`` is the
    NEWER / citing paper (paper B) — same A→B convention as
    ``build_classify_prompt``.

    Degrades gracefully: a missing title becomes ``引用元の論文`` (mirroring
    the English "the cited work" fallback) so the sentence stays
    paper-shaped. Even the fully-degraded output (both titles + years
    missing) is ~38 chars — well above the 10-char minimum required by
    ``RelationClassification.from_dict`` (``_MIN_RATIONALE_LEN`` in
    ``paperpilot.llm.base``).
    """
    pt = _slot_fill_title(parent)
    ct = _slot_fill_title(child)
    py = _slot_fill_year(parent)
    cy = _slot_fill_year(child)

    # intent_map path: the S2 intent label is the signal — name it.
    # NOTE: when `intent is not None` the function returns from this
    # block, so the year-cite `relation == "successor"` branch below is
    # intentionally unreachable for the intent_map path.
    # `_INTENT_RELATION_MAP` currently maps `result → successor`, so a
    # result-intent edge takes the generic `〜として参照している` sentence
    # here, not the year-cite "後発研究" phrasing below — deliberate: the
    # rationale names the SIGNAL source (S2 intent), which differs from
    # the year-delta source even when both arrive at the same enum.
    # Pinned by test_slot_fill_intent_generic_relation_still_names_intent.
    if intent is not None:
        if relation == "extends":
            return (
                f"「{ct}」({cy}) は「{pt}」({py}) の手法を"
                f"{intent}文脈で拡張している。"
            )
        # Generic intent fallback for any other relation the intent map
        # might pick (currently only result→successor, but kept open).
        return (
            f"「{ct}」({cy}) は「{pt}」({py}) を"
            f"{intent}として参照している。"
        )

    if relation == "successor":
        return (
            f"「{ct}」({cy}) は「{pt}」({py}) を引用する後発研究"
            f"（年代差と引用関係から後継と推定）。"
        )
    if relation == "contrasts":
        return (
            f"「{ct}」({cy}) は「{pt}」({py}) と近い年代の対照的研究"
            f"（年代・引用規模から推定）。"
        )

    # Defensive default for any future relation routed through the
    # year/cite branch without an explicit sentence above. Still embeds
    # both titles so it is never a template member.
    return (
        f"「{ct}」({cy}) は「{pt}」({py}) と引用関係にある（{relation}）。"
    )


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
    for keyword, relation, _template in _INTENT_RELATION_MAP:
        if keyword in intents_set:
            # #300: emit a paper-specific slot-filled rationale instead of
            # the generic _template. The relation enum still comes from
            # _INTENT_RELATION_MAP; only the rationale TEXT changes so the
            # edge survives _apply_llm_classification when the LLM is dark.
            # Degrades gracefully when parent/child are absent (many call
            # sites pass only the intent record).
            rationale = _slot_fill_rationale(
                relation, parent, child, intent=keyword
            )
            return _make_derived(relation, rationale, "intent_map")

    # No matching intent — try year + citation contrast.
    #
    # #283 removed the supersedes_year_cite and ablation_year_cite emits.
    # Both produced template rationales that `_apply_llm_classification`
    # always rejected when the LLM returned None (steady state under
    # Groq free-tier quota). Net production output: 0 supersedes + 0
    # ablation across 99 published edges. The LLM is now the only path
    # to a supersedes or ablation edge — heuristic returns None for those
    # shapes and `derive_relation` falls through to the LLM-only branch.
    #
    # #300 TRADEOFF (ADR): the contrasts/successor edges below now emit a
    # SLOT-FILLED rationale, so — unlike pre-#300 — they SURVIVE the
    # template-reject when the LLM is None (the steady state). This is a
    # deliberate trade of edge scarcity for tree COMPLETENESS under LLM
    # outage: a collapsed (empty) tree is useless; a denser tree with
    # honest, hedged, filterable rationales is not. The successor rule
    # (delta 1-5, no citation floor) is liberal, so the published tree
    # gains year-gap-inferred edges; their rationale is hedged ("…と推定")
    # to state the inference basis, and the audit's template_rationale_ratio
    # now drops toward 0 (the old collapse signal). If production density
    # becomes a problem, tighten the delta/citation thresholds here or add
    # a weak-signal-successor audit metric in audit_lineage_quality.py.
    if parent is not None and child is not None:
        py = parent.get("year")
        cy = child.get("year")
        pc = parent.get("citationCount") or parent.get("citation_count") or 0
        cc = child.get("citationCount") or child.get("citation_count") or 0
        if isinstance(py, int) and isinstance(cy, int):
            delta = cy - py
            if delta <= 1 and pc > 100 and 0.5 <= cc / max(pc, 1) <= 2.0:
                # #300: slot-filled rationale (was TEMPLATE_RATIONALES
                # ["contrasts_year_cite"]) so the edge carries the actual
                # paper titles + years and survives the template-reject
                # step when the LLM is None.
                return _make_derived(
                    "contrasts",
                    _slot_fill_rationale("contrasts", parent, child),
                    "year_cite",
                )
            if 1 <= delta <= 5:
                # #300: slot-filled rationale (was TEMPLATE_RATIONALES
                # ["successor_result"]).
                return _make_derived(
                    "successor",
                    _slot_fill_rationale("successor", parent, child),
                    "year_cite",
                )
    return None


def _is_ambiguous(intent_record: dict) -> bool:
    """True iff S2 intents fail to pick a key in ``_INTENT_RELATION_MAP``.

    Gating predicate for ``--llm-strict=ambiguous``: edges whose intent
    set matches a known key are kept on the cheap heuristic path; the
    rest get the LLM treatment. Phase A Step 1 / CRITICAL C7.

    #283: after ``background → baseline_only`` was removed from
    ``_INTENT_RELATION_MAP``, ``background``-only edges are now
    ambiguous and route to the LLM (previously they were kept on the
    cheap path and then template-rejected). Pinned by
    ``test_background_intent_is_ambiguous_post_removal``.
    """
    intents = intent_record.get("_intents") or []
    intents_set = {str(i).lower() for i in intents if isinstance(i, str)}
    return all(keyword not in intents_set for keyword, _, _ in _INTENT_RELATION_MAP)


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
        # Preserve the heuristic's own provenance (e.g. "context_pattern").
        return heuristic
    if llm_result.relation == "unrelated":
        return None
    if float(llm_result.confidence) < _MIN_LLM_CONFIDENCE:
        return None
    return {
        "relation": llm_result.relation,
        "confidence": float(llm_result.confidence),
        "rationale": llm_result.rationale,
        "provenance": "llm",
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
        "provenance": "llm",
    }


def _make_derived(relation: str, rationale: str, provenance: str) -> dict:
    # Code-reviewer MEDIUM (#285 PR1): runtime guard against typos in
    # new emit paths. _VALID_PROVENANCES is the canonical closed set;
    # without this assert it would silently appear as an unknown bucket
    # in PR2's breakdown.
    assert provenance in _VALID_PROVENANCES, (
        f"provenance={provenance!r} not in _VALID_PROVENANCES — see "
        f"_lineage_classify._VALID_PROVENANCES for the closed set"
    )
    return {
        "relation": relation,
        "confidence": _DERIVED_CONFIDENCE,
        "rationale": rationale,
        "provenance": provenance,
    }


# ===== #277: foundational-ancestor allowlist =====
#
# OpenAlex-sourced refs carry no S2 intent labels, so the heuristic
# falls through to year/cite contrast — which only fires inside a narrow
# delta range. The LLM then arbitrates ambiguous edges in --llm-strict=
# ambiguous mode, but it's conservative on "is this paper a
# research-lineage parent?" — and for canonical ML foundations
# (Attention Is All You Need, ResNet, AlexNet, BiT, DETR, etc.) it
# tended to return "unrelated", dropping the seminal ancestor from the
# viewer. The allowlist file declares the small set of papers that are
# universally recognised lineage anchors so we can emit a stable edge
# for them at the heuristic stage, before the LLM gets a chance to
# reject. See lineage_foundational_allowlist.json + issue #277.
_FOUNDATIONAL_ALLOWLIST_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "lineage_foundational_allowlist.json"
)
_FOUNDATIONAL_ALLOWLIST_CONFIDENCE = 0.65


@functools.lru_cache(maxsize=1)
def _load_foundational_allowlist() -> list[re.Pattern[str]]:
    """Compile title patterns once per process — the allowlist is tiny
    (~30 entries) and never mutated at runtime.
    """
    try:
        data = json.loads(
            _FOUNDATIONAL_ALLOWLIST_PATH.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    patterns = data.get("title_patterns") or []
    compiled: list[re.Pattern[str]] = []
    for pat in patterns:
        if isinstance(pat, str) and pat.strip():
            try:
                compiled.append(re.compile(pat, re.IGNORECASE))
            except re.error:
                continue
    return compiled


def _is_foundational_ancestor(parent: dict | None) -> bool:
    """True iff ``parent`` matches a title pattern in the foundational
    allowlist. Used by ``derive_relation`` to bypass LLM rejection for
    canonical ML lineage anchors. Returns False for None / missing
    title so the call site doesn't need a guard.
    """
    if not isinstance(parent, dict):
        return False
    title = parent.get("title") or ""
    if not isinstance(title, str) or not title.strip():
        return False
    return any(pat.search(title) for pat in _load_foundational_allowlist())


def _foundational_ancestor_edge(parent: dict | None) -> dict:
    """Emit a stable extends edge for a foundational ancestor. The
    rationale embeds the parent title so it can't collide with the
    `_TEMPLATE_RATIONALES_SET` reject filter used by
    ``_apply_llm_classification`` for future LLM passes.
    """
    title = (parent or {}).get("title", "") if isinstance(parent, dict) else ""
    title = title.strip() or "the cited work"
    return {
        "relation": "extends",
        "confidence": _FOUNDATIONAL_ALLOWLIST_CONFIDENCE,
        "rationale": (
            f"{title} is a canonical research-lineage ancestor and "
            "is preserved here as a direct extends edge — see "
            "lineage_foundational_allowlist.json."
        ),
        "provenance": "foundational_allowlist",
    }
