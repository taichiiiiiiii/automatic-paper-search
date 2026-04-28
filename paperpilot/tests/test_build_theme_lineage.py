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
    """Each expanded keyword should produce one S2 /paper/search call."""
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
    and proceed (next run will rewrite it on a successful query)."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)
    cache_path = build_theme_lineage._seed_cache_path("x", None)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text("{this is not valid json")
    seeds = build_theme_lineage.discover_seeds(
        keywords=["x"], top_n=10, since_year=None,
    )
    assert seeds == []


def test_discover_seeds_caches_per_keyword(tmp_path: Path, monkeypatch):
    """Re-running with the same keyword reuses cache (no second HTTP call)."""
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path)

    p = _mk_s2_paper("p1")
    with patch.object(
        build_theme_lineage,
        "request_with_retry",
        return_value=_mk_s2_search_response([p]),
    ) as mock_rwr:
        build_theme_lineage.discover_seeds(keywords=["k"], top_n=5, since_year=None)
        build_theme_lineage.discover_seeds(keywords=["k"], top_n=5, since_year=None)
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

    seed = _mk_s2_paper("seed1", title="Original MoE", year=2017)
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
    silently kill every derived edge)."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(build_theme_lineage, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(build_theme_lineage, "DOCS_ROOT", tmp_path / "docs")

    _stub_external_calls(monkeypatch)

    seed = _mk_s2_paper("seed", year=2020)
    # No _intents → derive_relation falls back to extends with default template.
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
    assert len(payload["edges"]) == 1
    edge = payload["edges"][0]
    assert edge["rel"] == "extends"
    assert edge["rationale"], "templated rationale must not be empty"
    assert "論文" in edge["rationale"]


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
    seed = _mk_s2_paper("seed", year=2023)
    # Mix: influential ref with low citations + non-influential foundational
    # papers with very high citations. Width=2 — without the fix, the two
    # foundationals win the budget and the influential one is dropped.
    foundational1 = {
        **_mk_s2_paper("found1", title="Foundational A", year=2015, cites=200_000),
        "_is_influential": False,
    }
    foundational2 = {
        **_mk_s2_paper("found2", title="Foundational B", year=2017, cites=150_000),
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
    """Missing intents (older cache or S2 omission) — assume extends as a
    safe default since the parent IS influential."""
    parent = {"_is_influential": True, "_intents": None}
    rel = build_theme_lineage.derive_relation(parent)
    assert rel is not None and rel["relation"] == "extends"


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
