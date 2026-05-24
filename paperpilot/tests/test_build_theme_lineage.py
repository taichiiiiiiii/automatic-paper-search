"""Tests for paperpilot/scripts/build_theme_lineage.py.

These verify the theme-driven family-tree pipeline end-to-end without
hitting any real API. S2 (`request_with_retry`) and the LLM provider
(`classify_relation` + `_chat` for keyword expansion) are both mocked.

Key invariants:
  - Free-text theme is sanitised before any external call.
  - Output filesystem path is built from `theme_slug()`, never from the
    raw `--theme` argument.
  - LLM goes through `AbstractLLMProvider` (absolute rule §11).
  - Edges with `unrelated` or empty rationale are dropped.
  - Empty S2 results don't crash the pipeline; an empty-but-valid JSON
    is still written so the manifest generator can pick it up.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from paperpilot.llm.base import AbstractLLMProvider, RelationClassification
from paperpilot.scripts import build_theme_lineage

# ---- Test helpers ----


def _patch_env(monkeypatch, **values):
    """Patch config_loader.load_env to return a fixed secrets dict.

    Mirrors the helper used in test_build_lineage so the two test
    suites share an isolation strategy.
    """
    base: dict[str, object] = {
        "github_token": None,
        "s2_api_key": None,
        "openalex_email": None,
        "slack_webhook_url": None,
        "gemini_api_key": None,
        "claude_api_key": None,
        "groq_api_key": "gsk_x",  # default to a known provider for theme tests
        "groq_model": None,
        "gemini_model": None,
        "smtp": {},
    }
    base.update(values)
    monkeypatch.setattr(
        "paperpilot.utils.config_loader.load_env", lambda *a, **kw: base
    )
    for v in ("GROQ_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(v, raising=False)


class _FakeProvider(AbstractLLMProvider):
    """Minimal provider stub: records calls and returns canned values.

    Subclasses AbstractLLMProvider so mypy and runtime isinstance
    checks pass. classify_relation returns a fixed RelationClassification
    or None to exercise the empty/drop paths.
    """

    name = "fake"

    def __init__(
        self,
        *,
        classification: RelationClassification | None = None,
        keyword_response: str | None = None,
    ):
        super().__init__({"enabled": True})
        self._classification = classification
        self._keyword_response = keyword_response
        self.classify_calls: list[tuple[dict, dict]] = []
        self.chat_calls: list[tuple[str, str]] = []

    def evaluate_batch(self, papers, profile):  # pragma: no cover - unused
        return [None] * len(papers)

    def classify_relation(self, a: dict, b: dict) -> RelationClassification | None:
        self.classify_calls.append((a, b))
        return self._classification

    def _chat(self, system: str, user: str, *, json_mode: bool = False) -> str | None:
        # Mirrors GroqProvider._chat — keyword_expand calls this without
        # `json_mode`, classify_relation paths would call it with `json_mode=True`.
        self.chat_calls.append((system, user))
        return self._keyword_response


def _mk_s2_search_response(papers: list[dict]) -> MagicMock:
    """Wrap a list of S2-shaped paper dicts in a MagicMock response."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json = lambda: {"data": papers}
    return resp


def _mk_s2_paper(
    pid: str,
    *,
    title: str = "Some paper",
    year: int = 2020,
    cites: int = 100,
    authors: list[str] | None = None,
    abstract: str = "Lorem ipsum dolor sit amet — a stub abstract for tests.",
) -> dict:
    return {
        "paperId": pid,
        "title": title,
        "year": year,
        "venue": "NeurIPS",
        "citationCount": cites,
        "abstract": abstract,
        "authors": [{"name": a} for a in (authors or ["A. Author"])],
        "externalIds": {},
    }


# ---- sanitize_theme ----


def test_sanitize_theme_strips_control_chars():
    assert (
        build_theme_lineage.sanitize_theme("Mixture\x00 of\nExperts\t")
        == "Mixture ofExperts"
    )


def test_sanitize_theme_rejects_empty():
    with pytest.raises(ValueError):
        build_theme_lineage.sanitize_theme("")


def test_sanitize_theme_rejects_whitespace_only():
    with pytest.raises(ValueError):
        build_theme_lineage.sanitize_theme("   \t\n  ")


def test_sanitize_theme_rejects_over_500_chars():
    with pytest.raises(ValueError):
        build_theme_lineage.sanitize_theme("x" * 501)


def test_sanitize_theme_passes_500_chars():
    assert build_theme_lineage.sanitize_theme("x" * 500) == "x" * 500


# ---- discover_seeds ----


def test_discover_seeds_calls_s2_search_per_keyword(tmp_path: Path, monkeypatch):
    """Each expanded keyword should produce one S2 /paper/search call.

    Pinned to S2-only via ``use_openalex_fallback=False`` because top_n=10
    > unique results=2, which would otherwise trigger the OpenAlex fallback
    and add network calls that obscure the per-keyword S2 invariant.
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    keywords = ["mixture of experts", "moe", "sparse routing"]

    p1 = _mk_s2_paper("p1", year=2017, cites=500)
    p2 = _mk_s2_paper("p2", year=2020, cites=200)

    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([p1, p2]),
    ) as mock_rwr:
        seeds = build_theme_lineage.discover_seeds(
            keywords=keywords,
            top_n=10,
            since_year=None,
            use_openalex_fallback=False,
        )

    assert mock_rwr.call_count == len(keywords)
    # Seeds dedupe by paperId, so even though all 3 keywords return [p1, p2]
    # we get 2 unique seeds.
    assert {s["paperId"] for s in seeds} == {"p1", "p2"}


def test_discover_seeds_dedupes_papers(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    p1 = _mk_s2_paper("p1", cites=10)
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([p1, p1, p1]),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=10, since_year=None
        )
    assert len(seeds) == 1


def test_discover_seeds_filters_by_since_year(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    p_old = _mk_s2_paper("p_old", year=2005, cites=1000)
    p_new = _mk_s2_paper("p_new", year=2022, cites=10)
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([p_old, p_new]),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=10, since_year=2010
        )
    assert {s["paperId"] for s in seeds} == {"p_new"}


def test_discover_seeds_sorts_by_citation_count_desc(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    low = _mk_s2_paper("low", cites=5)
    high = _mk_s2_paper("high", cites=5000)
    mid = _mk_s2_paper("mid", cites=500)
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([low, high, mid]),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=10, since_year=None
        )
    assert [s["paperId"] for s in seeds] == ["high", "mid", "low"]


def test_discover_seeds_respects_top_n(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    papers = [_mk_s2_paper(f"p{i}", cites=1000 - i) for i in range(20)]
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response(papers),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=3, since_year=None
        )
    assert len(seeds) == 3
    assert [s["paperId"] for s in seeds] == ["p0", "p1", "p2"]


def test_discover_seeds_handles_empty_search(tmp_path: Path, monkeypatch):
    """Zero results from S2 must not crash; empty list returned."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([]),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["nonexistent"], top_n=10, since_year=None
        )
    assert seeds == []


def test_discover_seeds_handles_none_response(tmp_path: Path, monkeypatch):
    """`request_with_retry` returning None (network failure / persistent 5xx)
    must be tolerated — we cache an empty list and continue with other keywords."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    with patch.object(
        build_theme_lineage, "request_with_retry", return_value=None,
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=10, since_year=None,
        )
    assert seeds == []
    # Empty-list cache is still written so a re-run doesn't hit the network again.
    cache_files = list(tmp_path.glob("search_*.json"))
    assert len(cache_files) == 1
    assert json.loads(cache_files[0].read_text()) == []


def test_discover_seeds_handles_corrupt_cache(tmp_path: Path, monkeypatch):
    """A garbled cache file must not crash the pipeline; treat as empty
    and proceed (next run will rewrite it on a successful query).

    Fallback is disabled here so the test isolates corrupt-cache handling
    from the OpenAlex path (a real OpenAlex request would otherwise fire).
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    cache_path = build_theme_lineage._seed_cache_path("x", None)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text("{this is not valid json")
    seeds = build_theme_lineage.discover_seeds(
        keywords=["x"], top_n=10, since_year=None,
        use_openalex_fallback=False,
    )
    assert seeds == []


def test_discover_seeds_caches_per_keyword(tmp_path: Path, monkeypatch):
    """Re-running with the same keyword reuses cache (no second HTTP call).

    Fallback disabled so the cache-hit invariant (1 network call across
    2 runs) isn't muddied by OpenAlex top-up calls when top_n > 1 result.
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    p = _mk_s2_paper("p1")
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([p]),
    ) as mock_rwr:
        build_theme_lineage.discover_seeds(
            keywords=["k"], top_n=5, since_year=None,
            use_openalex_fallback=False,
        )
        build_theme_lineage.discover_seeds(
            keywords=["k"], top_n=5, since_year=None,
            use_openalex_fallback=False,
        )
    # Two pipeline runs, but only one network call thanks to disk cache.
    assert mock_rwr.call_count == 1


# ---- build pipeline ----


def _stub_external_calls(monkeypatch, *, classifier=None, chat_text=None):
    """Wire up keyword-expand + S2 + classify mocks for the full pipeline tests.

    Returns the FakeProvider so individual tests can introspect it.

    Theme builds use the *lenient* classifier (build_deep_lineage.
    _classify_cached_lenient), which calls ``provider._chat`` directly
    rather than ``provider.classify_relation``. ``chat_text`` lets a test
    pin the JSON the provider returns for both keyword expansion AND
    classification calls; pass classifier=... if you need a structured
    RelationClassification (currently unused — kept for future symmetry
    with build_lineage tests).
    """
    rc = classifier or RelationClassification(
        relation="extends", confidence=0.9, rationale="既存手法の改善版"
    )
    if chat_text is None:
        # Default: respond like a real provider — JSON object with relation
        # + rationale that the lenient classifier accepts.
        chat_text = (
            '{"relation": "extends", "confidence": 0.9, '
            '"rationale": "既存手法の改善版"}'
        )
    provider = _FakeProvider(
        classification=rc,
        keyword_response=chat_text,
    )
    monkeypatch.setattr(
        build_theme_lineage,
        "build_provider",
        lambda: (provider, 0.0),
    )
    return provider


def test_build_writes_output_under_themes_dir(tmp_path: Path, monkeypatch):
    """Pipeline emits docs/themes/<slug>/lineage.json under the configured root."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", docs_root)

    _stub_external_calls(monkeypatch)

    # #126 followup: seed title must contain the theme words so the new
    # topic relevance gate keeps it through discover_seeds. The original
    # short title "Original MoE" no longer matches a multi-word theme.
    seed = _mk_s2_paper(
        "seed1",
        title="The Original Mixture of Experts paper",
        year=2017,
    )
    parent = {
        **_mk_s2_paper("p_parent", year=2014),
        "_is_influential": True,
        "_intents": ["methodology"],
    }

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([seed])
        return _mk_s2_search_response([])

    with (
        patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            return_value=[parent],
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Mixture of Experts",
            depth=1,
            seeds_count=3,
            width=4,
            since_year=None,
        )

    expected = docs_root / "themes" / "mixture-of-experts" / "lineage.json"
    assert out_path == expected
    assert expected.exists()
    payload = json.loads(expected.read_text())
    assert payload["meta"]["slug"] == "mixture-of-experts"
    assert payload["meta"]["theme"] == "Mixture of Experts"
    # Issue #53: relation derivation is LLM-free. The edge is produced by
    # derive_relation() from the parent's _intents=["methodology"] →
    # relation=extends, with a templated rationale.
    assert any(e["rel"] == "extends" for e in payload["edges"])


def test_build_uses_slug_for_path_not_raw_theme(tmp_path: Path, monkeypatch):
    """The raw theme string must NEVER be spliced into the output path.

    This is the security-reviewer H2 invariant: even if a developer accidentally
    constructs a Path with the raw `--theme` string, theme_slug must intercept
    via build_theme_lineage. We assert the output path equals the slug-derived
    one — a path-traversal probe collapses to a safe slug, not to literal `..`.
    """
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", docs_root)

    _stub_external_calls(monkeypatch)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="../../etc/passwd",
            depth=1,
            seeds_count=3,
            width=4,
            since_year=None,
        )

    # Slug derivation collapses ../../etc/passwd → "etc-passwd".
    assert out_path == docs_root / "themes" / "etc-passwd" / "lineage.json"
    # Confirm the unsafe components are absent everywhere.
    parts = out_path.parts
    assert ".." not in parts
    assert "etc" not in parts  # collapsed into "etc-passwd" — not a separate dir


def test_build_drops_edges_for_non_influential_parents(tmp_path: Path, monkeypatch):
    """Issue #53: derive_relation returns None when isInfluential=False, so
    such parents produce no edge — replaces the legacy LLM "unrelated" path."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper("seed", year=2020)
    parent = {**_mk_s2_paper("parent", year=2018), "_is_influential": False}
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Test", depth=1, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    assert payload["edges"] == []


def test_build_emits_templated_rationale(tmp_path: Path, monkeypatch):
    """Issue #53: derive_relation always emits a non-empty templated
    rationale (the stage-4 'drop empty rationale' filter would otherwise
    silently kill every derived edge). #80 added year/citation
    heuristics so a 2-year delta now classifies as ``successor``; the
    important property is still that *some* templated rationale fires."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper("seed", year=2020)
    # No _intents → derive_relation falls back to year/cite heuristic.
    parent = {**_mk_s2_paper("parent", year=2018), "_is_influential": True}
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Test", depth=1, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    assert len(payload["edges"]) >= 1
    # Issue #55 added a descendants pass that may also use the same mock
    # return value; just assert the first BFS-derived edge looks right.
    bfs_edge = next(
        (e for e in payload["edges"] if e["dst"] == "seed" and e["src"] == "parent"),
        None,
    )
    assert bfs_edge is not None
    # #80: rel can be any of the heuristic-derived enums; just assert
    # the relation is real and the rationale is a non-empty Japanese
    # template line (the original empty-rationale guard).
    assert bfs_edge["rel"] in {
        "extends", "successor", "supersedes", "contrasts", "ablation", "baseline_only",
    }
    assert bfs_edge["rationale"], "templated rationale must not be empty"
    assert "論文" in bfs_edge["rationale"]


def test_build_emits_required_meta_fields(tmp_path: Path, monkeypatch):
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper("seed", year=2020)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Mixture of Experts",
            depth=2,
            seeds_count=1,
            width=4,
            since_year=2010,
        )

    payload = json.loads(out_path.read_text())
    meta = payload["meta"]
    assert meta["source"] == "build_theme_lineage.py"
    assert meta["theme"] == "Mixture of Experts"
    assert meta["slug"] == "mixture-of-experts"
    assert meta["depth"] == 2
    assert meta["since_year"] == 2010
    assert isinstance(meta["keywords"], list)
    assert len(meta["keywords"]) >= 1
    assert isinstance(meta["seeds"], list)
    assert "generated_at" in meta


def test_build_handles_empty_search_results(tmp_path: Path, monkeypatch):
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="No Results Theme",
            depth=1,
            seeds_count=3,
            width=4,
            since_year=None,
        )
    payload = json.loads(out_path.read_text())
    assert payload["nodes"] == []
    assert payload["edges"] == []
    assert payload["root"] is None


def test_build_node_schema_matches_lineage_format(tmp_path: Path, monkeypatch):
    """Theme nodes must have the same fields as build_lineage.to_node output
    so the same renderer can consume them without modification."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed1", year=2020)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    assert payload["nodes"], "expected at least one node"
    n = payload["nodes"][0]
    for field in (
        "id",
        "title",
        "year",
        "venue",
        "venue_tier",
        "authors",
        "kinds",
        "citation_count",
        "github_stars",
        "tldr",
    ):
        assert field in n, f"node missing field: {field}"


def test_build_does_not_invoke_llm(tmp_path: Path, monkeypatch):
    """Issue #53 acceptance: theme builds must not touch the LLM at all —
    relations come from S2 intents via derive_relation()."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    provider = _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parent = {
        **_mk_s2_paper("parent", year=2018),
        "_is_influential": True,
        "_intents": ["methodology"],
    }
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=4, since_year=None
        )
    assert provider.chat_calls == [], (
        f"unexpected LLM _chat invocation: {[c[1][:60] for c in provider.chat_calls]}"
    )
    assert provider.classify_calls == [], (
        f"unexpected classify_relation invocation: {len(provider.classify_calls)}"
    )


def test_build_root_picks_seed_with_most_relations(tmp_path: Path, monkeypatch):
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    s1 = _mk_s2_paper("seed1", year=2020, cites=200)
    s2 = _mk_s2_paper("seed2", year=2020, cites=100)
    p1 = _mk_s2_paper("p_for_seed1_a", year=2018)
    p2 = _mk_s2_paper("p_for_seed1_b", year=2018)

    def fake_related(s2_id, kind, limit):
        # seed1 has two parents; seed2 has none.
        if s2_id == "seed1":
            return [p1, p2]
        return []

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([s1, s2]),
        ),
        patch.object(build_theme_lineage, "fetch_related", side_effect=fake_related),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=2, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    assert payload["root"] == "seed1"


def test_build_respects_depth_two(tmp_path: Path, monkeypatch):
    """At depth=2 we BFS one extra hop; grand-parents appear in nodes."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parent = _mk_s2_paper("parent", year=2015)
    grand = _mk_s2_paper("grand", year=2010)

    def fake_related(s2_id, kind, limit):
        if s2_id == "seed":
            return [parent]
        if s2_id == "parent":
            return [grand]
        return []

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", side_effect=fake_related),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=2, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    ids = {n["id"] for n in payload["nodes"]}
    assert {"seed", "parent", "grand"} <= ids


def test_main_rejects_theme_over_500_chars(tmp_path: Path, monkeypatch, capsys):
    """argparse-time guard: --theme must reject inputs over 500 chars."""
    _patch_env(monkeypatch)
    rc = build_theme_lineage.main(["--theme", "x" * 501])
    assert rc != 0
    captured = capsys.readouterr()
    assert "500" in captured.err or "500" in captured.out


def test_main_rejects_empty_theme(monkeypatch, capsys):
    rc = build_theme_lineage.main(["--theme", "   "])
    assert rc != 0


# ---- Silent-fallback detection (issue #45) -----------------------------------


def _force_classify_failures(monkeypatch, *, every: bool = True):
    """Force every relation derivation to return None.

    Issue #53 made the classifier LLM-free by replacing _classify_cached
    with derive_relation. Patching the new path keeps the legacy 0-edges
    / high-failure-rate / exit-3 tests valid as integration coverage of
    the warning-and-exit signalling rather than the LLM-quota path.
    """
    monkeypatch.setattr(
        build_theme_lineage,
        "derive_relation",
        lambda *a, **kw: None,
    )


def test_build_zero_edges_emits_warning(tmp_path: Path, monkeypatch, caplog):
    """Issue #45: 0 edges produced → must log a WARNING, not silent success."""
    caplog.set_level(logging.WARNING, logger="paperpilot.scripts.build_theme_lineage")
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    _force_classify_failures(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parent = _mk_s2_paper("parent", year=2015)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    assert payload["edges"] == []
    msgs = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("0 edges" in m or "no edges" in m.lower() for m in msgs), (
        f"expected 0-edges warning, got: {msgs}"
    )


def test_build_high_failure_rate_logs_summary(tmp_path: Path, monkeypatch, caplog):
    """When classify fails for most attempts, a summary line should warn the user."""
    # Summary is at INFO; failure-rate alarm is at WARNING. Capture both.
    caplog.set_level(logging.INFO, logger="paperpilot.scripts.build_theme_lineage")
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    _force_classify_failures(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parents = [_mk_s2_paper(f"p{i}", year=2018) for i in range(5)]
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=parents),
    ):
        build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=8, since_year=None
        )
    msgs = [r.getMessage() for r in caplog.records]
    assert any("classify summary" in m.lower() for m in msgs), (
        f"expected classify summary log, got: {msgs}"
    )
    assert any(
        "failure rate" in m.lower() or "llm failure" in m.lower()
        for m in [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    ), "expected high-failure-rate WARNING"


def test_main_returns_3_when_zero_edges(tmp_path: Path, monkeypatch):
    """CI gate: main() exit code 3 (non-zero, non-error) on 0 edges."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    _force_classify_failures(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parent = _mk_s2_paper("parent", year=2015)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        rc = build_theme_lineage.main([
            "--theme", "X",
            "--depth", "1",
            "--seeds", "1",
            "--width", "4",
            "--output", str(tmp_path / "out.json"),
        ])
    assert rc == 3, f"expected exit 3 on 0 edges, got {rc}"


def test_build_prioritises_influential_parents_over_citation_count(
    tmp_path: Path, monkeypatch
):
    """Issue #50 followup: the previous logic sorted by citationCount then
    filtered, so foundational papers (ResNet etc.) flagged isInfluential=
    false dominated the top-N and pushed real influential refs out of the
    width. Partition first → niche influential refs win the budget."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    # #127-followup: seed cite count must be realistic — the off-topic
    # filter caps refs at 2x max_seed_cite, so a default seed at 100
    # cites would lock the ceiling to 200 and drop the niche ref too.
    # Production seeds discovered via S2 /paper/search routinely have
    # 5k-50k cites; 10k is representative.
    seed = _mk_s2_paper("seed", year=2023, cites=10_000)
    # Mix: influential ref with low citations + non-influential foundational
    # papers with very high citations. Width=2 — without the fix, the two
    # foundationals win the budget and the influential one is dropped.
    foundational1 = {
        **_mk_s2_paper("found1", title="Foundational A", year=2015, cites=15_000),
        "_is_influential": False,
    }
    foundational2 = {
        **_mk_s2_paper("found2", title="Foundational B", year=2017, cites=12_000),
        "_is_influential": False,
    }
    niche_influential = {
        **_mk_s2_paper("niche", title="Niche INFLUENTIAL", year=2022, cites=300),
        "_is_influential": True,
    }

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            return_value=[foundational1, foundational2, niche_influential],
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=2, since_year=None
        )
    payload = json.loads(out_path.read_text())
    edge_srcs = {e["src"] for e in payload["edges"]}
    # The niche influential parent must produce an edge — without the fix
    # it would have been filtered out by the width=2 cap before derive_relation.
    assert "niche" in edge_srcs, (
        f"expected niche influential ref to win the budget, got edges: {payload['edges']}"
    )


def test_is_trending_threshold():
    """Issue #68: citation velocity gate. 200 cites/year for last-3-years
    papers is the badge cut-off. Older classics (high lifetime cites,
    high lifetime velocity) are excluded so the badge means "hot now"."""
    # 2024 paper with 600 cites by 2026 = 300 cites/year → trending
    assert build_theme_lineage._is_trending(
        {"citationCount": 600, "year": 2024}, 2026
    )
    # 2024 paper with 100 cites by 2026 = 50 cites/year → not trending
    assert not build_theme_lineage._is_trending(
        {"citationCount": 100, "year": 2024}, 2026
    )
    # Same-year preprint (uses the 0.5y floor) — 200 cites is fast.
    assert build_theme_lineage._is_trending(
        {"citationCount": 200, "year": 2026}, 2026  # 200 / 0.5 = 400 → trending
    )
    # Established classic (ResNet 2015, 226k cites) — high velocity but
    # NOT trending because it's > 3 years old.
    assert not build_theme_lineage._is_trending(
        {"citationCount": 226_000, "year": 2015}, 2026
    )
    # Boundary: exactly 3 years old still counts.
    assert build_theme_lineage._is_trending(
        {"citationCount": 700, "year": 2023}, 2026  # 700/3 = 233 → trending
    )
    # Missing year → never trending
    assert not build_theme_lineage._is_trending({"citationCount": 9999}, 2026)
    # Future year (S2 metadata oddity) → never trending
    assert not build_theme_lineage._is_trending(
        {"citationCount": 9999, "year": 2030}, 2026
    )


def test_build_skips_classify_for_non_influential_parents(
    tmp_path: Path, monkeypatch
):
    """Issue #50: parents flagged isInfluential=false by S2 must skip the
    LLM classify call entirely — those are 'background only' refs that we
    don't want to spend Groq TPM on."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2023)
    parent_yes = {
        **_mk_s2_paper("p_yes", title="INFL parent", year=2018),
        "_is_influential": True,
    }
    parent_no = {
        **_mk_s2_paper("p_no", title="BACKGROUND only", year=2018),
        "_is_influential": False,
    }
    parent_unknown = {
        **_mk_s2_paper("p_unk", title="UNKNOWN flag", year=2018),
        "_is_influential": None,
    }

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            return_value=[parent_yes, parent_no, parent_unknown],
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=8, since_year=None
        )
    payload = json.loads(out_path.read_text())

    # All three parents should appear as nodes (skipped only the relation
    # derivation, not the node — keeping the node preserves the
    # chronological viewer).
    node_ids = {n["id"] for n in payload["nodes"]}
    assert {"seed", "p_yes", "p_no", "p_unk"} <= node_ids

    # Issue #53: derive_relation skips non-influential parents → no edge
    # for "p_no", but emits edges for the True / None branches.
    edge_srcs = {e["src"] for e in payload["edges"]}
    assert "p_no" not in edge_srcs, (
        "non-influential parent must NOT produce an edge"
    )
    assert "p_yes" in edge_srcs, (
        "influential parent should produce an edge"
    )
    assert "p_unk" in edge_srcs, (
        "missing flag (older cache) must NOT be treated as a hard reject — "
        "fall back to extends so we don't regress on existing themes"
    )


def test_main_returns_0_on_normal_build(tmp_path: Path, monkeypatch):
    """Sanity: a healthy build (some edges) still returns 0."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2020)
    parent = _mk_s2_paper("parent", year=2015)
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(build_theme_lineage, "fetch_related", return_value=[parent]),
    ):
        rc = build_theme_lineage.main([
            "--theme", "X",
            "--depth", "1",
            "--seeds", "1",
            "--width", "4",
            "--output", str(tmp_path / "out.json"),
        ])
    assert rc == 0, f"expected exit 0 on healthy build, got {rc}"


# ---- LLM-zero relation derivation (#53) -------------------------------------


def test_derive_relation_methodology_intent_to_extends():
    """S2 intent=methodology means citing paper used the cited paper's
    method → relation = extends."""
    parent = {"_is_influential": True, "_intents": ["methodology"]}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "extends"


def test_derive_relation_result_intent_to_successor():
    parent = {"_is_influential": True, "_intents": ["result"]}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "successor"


def test_derive_relation_background_intent_to_baseline_only():
    parent = {"_is_influential": True, "_intents": ["background"]}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "baseline_only"


def test_derive_relation_methodology_takes_precedence_over_background():
    """Multi-intent: methodology > result > background."""
    parent = {"_is_influential": True, "_intents": ["background", "methodology"]}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "extends"


def test_derive_relation_no_intents_falls_back_to_extends():
    """Missing intents (older cache or S2 omission), no year info → assume
    extends. #80: when year + cite are available the heuristic refines
    further (see test_derive_relation_heuristic_*)."""
    parent = {"_is_influential": True, "_intents": None}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "extends"


# ---- #80: heuristic refinement when intents missing -------------------------


def test_derive_relation_supersedes_via_heuristic():
    """3+ year gap + child citation count overtakes parent → supersedes."""
    parent = {"_is_influential": True, "year": 2017, "citationCount": 1000}
    child = {"year": 2022, "citationCount": 5000}
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "supersedes"


def test_derive_relation_contrasts_via_heuristic():
    """Same / next year + similar citation profile → contrasts (parallel)."""
    parent = {"_is_influential": True, "year": 2023, "citationCount": 800}
    child = {"year": 2023, "citationCount": 600}
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "contrasts"


def test_derive_relation_ablation_via_heuristic():
    """Within 2y + tiny child cite count alongside high-cite parent →
    ablation-style follow-up."""
    parent = {"_is_influential": True, "year": 2022, "citationCount": 5000}
    child = {"year": 2024, "citationCount": 30}
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "ablation"


def test_derive_relation_successor_via_heuristic():
    """1-5 year gap, no other strong signal → successor."""
    parent = {"_is_influential": True, "year": 2020, "citationCount": 200}
    child = {"year": 2022, "citationCount": 200}
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "successor"


def test_derive_relation_long_lineage_falls_back_to_extends():
    """6+ year gap with no special signals → extends (long-running line)."""
    parent = {"_is_influential": True, "year": 2010, "citationCount": 200}
    child = {"year": 2024, "citationCount": 50}
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "extends"


def test_derive_relation_intents_take_precedence_over_heuristic():
    """When intents are present, year/cite heuristic never runs."""
    parent = {
        "_is_influential": True,
        "_intents": ["methodology"],
        "year": 2020, "citationCount": 1000,
    }
    child = {"year": 2024, "citationCount": 5000}  # would normally → supersedes
    rel = build_theme_lineage.derive_relation(parent, parent=parent, child=child)
    assert rel is not None and rel["relation"] == "extends"  # methodology wins


def test_derive_relation_non_influential_returns_none():
    """isInfluential=False → drop the edge entirely."""
    parent = {"_is_influential": False, "_intents": ["methodology"]}
    assert build_theme_lineage.derive_relation(parent) is None


def test_derive_relation_attaches_rationale():
    """Result must include a non-empty rationale (so the edge survives the
    stage-4 'drop empty rationale' filter)."""
    parent = {"_is_influential": True, "_intents": ["methodology"]}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None
    assert isinstance(rel.get("rationale"), str)
    assert len(rel["rationale"].strip()) > 0
    assert isinstance(rel.get("confidence"), float)
    assert 0.0 <= rel["confidence"] <= 1.0


def test_build_theme_lineage_makes_zero_classify_calls(tmp_path, monkeypatch):
    """End-to-end: intent-based derivation produces edges without invoking
    provider.classify_relation or provider._chat (issue #53 acceptance)."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    provider = _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2023)
    p1 = {
        **_mk_s2_paper("p1", title="Method ref", year=2018),
        "_is_influential": True,
        "_intents": ["methodology"],
    }
    p2 = {
        **_mk_s2_paper("p2", title="Background ref", year=2017),
        "_is_influential": True,
        "_intents": ["background"],
    }

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            return_value=[p1, p2],
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=8, since_year=None
        )

    payload = json.loads(out_path.read_text())
    rels = sorted({e["rel"] for e in payload["edges"]})
    # The BFS-derived edges (p1→seed methodology, p2→seed background) must
    # both be present; cross-node may add more edges between p1/p2 since
    # the test's fetch_related stub returns [p1, p2] for any caller. We
    # care that the intent-derived relations are picked up correctly, not
    # the exact count.
    assert "extends" in rels and "baseline_only" in rels, (
        f"expected at least extends + baseline_only from intents, got: {rels}"
    )
    # The acceptance criteria: NO LLM calls fired during the build.
    assert provider.chat_calls == [], (
        f"expected zero _chat calls (LLM-free), got {len(provider.chat_calls)}: "
        f"{[c[1][:60] for c in provider.chat_calls]}"
    )
    assert provider.classify_calls == [], (
        f"expected zero classify_relation calls, got {len(provider.classify_calls)}"
    )


# ---- Cross-node edges (#54) -------------------------------------------------


def test_build_adds_cross_node_edges(tmp_path: Path, monkeypatch):
    """Issue #54: when two nodes already in the graph cite each other,
    the cross-node pass must add an edge that BFS missed.

    Setup: 2 seeds (s1, s2) where s1 cites s2 (s2 is in s1's references).
    BFS produces (s2_parent → s2) but never (s2 → s1). Cross-node should
    detect the in-graph citation and add it.
    """
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    s1 = _mk_s2_paper("seed1", title="Newer paper", year=2023)
    s2 = _mk_s2_paper("seed2", title="Older paper", year=2020)
    p_for_s2 = {
        **_mk_s2_paper("p_s2", year=2018),
        "_is_influential": True,
        "_intents": ["methodology"],
    }
    # The cross-node-only edge: s1 cites s2 → after collection, derive
    # an edge from s2 (parent) → s1 (child). _intents must be set so
    # derive_relation produces a relation.
    s2_in_s1_refs = {
        **_mk_s2_paper("seed2", title="Older paper", year=2020),
        "_is_influential": True,
        "_intents": ["methodology"],
    }

    def fake_fetch_related(paper_id, kind, limit):
        if kind != "references":
            return []
        if paper_id == "seed1":
            # During the cross-node pass: seed1's refs include seed2.
            return [s2_in_s1_refs]
        if paper_id == "seed2":
            # During BFS: seed2's parents.
            return [p_for_s2]
        return []

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([s1, s2]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            side_effect=fake_fetch_related,
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=2, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    edge_pairs = {(e["src"], e["dst"]) for e in payload["edges"]}
    # BFS edge: p_s2 → seed2 (parent of seed2)
    assert ("p_s2", "seed2") in edge_pairs
    # Cross-node edge: seed2 → seed1 (because seed1 cites seed2)
    assert ("seed2", "seed1") in edge_pairs, (
        f"cross-node should add seed2→seed1, got: {edge_pairs}"
    )


def test_build_cross_node_does_not_duplicate_existing_edges(
    tmp_path: Path, monkeypatch
):
    """If BFS already produced (parent → seed), the cross-node pass must
    NOT add a duplicate when the same parent shows up in references."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    seed = _mk_s2_paper("seed", year=2023)
    parent = {
        **_mk_s2_paper("parent", year=2018),
        "_is_influential": True,
        "_intents": ["methodology"],
    }

    def fake_fetch_related(paper_id, kind, limit):
        if kind != "references":
            return []
        # Both seed (BFS) and parent (cross-node pass) have refs that lead
        # to the same parent node.
        if paper_id == "seed":
            return [parent]
        if paper_id == "parent":
            return []
        return []

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            side_effect=fake_fetch_related,
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=1, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    pairs = [(e["src"], e["dst"]) for e in payload["edges"]]
    assert pairs.count(("parent", "seed")) == 1, (
        f"expected exactly one parent→seed edge, got: {pairs}"
    )


def test_build_cross_node_skips_non_influential_in_graph_refs(
    tmp_path: Path, monkeypatch
):
    """isInfluential=False refs in the cross-node pass must be dropped
    just like in BFS — derive_relation returns None for them."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    s1 = _mk_s2_paper("seed1", year=2023)
    s2 = _mk_s2_paper("seed2", year=2020)

    # s1 → s2 cite, but flagged non-influential. Cross-node must skip.
    s2_as_ref = {
        **_mk_s2_paper("seed2", year=2020),
        "_is_influential": False,
        "_intents": ["background"],
    }

    def fake_fetch_related(paper_id, kind, limit):
        if paper_id == "seed1" and kind == "references":
            return [s2_as_ref]
        return []

    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([s1, s2]),
        ),
        patch.object(
            build_theme_lineage,
            "fetch_related",
            side_effect=fake_fetch_related,
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="X", depth=1, seeds_count=2, width=4, since_year=None
        )
    payload = json.loads(out_path.read_text())
    edge_pairs = {(e["src"], e["dst"]) for e in payload["edges"]}
    assert ("seed2", "seed1") not in edge_pairs, (
        "non-influential cross-node ref must not produce an edge"
    )


# ---- GitHub stars enrichment (#89, refactored after PwC shutdown) ----
#
# Resolution order: paperpilot/data/paper_repos.json (curated) → GitHub
# Search by paper title (similarity-filtered). The earlier PwC-based
# flow was removed when paperswithcode.com was decommissioned in 2026.


def _make_fake_resolvers(
    *,
    repos_by_ax: dict[str, str] | None = None,
    repos_by_title: dict[str, str] | None = None,
    stars_by_repo: dict[str, int] | None = None,
):
    """Build fake (curated, search_repo, fetch_stars) resolvers for tests.

    - ``repos_by_ax`` is the curated mapping passed as the ``curated``
      parameter to ``_enrich_github_stars``.
    - ``repos_by_title`` is consulted by the fake ``search_repo``
      (substring match against the candidate title, lowercased).
    - ``stars_by_repo`` is consulted by the fake ``fetch_stars``
      (returns ``None`` for unmapped repos so the function under test
      can exercise the "fetched but no stars" branch).
    """
    repos_by_title = repos_by_title or {}
    stars_by_repo = stars_by_repo or {}

    def fake_search(title, *, github_token=None):
        t = (title or "").lower()
        for needle, repo in repos_by_title.items():
            if needle.lower() in t:
                return repo
        return None

    def fake_fetch(repo_full, *, github_token=None):
        if repo_full in stars_by_repo:
            return stars_by_repo[repo_full]
        return None

    return repos_by_ax or {}, fake_search, fake_fetch


def test_enrich_github_stars_skips_nodes_without_arxiv_id(tmp_path, monkeypatch):
    """Nodes with no arxiv_id must not trigger any resolver."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {
        "p1": {"id": "p1", "github_stars": 0},
        "p2": {"id": "p2", "github_stars": 0, "arxiv_id": ""},
    }
    search = MagicMock(return_value=None)
    fetch = MagicMock(return_value=None)
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated={}, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 0
    search.assert_not_called()
    fetch.assert_not_called()


def test_enrich_github_stars_uses_curated_map_first(tmp_path, monkeypatch):
    """A curated arxiv_id -> repo entry must skip the search step entirely."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {
        "p1": {
            "id": "p1", "github_stars": 0,
            "arxiv_id": "2304.02643",
            "title": "Segment Anything",
        },
    }
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={"2304.02643": "facebookresearch/segment-anything"},
        stars_by_repo={"facebookresearch/segment-anything": 46000},
    )
    search_mock = MagicMock(side_effect=search)
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search_mock, fetch_stars=fetch,
    )
    assert enriched == 1
    assert nodes["p1"]["github_stars"] == 46000
    assert nodes["p1"]["github_url"] == (
        "https://github.com/facebookresearch/segment-anything"
    )
    # Curated hit short-circuits the search call.
    search_mock.assert_not_called()


def test_enrich_github_stars_falls_back_to_search(tmp_path, monkeypatch):
    """When the arxiv_id is not in the curated map, search_repo must be called."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {
        "p1": {
            "id": "p1", "github_stars": 0,
            "arxiv_id": "9999.99999",
            "title": "Some Niche Paper",
        },
    }
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={},
        repos_by_title={"some niche paper": "owner/some-niche-paper"},
        stars_by_repo={"owner/some-niche-paper": 12},
    )
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 1
    assert nodes["p1"]["github_stars"] == 12
    assert nodes["p1"]["github_url"] == "https://github.com/owner/some-niche-paper"


def test_enrich_github_stars_caches_results_to_disk(tmp_path, monkeypatch):
    """Cache file must persist arxiv_id -> stars/url with a fetched_at timestamp."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {"p1": {"id": "p1", "arxiv_id": "1610.04256", "github_stars": 0}}
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={"1610.04256": "x/y"},
        stars_by_repo={"x/y": 42},
    )
    build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search, fetch_stars=fetch,
    )
    cache = json.loads((tmp_path / "github_stars.json").read_text())
    assert "1610.04256" in cache
    entry = cache["1610.04256"]
    assert entry["stars"] == 42
    assert entry["url"] == "https://github.com/x/y"
    assert entry["fetched_at"]  # ISO timestamp


def test_enrich_github_stars_uses_fresh_cache_without_resolving(
    tmp_path, monkeypatch
):
    """A within-TTL cache hit must short-circuit both curated and search."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    from datetime import datetime, timezone
    fresh_ts = datetime.now(timezone.utc).isoformat()
    (tmp_path / "github_stars.json").write_text(json.dumps({
        "2103.00020": {
            "stars": 999,
            "url": "https://github.com/cached/repo",
            "fetched_at": fresh_ts,
        }
    }))
    nodes = {"p1": {"id": "p1", "arxiv_id": "2103.00020", "github_stars": 0}}
    search = MagicMock()
    fetch = MagicMock()
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated={}, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 1
    assert nodes["p1"]["github_stars"] == 999
    assert nodes["p1"]["github_url"] == "https://github.com/cached/repo"
    search.assert_not_called()
    fetch.assert_not_called()


def test_enrich_github_stars_drops_poisoned_cache_url(tmp_path, monkeypatch):
    """A corrupt or attacker-supplied cache entry with a non-github URL
    must not be propagated into the generated lineage.json — the
    cached URL is re-validated through ``parse_github_repo_url``
    before being assigned to the node."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    from datetime import datetime, timezone
    fresh_ts = datetime.now(timezone.utc).isoformat()
    (tmp_path / "github_stars.json").write_text(json.dumps({
        # Stars value is real but the URL has been swapped for a
        # ``javascript:`` payload — the kind of thing a poisoned cache
        # could contain.
        "1234.5678": {
            "stars": 42,
            "url": "javascript:alert('xss')",
            "fetched_at": fresh_ts,
        },
        # A separately poisoned entry pointing at a non-github host.
        "9999.99": {
            "stars": 99,
            "url": "https://evil.example.com/owner/repo",
            "fetched_at": fresh_ts,
        },
    }))
    nodes = {
        "a": {"id": "a", "arxiv_id": "1234.5678", "github_stars": 0},
        "b": {"id": "b", "arxiv_id": "9999.99", "github_stars": 0},
    }
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated={}, search_repo=MagicMock(), fetch_stars=MagicMock(),
    )
    # Stars survive (cache value is still useful) but the malformed
    # URLs are dropped so they cannot reach the rendered viewer.
    assert enriched == 2
    assert nodes["a"]["github_stars"] == 42
    assert "github_url" not in nodes["a"]
    assert nodes["b"]["github_stars"] == 99
    assert "github_url" not in nodes["b"]


def test_enrich_github_stars_refreshes_stale_cache(tmp_path, monkeypatch):
    """Cache entries older than the TTL must be refetched, not used."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    from datetime import datetime, timedelta, timezone
    stale_ts = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    (tmp_path / "github_stars.json").write_text(json.dumps({
        "1706.03762": {
            "stars": 100,
            "url": "https://github.com/old/repo",
            "fetched_at": stale_ts,
        }
    }))
    nodes = {"p1": {"id": "p1", "arxiv_id": "1706.03762", "github_stars": 0}}
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={"1706.03762": "new/repo"},
        stars_by_repo={"new/repo": 5000},
    )
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 1
    assert nodes["p1"]["github_stars"] == 5000  # fresh, not stale 100
    assert nodes["p1"]["github_url"] == "https://github.com/new/repo"


def test_enrich_github_stars_caches_zero_when_no_repo_found(
    tmp_path, monkeypatch
):
    """Papers neither in the curated map nor matched by search must be
    cached as stars=0 so we don't re-query them every week."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {"p1": {"id": "p1", "arxiv_id": "1234.5678", "github_stars": 0}}
    curated, search, fetch = _make_fake_resolvers()  # all empty
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 0
    cache = json.loads((tmp_path / "github_stars.json").read_text())
    assert cache["1234.5678"]["stars"] == 0
    assert cache["1234.5678"]["url"] is None


def test_enrich_github_stars_no_op_when_no_arxiv_nodes(tmp_path, monkeypatch):
    """Empty target list must skip resolvers and not write a cache file."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {"p1": {"id": "p1", "github_stars": 0}}
    search = MagicMock()
    fetch = MagicMock()
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated={}, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 0
    search.assert_not_called()
    fetch.assert_not_called()
    assert not (tmp_path / "github_stars.json").exists()


def test_enrich_github_stars_invoked_by_pipeline(tmp_path, monkeypatch):
    """End-to-end: build_theme_lineage must call _enrich_github_stars after
    node assembly so the JSON ships with stars populated."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)
    # #126 followup: seed title must include theme words for the topic
    # relevance gate to keep it. The default stub title doesn't match
    # "Mixture of Experts" and would otherwise be filtered out.
    seed = {
        **_mk_s2_paper("seed1", title="Mixture of Experts paper", year=2017),
        "externalIds": {"ArXiv": "1701.06538"},
    }
    parent = {
        **_mk_s2_paper("p_parent", year=2014),
        "externalIds": {"ArXiv": "1409.0473"},
        "_is_influential": True,
        "_intents": ["methodology"],
    }

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([seed])
        return _mk_s2_search_response([])

    captured: dict[str, Any] = {}

    def fake_enrich(nodes, **kw):
        captured["called"] = True
        captured["arxiv_ids"] = sorted(
            n.get("arxiv_id") for n in nodes.values() if n.get("arxiv_id")
        )
        for node in nodes.values():
            if node.get("arxiv_id") == "1701.06538":
                node["github_stars"] = 5000
                node["github_url"] = "https://github.com/google/moe"
        return 1

    monkeypatch.setattr(build_theme_lineage, "_enrich_github_stars", fake_enrich)

    with (
        patch.object(
            build_theme_lineage, "request_with_retry", side_effect=fake_rwr
        ),
        patch.object(
            build_theme_lineage, "fetch_related", return_value=[parent]
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Mixture of Experts",
            depth=1, seeds_count=1, width=2, since_year=None,
        )

    assert captured.get("called") is True
    assert "1701.06538" in captured["arxiv_ids"]
    assert "1409.0473" in captured["arxiv_ids"]

    payload = json.loads(out_path.read_text())
    seed_node = next(n for n in payload["nodes"] if n["id"] == "seed1")
    assert seed_node["github_stars"] == 5000
    assert seed_node["github_url"] == "https://github.com/google/moe"


def test_enrich_github_stars_handles_corrupt_cache_file(tmp_path, monkeypatch):
    """A malformed cache file must not crash the run; treat as empty."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    (tmp_path / "github_stars.json").write_text("not-json{{{")
    nodes = {"p1": {"id": "p1", "arxiv_id": "1234.5678", "github_stars": 0}}
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={"1234.5678": "a/b"},
        stars_by_repo={"a/b": 7},
    )
    enriched = build_theme_lineage._enrich_github_stars(
        nodes, curated=curated, search_repo=search, fetch_stars=fetch,
    )
    assert enriched == 1
    assert nodes["p1"]["github_stars"] == 7


def test_enrich_github_stars_does_not_cache_papers_past_budget(
    tmp_path, monkeypatch
):
    """Papers past max_lookups must NOT be stamped 0 in the cache.

    Otherwise the entry would be suppressed for the full TTL window
    despite never having been queried.
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {
        "p1": {"id": "p1", "arxiv_id": "ax-1", "github_stars": 0},
        "p2": {"id": "p2", "arxiv_id": "ax-2", "github_stars": 0},
        "p3": {"id": "p3", "arxiv_id": "ax-3", "github_stars": 0},
    }
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={
            "ax-1": "a/r1",
            "ax-2": "a/r2",
            "ax-3": "a/r3",
        },
        stars_by_repo={"a/r1": 99, "a/r2": 88, "a/r3": 77},
    )
    fetch_mock = MagicMock(side_effect=fetch)
    build_theme_lineage._enrich_github_stars(
        nodes, max_lookups=1, curated=curated,
        search_repo=search, fetch_stars=fetch_mock,
    )
    assert fetch_mock.call_count == 1  # only the first paper resolved
    cache = json.loads((tmp_path / "github_stars.json").read_text())
    assert "ax-1" in cache
    assert "ax-2" not in cache
    assert "ax-3" not in cache


# Note: helper-level unit tests (load_curated_map / title_similarity /
# search_repo_by_title / fetch_repo_stars) live in
# paperpilot/tests/test_utils_github.py since those primitives moved
# into paperpilot/utils/github.py for #92. The orchestration tests
# below (which exercise _enrich_github_stars + the pipeline integration)
# stay here because they are theme-pipeline specific.


def test_enrich_github_stars_counts_curated_and_search_separately(
    tmp_path, monkeypatch, caplog
):
    """Resolution-path counters must reflect WHERE the repo came from,
    not whether the eventual fetch returned > 0 stars. A curated repo
    that returned 0 stars must still count as a curated hit so the log
    line is not misleading."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    nodes = {
        "p1": {"id": "p1", "arxiv_id": "ax-curated-zero", "title": "x" * 20},
        "p2": {"id": "p2", "arxiv_id": "ax-search", "title": "Searchable Paper Name"},
    }
    curated, search, fetch = _make_fake_resolvers(
        repos_by_ax={"ax-curated-zero": "owner/private-repo"},
        repos_by_title={"searchable paper name": "owner/found-by-search"},
        # private-repo returns 0 stars; found-by-search returns 50.
        stars_by_repo={"owner/private-repo": 0, "owner/found-by-search": 50},
    )
    with caplog.at_level(logging.INFO, logger="paperpilot.scripts.build_theme_lineage"):
        build_theme_lineage._enrich_github_stars(
            nodes, curated=curated, search_repo=search, fetch_stars=fetch,
        )
    log = " ".join(r.message for r in caplog.records)
    # Curated hit counts even when stars=0 — this is the regression guard.
    assert "curated=1" in log
    assert "search=1" in log
    # Only one paper actually had stars > 0, so the third tally reads 1.
    assert "stars>0=1" in log


# ---- OpenAlex fallback (S2 throttle relief) ----------------------------------
#
# When S2 /paper/search returns 0 (or fewer than top_n) seeds — the steady-state
# failure mode on GitHub Actions runners since the shared IP pool is throttled
# by S2's free tier — the pipeline must transparently fall back to OpenAlex
# search and resolve the resulting works to S2 paperIds via /paper/batch (a
# separate endpoint with a different rate-limit budget than /paper/search).
# These tests pin the fallback contract so a future refactor cannot silently
# regress the CI-pipeline-survival property.


def _mk_openalex_response(works: list[dict]) -> MagicMock:
    """Wrap OpenAlex /works results in a MagicMock response."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json = lambda: {"results": works}
    return resp


def _mk_openalex_work(
    *,
    title: str = "Theme Paper",
    doi: str | None = "10.1234/test",
    year: int = 2020,
    cites: int = 100,
    openalex_id: str = "https://openalex.org/W1",
) -> dict:
    work: dict = {
        "id": openalex_id,
        "title": title,
        "publication_year": year,
        "publication_date": f"{year}-01-01",
        "cited_by_count": cites,
        "ids": {"openalex": openalex_id},
    }
    if doi is not None:
        # OpenAlex returns DOIs as full URLs; the fallback parser must
        # tolerate both `https://doi.org/10.x/y` and bare `10.x/y`.
        work["doi"] = f"https://doi.org/{doi}"
        work["ids"]["doi"] = f"https://doi.org/{doi}"
    return work


def _mk_s2_batch_response(papers: list) -> MagicMock:
    """Wrap S2 /paper/batch response (a JSON array, possibly with nulls).

    `papers` is typed as a plain `list` so callers can pass either a
    ``list[dict]`` or a mixed ``list[dict | None]`` without invariance
    headaches. The S2 batch endpoint inserts None entries for unmatched
    ids — both shapes need to be testable.
    """
    resp = MagicMock()
    resp.status_code = 200
    resp.json = lambda: papers
    return resp


def test_openalex_fallback_invoked_when_s2_returns_zero(tmp_path, monkeypatch):
    """S2 /paper/search returning 0 results triggers OpenAlex; OpenAlex
    DOIs are then resolved through S2 /paper/batch and surfaced as seeds."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    oa_work = _mk_openalex_work(title="Theme paper", doi="10.1/a", year=2020, cites=200)
    s2_paper = _mk_s2_paper("p_resolved", year=2020, cites=200)

    calls: list[tuple[str, str]] = []

    def fake_rwr(method, url, **kw):
        calls.append((method, url))
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            return _mk_openalex_response([oa_work])
        if "/paper/batch" in url:
            return _mk_s2_batch_response([s2_paper])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["mixture of experts"],
            top_n=5,
            since_year=None,
        )

    assert {s["paperId"] for s in seeds} == {"p_resolved"}
    urls = [c[1] for c in calls]
    assert any("openalex.org" in u for u in urls)
    assert any("/paper/batch" in u for u in urls)


def test_openalex_fallback_skipped_when_s2_meets_quota(tmp_path, monkeypatch):
    """S2 search alone produces >= top_n seeds → OpenAlex MUST NOT be hit
    (preserves the fast happy path; OpenAlex is purely a fallback)."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    s2_papers = [_mk_s2_paper(f"p{i}", cites=1000 - i) for i in range(5)]
    calls: list[str] = []

    def fake_rwr(method, url, **kw):
        calls.append(url)
        if "/paper/search" in url:
            return _mk_s2_search_response(s2_papers)
        return MagicMock(status_code=200, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    assert len(seeds) == 5
    assert not any("openalex.org" in u for u in calls)
    assert not any("/paper/batch" in u for u in calls)


def test_openalex_fallback_invoked_when_s2_returns_partial(tmp_path, monkeypatch):
    """S2 returns 1 seed but caller asked for 5 → fallback fills the gap."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    s2_partial = [_mk_s2_paper("p_s2", cites=500)]
    oa_work = _mk_openalex_work(title="Other paper", doi="10.2/b", cites=300)
    s2_resolved = _mk_s2_paper("p_oa_resolved", cites=300)

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response(s2_partial)
        if "openalex.org/works" in url:
            return _mk_openalex_response([oa_work])
        if "/paper/batch" in url:
            return _mk_s2_batch_response([s2_resolved])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    assert {s["paperId"] for s in seeds} == {"p_s2", "p_oa_resolved"}


def test_openalex_search_includes_polite_pool_email(tmp_path, monkeypatch):
    """When openalex_email is provided, OpenAlex /works request must carry
    a `mailto` query param (polite pool — more reliable under load)."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    captured_params: dict = {}

    def fake_rwr(method, url, **kw):
        if "openalex.org/works" in url:
            captured_params.update(kw.get("params") or {})
            return _mk_openalex_response([])
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
            openalex_email="research@example.com",
        )

    assert captured_params.get("mailto") == "research@example.com"


def test_openalex_search_filters_by_since_year(tmp_path, monkeypatch):
    """since_year propagates to OpenAlex as `from_publication_date:YYYY-01-01`."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    captured: dict = {}

    def fake_rwr(method, url, **kw):
        if "openalex.org/works" in url:
            captured.update(kw.get("params") or {})
            return _mk_openalex_response([])
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=2020,
        )

    flt = captured.get("filter") or ""
    assert "from_publication_date:2020-01-01" in flt


def test_openalex_handles_empty_results(tmp_path, monkeypatch):
    """OpenAlex returning 0 works → no S2 batch call, fallback returns []."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    openalex_called: list[str] = []
    batch_called: list[str] = []

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            openalex_called.append(url)
            return _mk_openalex_response([])
        if "/paper/batch" in url:
            batch_called.append(url)
            return _mk_s2_batch_response([])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    assert seeds == []
    assert len(openalex_called) == 1, "OpenAlex must be tried when S2 yields 0"
    assert batch_called == []


def test_openalex_handles_failure_gracefully(tmp_path, monkeypatch):
    """OpenAlex returning None (network failure / 5xx after retries):
    no crash, fallback contributes 0 seeds, primary S2 result is returned."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    openalex_called: list[str] = []

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            openalex_called.append(url)
            return None
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    assert seeds == []
    assert len(openalex_called) == 1, "OpenAlex must be attempted before giving up"


def test_resolve_to_s2_batch_uses_doi_prefix(tmp_path, monkeypatch):
    """OpenAlex DOIs must be sent to /paper/batch as `DOI:<bare_doi>` in
    the `ids` array (S2 expects the prefix; the URL form is a parse
    error — see manual repro from this branch's commit message)."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    oa_works = [
        _mk_openalex_work(title="A", doi="10.1/a", openalex_id="https://openalex.org/W1"),
        _mk_openalex_work(title="B", doi="10.2/b", openalex_id="https://openalex.org/W2"),
    ]
    captured_body: dict = {}

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            return _mk_openalex_response(oa_works)
        if "/paper/batch" in url:
            captured_body.update(kw.get("json_body") or {})
            return _mk_s2_batch_response(
                [_mk_s2_paper("p1"), _mk_s2_paper("p2")]
            )
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    ids = captured_body.get("ids") or []
    assert "DOI:10.1/a" in ids
    assert "DOI:10.2/b" in ids


def test_resolve_to_s2_batch_handles_429(tmp_path, monkeypatch):
    """S2 /paper/batch returning None (persistent 429): graceful empty seeds."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    oa_work = _mk_openalex_work(title="A", doi="10.1/a")
    batch_called: list[str] = []

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            return _mk_openalex_response([oa_work])
        if "/paper/batch" in url:
            batch_called.append(url)
            return None
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    assert seeds == []
    assert len(batch_called) == 1, "S2 batch must be attempted when OpenAlex finds DOIs"


def test_no_openalex_fallback_flag_disables_fallback(tmp_path, monkeypatch):
    """use_openalex_fallback=False prevents OpenAlex even when S2 returns 0."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    calls: list[str] = []

    def fake_rwr(method, url, **kw):
        calls.append(url)
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
            use_openalex_fallback=False,
        )

    assert seeds == []
    assert not any("openalex.org" in u for u in calls)


def test_openalex_fallback_skips_works_without_doi(tmp_path, monkeypatch):
    """OpenAlex works without a DOI cannot be resolved through S2 batch;
    they must be silently skipped, not poison the request body."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    work_with = _mk_openalex_work(title="A", doi="10.1/a")
    work_without = _mk_openalex_work(title="B", doi=None)
    captured_body: dict = {}

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response([])
        if "openalex.org/works" in url:
            return _mk_openalex_response([work_with, work_without])
        if "/paper/batch" in url:
            captured_body.update(kw.get("json_body") or {})
            return _mk_s2_batch_response([_mk_s2_paper("p1")])
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    ids = captured_body.get("ids") or []
    assert ids == ["DOI:10.1/a"]


def test_openalex_fallback_dedups_against_s2_seeds(tmp_path, monkeypatch):
    """Same paperId surfaced by both S2 and OpenAlex+batch → single entry.

    This pins the dedup semantics specifically — without dedup, the
    overlap would surface as a duplicate row in the chronological tree.
    A new ``p_extra`` from the fallback proves the merge actually ran;
    asserting only on ``p_shared`` would pass even if fallback were
    completely skipped.
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    s2_partial = [_mk_s2_paper("p_shared", cites=500)]
    oa_works = [
        _mk_openalex_work(title="dup", doi="10.dup/x"),
        _mk_openalex_work(title="extra", doi="10.extra/y", openalex_id="https://openalex.org/W2"),
    ]
    s2_batch_results = [
        _mk_s2_paper("p_shared", cites=500),
        _mk_s2_paper("p_extra", cites=300),
    ]

    def fake_rwr(method, url, **kw):
        if "/paper/search" in url:
            return _mk_s2_search_response(s2_partial)
        if "openalex.org/works" in url:
            return _mk_openalex_response(oa_works)
        if "/paper/batch" in url:
            return _mk_s2_batch_response(s2_batch_results)
        return MagicMock(status_code=404, json=lambda: {})

    with patch.object(build_theme_lineage, "request_with_retry", side_effect=fake_rwr):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["x"], top_n=5, since_year=None,
        )

    paper_ids = [s["paperId"] for s in seeds]
    assert paper_ids.count("p_shared") == 1
    assert "p_extra" in paper_ids, "fallback must have run and added the new paper"


def test_build_pipeline_passes_openalex_email_from_env(tmp_path, monkeypatch):
    """build_theme_lineage() reads openalex_email from load_env() and
    threads it through to discover_seeds() so the polite-pool path works
    end-to-end without the operator passing it explicitly.

    Patches ``build_theme_lineage.load_env`` directly because the module
    binds the symbol at import time (``from … import load_env``) — the
    standard ``_patch_env`` helper, which patches the source module's
    binding, doesn't reach this caller's frame.
    """
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")
    monkeypatch.setattr(
        build_theme_lineage,
        "load_env",
        lambda *a, **kw: {"openalex_email": "researcher@example.com"},
    )
    _stub_external_calls(monkeypatch)

    captured: dict = {}

    def spy_discover(**kw):
        captured.update(kw)
        return []

    with (
        patch.object(build_theme_lineage, "discover_seeds", side_effect=spy_discover),
        patch.object(build_theme_lineage, "fetch_related", return_value=[]),
    ):
        build_theme_lineage.build_theme_lineage(
            theme="Test", depth=1, seeds_count=1, width=4, since_year=None,
        )

    assert captured.get("openalex_email") == "researcher@example.com"


# ---- Quality improvements (#126 followup) ----
# Two families of fixes after real users observed off-topic noise in the
# generated lineages:
#   (A) Foundational-paper filter for BFS parents — drop ResNet / Attention
#       Is All You Need / PyTorch / NumPy etc. when they show up as
#       references from a theme-specific seed but aren't actually part of
#       the lineage (cite >> theme && no methodology intent).
#   (D) Topic relevance filter for seeds — multi-word themes require at
#       least half the (3+ char) words to appear in the title or abstract,
#       so a search for "Graph Neural Network" can't latch onto the
#       Pandas paper just because S2 ranks it highly.


def test_filter_off_topic_refs_drops_high_cite_no_methodology():
    """A parent cited 50x more than the theme's max seed cite must be
    dropped unless it has a methodology intent. This is the GNN-theme bug:
    ResNet at 228k cites slipping into a graph attention paper's tree."""
    parents = [
        {**_mk_s2_paper("p_normal", cites=8_000), "_is_influential": True},
        # 100x more cited than max_seed_cite=8000, no methodology intent →
        # foundational, drop.
        {**_mk_s2_paper("p_foundational", cites=800_000), "_is_influential": True},
    ]
    kept = build_theme_lineage._filter_off_topic_refs(parents, max_seed_cite=8_000)
    kept_ids = [p["paperId"] for p in kept]
    assert "p_normal" in kept_ids
    assert "p_foundational" not in kept_ids


def test_filter_off_topic_refs_keeps_methodology_intent():
    """The same high-cite parent must be kept when S2 flagged the citation
    with a methodology intent — the citing paper actually built on top of
    this foundational work, so it belongs in the lineage."""
    parents = [
        {
            **_mk_s2_paper("p_kept", cites=800_000),
            "_is_influential": True,
            "_intents": ["methodology"],
        },
    ]
    kept = build_theme_lineage._filter_off_topic_refs(parents, max_seed_cite=8_000)
    assert [p["paperId"] for p in kept] == ["p_kept"]


def test_filter_off_topic_refs_keeps_all_when_seeds_have_no_cites():
    """Edge case: max_seed_cite=0 (search returned a paper with no cite
    count). The filter must not divide-by-zero or wipe the parent list."""
    parents = [
        {**_mk_s2_paper("p_a", cites=100_000), "_is_influential": True},
        {**_mk_s2_paper("p_b", cites=50), "_is_influential": True},
    ]
    kept = build_theme_lineage._filter_off_topic_refs(parents, max_seed_cite=0)
    # No threshold to clamp against → keep both, the downstream cite-sort
    # still puts the relevant one near the top.
    assert {p["paperId"] for p in kept} == {"p_a", "p_b"}


def test_filter_topic_relevant_seeds_multi_word_theme():
    """A multi-word theme like 'Graph Neural Network' must drop seeds
    whose title+abstract mention none of the (3+ char) theme words."""
    seeds = [
        # 3/3 words match the title → keep
        _mk_s2_paper("relevant", title="A Graph Neural Network for X",
                     abstract="we propose a GNN to ..."),
        # 0/3 words match anywhere → drop (the Pandas paper bug)
        _mk_s2_paper("irrelevant",
                     title="Data Structures for Statistical Computing",
                     abstract="Practical issues of working with data sets..."),
    ]
    kept = build_theme_lineage._filter_topic_relevant_seeds(
        seeds, theme="Graph Neural Network"
    )
    ids = [s["paperId"] for s in kept]
    assert "relevant" in ids
    assert "irrelevant" not in ids


def test_filter_topic_relevant_seeds_short_theme_skips_filter():
    """Single-word themes (RAG, MoE, BERT) can't be reliably filtered with
    substring matching — short tokens produce false matches and false
    misses. The filter must short-circuit for these so the existing S2
    ranking does the work."""
    seeds = [
        _mk_s2_paper("p1", title="Anything", abstract="anything"),
        _mk_s2_paper("p2", title="Whatever", abstract="whatever"),
    ]
    kept = build_theme_lineage._filter_topic_relevant_seeds(seeds, theme="RAG")
    # Short theme → no filter applied.
    assert len(kept) == 2


def test_filter_topic_relevant_seeds_partial_word_match():
    """If at least half the (3+ char) words match, keep the seed. This is
    the design knob — themes like 'Direct Preference Optimization' should
    still match a seed titled 'Preference Optimization without DPO' even
    if the word 'Direct' doesn't appear."""
    seeds = [
        # 2/3 words ("preference", "optimization") match → keep at 50% threshold
        _mk_s2_paper("partial", title="Preference Optimization without DPO",
                     abstract="we revisit preference optimization without ..."),
    ]
    kept = build_theme_lineage._filter_topic_relevant_seeds(
        seeds, theme="Direct Preference Optimization"
    )
    assert [s["paperId"] for s in kept] == ["partial"]


def test_filter_topic_relevant_seeds_empty_input_returns_empty():
    """Defensive: empty input → empty output, no exception."""
    assert build_theme_lineage._filter_topic_relevant_seeds([], theme="Anything") == []


def test_discover_seeds_filters_irrelevant_seeds(tmp_path: Path, monkeypatch):
    """Integration: discover_seeds() must apply the topic relevance filter
    before _rank_and_truncate, so S2 returning the Pandas paper for a GNN
    search doesn't end up as a top-N seed."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    relevant = _mk_s2_paper(
        "gnn", title="Graph Neural Networks Survey",
        abstract="A comprehensive review of graph neural network methods.",
        cites=200,
    )
    irrelevant = _mk_s2_paper(
        "pandas", title="Data Structures for Statistical Computing in Python",
        abstract="practical issues of working with data sets in pandas.",
        cites=10_000,  # higher cites: would rank higher without the filter
    )
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([relevant, irrelevant]),
    ):
        seeds = build_theme_lineage.discover_seeds(
            keywords=["Graph Neural Network"],
            top_n=10,
            since_year=None,
            use_openalex_fallback=False,
            theme="Graph Neural Network",
        )
    assert [s["paperId"] for s in seeds] == ["gnn"]


def test_build_drops_foundational_parents_in_bfs(tmp_path: Path, monkeypatch):
    """End-to-end: a seed with 8k cites + a parent at 800k cites + no
    methodology intent must NOT produce an edge after the foundational
    filter. Regression pin for the GNN→ResNet bug."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper(
        "seed", title="Graph Attention Network",
        abstract="we propose a graph neural network with attention.",
        year=2018, cites=8_000,
    )
    foundational = {
        **_mk_s2_paper("resnet", title="Deep Residual Learning",
                       year=2015, cites=800_000),
        "_is_influential": True,
        # NO methodology intent.
        "_intents": ["background"],
    }
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage, "fetch_related", return_value=[foundational]
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Graph Neural Network",
            depth=1, seeds_count=1, width=4, since_year=None,
        )
    payload = json.loads(out_path.read_text())
    # Foundational parent must not appear as a node OR an edge endpoint.
    assert "resnet" not in {n["id"] for n in payload["nodes"]}
    assert all(e["src"] != "resnet" and e["dst"] != "resnet"
               for e in payload["edges"])


def test_implementation_foundation_denylist_by_paper_id():
    """Adam (paperId in denylist) must be dropped even with a methodology
    intent — the original filter let it through because GNN papers cite
    Adam with methodology='we use Adam as the optimizer'. The denylist
    overrides that."""
    refs = [
        {
            **_mk_s2_paper("a6cb366736791bcccc5c8639de5a8f9636bf87e8",
                           title="Adam: A Method for Stochastic Optimization",
                           cites=166_000),
            "_is_influential": True,
            "_intents": ["methodology"],
        },
    ]
    # max_seed_cite=25_000 → ceiling=50_000 → Adam at 166k normally would
    # be dropped except for the methodology override. The denylist must
    # win regardless.
    kept = build_theme_lineage._filter_off_topic_refs(refs, max_seed_cite=25_000)
    assert kept == []


def test_implementation_foundation_denylist_by_title_pattern():
    """A future paperId we haven't seen yet (e.g. a new TensorFlow paper)
    must still be caught via the title-pattern fallback."""
    refs = [
        {
            **_mk_s2_paper("NEW_TF_PID_UNSEEN",
                           title="TensorFlow: a future tutorial paper",
                           cites=200_000),
            "_is_influential": True,
            "_intents": ["methodology"],
        },
    ]
    kept = build_theme_lineage._filter_off_topic_refs(refs, max_seed_cite=25_000)
    assert kept == []


def test_implementation_foundation_denylist_keeps_topic_libraries():
    """A library paper that's TOPIC-SPECIFIC (PyTorch Geometric for GNN
    work) must not be wholesale denied because its title contains 'PyTorch'.
    Only the literal 'PyTorch:' (with colon) library paper is in the
    denylist, not derivative geometric/audio/vision sub-libraries."""
    refs = [
        {
            **_mk_s2_paper("63a513832f56addb67be81a2fa399b233f3030fc",
                           title="Fast Graph Representation Learning with PyTorch Geometric",
                           cites=8_000),
            "_is_influential": True,
            "_intents": ["methodology"],
        },
    ]
    kept = build_theme_lineage._filter_off_topic_refs(refs, max_seed_cite=25_000)
    assert len(kept) == 1
    assert kept[0]["paperId"] == "63a513832f56addb67be81a2fa399b233f3030fc"


def test_implementation_foundation_denylist_under_threshold_still_dropped():
    """A denylisted paper with citationCount BELOW the foundational ceiling
    must still be dropped — the denylist is unconditional, not a tiebreaker."""
    refs = [
        {
            **_mk_s2_paper("ad4fd2c149f220a62441576af92a8a669fe81246",
                           title="Scikit-learn: Machine Learning in Python",
                           cites=100),  # tiny cite count, way under ceiling
            "_is_influential": True,
        },
    ]
    kept = build_theme_lineage._filter_off_topic_refs(refs, max_seed_cite=25_000)
    assert kept == []


def test_off_topic_filter_uses_tighter_2x_multiplier():
    """#127 followup: the 3x multiplier let Adam (166k cites / 25k seed =
    6.6x) through only because of methodology intent. With 2x and the
    denylist, the ceiling becomes 50k and Adam — caught by the denylist
    above — never reaches the cite-based check anyway. This test pins
    that a non-foundational, non-denylisted paper at ratio 2.5x is
    correctly DROPPED at the new threshold (regression for the multiplier
    tightening)."""
    refs = [
        {
            **_mk_s2_paper("p_above_2x",
                           title="A Generic Foundational Paper", cites=62_500),
            "_is_influential": True,
            # No methodology intent → cite-only check applies.
            "_intents": ["background"],
        },
    ]
    # 62500 / 25000 = 2.5x → > 2x ceiling → drop.
    kept = build_theme_lineage._filter_off_topic_refs(refs, max_seed_cite=25_000)
    assert kept == []


def test_build_keeps_foundational_parent_with_methodology(tmp_path: Path, monkeypatch):
    """Same setup as the previous test but with a methodology intent —
    the foundational paper is genuinely part of the citing paper's
    technical lineage, so it must stay."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper("seed",
                        title="Graph Attention Network",
                        abstract="graph neural network with attention",
                        year=2018, cites=8_000)
    foundational = {
        **_mk_s2_paper("resnet", title="Deep Residual Learning",
                       year=2015, cites=800_000),
        "_is_influential": True,
        "_intents": ["methodology"],
    }
    with (
        patch.object(
            build_theme_lineage,
            "request_with_retry",
            return_value=_mk_s2_search_response([seed]),
        ),
        patch.object(
            build_theme_lineage, "fetch_related", return_value=[foundational]
        ),
    ):
        out_path = build_theme_lineage.build_theme_lineage(
            theme="Graph Neural Network",
            depth=1, seeds_count=1, width=4, since_year=None,
        )
    payload = json.loads(out_path.read_text())
    # methodology intent → kept.
    assert "resnet" in {n["id"] for n in payload["nodes"]}
