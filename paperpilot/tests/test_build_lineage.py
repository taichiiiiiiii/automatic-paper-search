"""Smoke tests for paperpilot/scripts/build_lineage.py.

These verify the refactored LLM abstraction plumbing works end-to-end
*without* making any real HTTP calls. S2 and the LLM provider are both
mocked.

Key invariants enforced:
    - LLM calls go through provider.classify_relation (absolute rule §11),
      NOT urllib direct.
    - classifications cache round-trips to JSON.
    - Edges with `unrelated` relation are dropped.
    - Edges are keyed by "src->dst" so the cache is re-usable across runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from paperpilot.llm.base import AbstractLLMProvider, RelationClassification
from paperpilot.scripts import build_lineage

# ---- provider selection ----


def test_build_provider_prefers_groq(monkeypatch):
    monkeypatch.setenv("PAPERPILOT_GROQ_API_KEY", "gsk_x")
    monkeypatch.setenv("PAPERPILOT_GEMINI_API_KEY", "gemini_y")
    provider, delay = build_lineage.build_provider()
    assert provider.name == "groq"
    assert delay == build_lineage.LLM_RATE_DELAY["groq"]


def test_build_provider_falls_back_to_gemini(monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("PAPERPILOT_GEMINI_API_KEY", "gemini_y")
    provider, delay = build_lineage.build_provider()
    assert provider.name == "gemini"
    assert delay == build_lineage.LLM_RATE_DELAY["gemini"]


def test_build_provider_exits_without_any_key(monkeypatch):
    for var in (
        "PAPERPILOT_GROQ_API_KEY",
        "GROQ_API_KEY",
        "PAPERPILOT_GEMINI_API_KEY",
        "GEMINI_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    # Prevent dotenv from repopulating the environment from paperpilot/.env
    monkeypatch.setattr(build_lineage, "_load_env", lambda: None)
    with pytest.raises(SystemExit):
        build_lineage.build_provider()


# ---- _classify_cached ----


class _FakeProvider(AbstractLLMProvider):
    """Minimal AbstractLLMProvider subclass for tests.

    Subclasses instead of ducktyping so mypy accepts _FakeProvider
    wherever AbstractLLMProvider is required. evaluate_batch is
    stubbed — these tests only exercise classify_relation.
    """

    name = "fake"

    def __init__(self, return_value: RelationClassification | None):
        super().__init__({"enabled": True})
        self.return_value = return_value
        self.calls: list[tuple[dict, dict]] = []

    def evaluate_batch(self, papers, profile):  # pragma: no cover - unused in lineage tests
        return [None] * len(papers)

    def classify_relation(self, a: dict, b: dict) -> RelationClassification | None:
        self.calls.append((a, b))
        return self.return_value


def test_classify_cached_writes_cache_and_skips_on_hit(tmp_path: Path):
    cache_path = tmp_path / "cls.json"
    classifications: dict[str, dict] = {}
    rc = RelationClassification(relation="extends", confidence=0.9, rationale="理由")
    provider = _FakeProvider(return_value=rc)

    out = build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert out == {"relation": "extends", "confidence": 0.9, "rationale": "理由"}
    # Cache persisted
    assert json.loads(cache_path.read_text())["A->B"]["relation"] == "extends"

    # Second call with a provider that would return None must hit the cache,
    # confirming cache takes precedence.
    provider_fail = _FakeProvider(return_value=None)
    out2 = build_lineage._classify_cached(
        provider_fail,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert out2 == out
    assert provider_fail.calls == []  # cache hit; provider never invoked


def test_classify_cached_returns_none_on_failure(tmp_path: Path):
    cache_path = tmp_path / "cls.json"
    classifications: dict[str, dict] = {}
    provider = _FakeProvider(return_value=None)

    out = build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert out is None
    assert classifications == {}
    # Cache file not written when there's nothing to persist
    assert not cache_path.exists()


# ---- build() end-to-end ----


def _focus_s2(paper_id: str, title: str) -> dict:
    return {
        "paperId": paper_id,
        "title": title,
        "year": 2024,
        "venue": "ICLR",
        "authors": [{"name": "Alice"}],
        "abstract": "abstract body",
        "citationCount": 42,
    }


def test_focus_node_carries_catalog_citation_and_stars(tmp_path: Path, monkeypatch):
    """Issue #23: focus nodes must expose Stage 2's citation_count / github_stars
    so the viewer can size bubbles correctly."""
    papers_dir = tmp_path / "docs" / "iclr-2026"
    papers_dir.mkdir(parents=True)
    papers_path = papers_dir / "papers.json"
    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "Catalog Paper",
                    "type": "Oral",
                    "tags": ["LLM"],
                    "arxiv_url": "http://arxiv.org/abs/2404.00001",
                    "arxiv_id": "2404.00001",
                    "citation_count": 128,
                    "github_stars": 900,
                }
            ]
        )
    )
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, papers_dir / "lineage.json"),
    )
    focus = {
        "paperId": "focus-id", "title": "Catalog Paper", "year": 2024,
        "venue": "arXiv", "authors": [], "abstract": "x",
        "citationCount": 50,  # S2's (lower / staler) count
    }
    monkeypatch.setattr(build_lineage, "fetch_paper_by_arxiv", lambda _: focus)
    monkeypatch.setattr(build_lineage, "fetch_related", lambda *a, **kw: [])

    provider = _FakeProvider(return_value=None)
    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(conference="iclr-2026")
    focus_node = next(n for n in result["nodes"] if n.get("is_focus"))
    # Catalog (Stage 2) values take precedence over S2's citationCount.
    assert focus_node["citation_count"] == 128
    assert focus_node["github_stars"] == 900


def test_related_node_uses_s2_citation_count(tmp_path: Path, monkeypatch):
    """Non-focus nodes fall through to S2's citationCount since the catalog
    doesn't track them."""
    papers_dir = tmp_path / "docs" / "iclr-2026"
    papers_dir.mkdir(parents=True)
    papers_path = papers_dir / "papers.json"
    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "Focus",
                    "type": "Oral",
                    "tags": [],
                    "arxiv_url": "http://arxiv.org/abs/2404.00001",
                    "arxiv_id": "2404.00001",
                }
            ]
        )
    )
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, papers_dir / "lineage.json"),
    )

    focus = {
        "paperId": "focus-id", "title": "Focus", "year": 2024,
        "venue": "arXiv", "authors": [], "abstract": "x", "citationCount": 0,
    }
    parent = {
        "paperId": "parent-id", "title": "Parent", "year": 2020,
        "venue": "NeurIPS", "authors": [], "abstract": "p",
        "citationCount": 317,
    }
    monkeypatch.setattr(build_lineage, "fetch_paper_by_arxiv", lambda _: focus)
    monkeypatch.setattr(
        build_lineage, "fetch_related",
        lambda sid, kind, limit: [parent] if kind == "references" else [],
    )

    provider = _FakeProvider(
        return_value=RelationClassification(
            relation="successor", confidence=0.8, rationale="xx"
        )
    )
    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(conference="iclr-2026")
    parent_node = next(n for n in result["nodes"] if n["id"] == "parent-id")
    assert parent_node["citation_count"] == 317
    # No catalog data for related papers → stars stays at 0
    assert parent_node["github_stars"] == 0


def test_build_drops_unrelated_edges_and_uses_provider(tmp_path: Path, monkeypatch):
    # Redirect both the cache and the IO paths into tmp_path so the test
    # leaves no trace in the real docs/ / data/ directories.
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    papers_path = tmp_path / "papers.json"
    output_path = tmp_path / "lineage.json"
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, output_path),
    )

    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "Focus Paper",
                    "type": "Oral",
                    "tags": ["LLM"],
                    "arxiv_url": "http://arxiv.org/abs/2401.00001",
                }
            ]
        )
    )

    focus = _focus_s2("focus-id", "Focus Paper")
    parent = _focus_s2("parent-id", "Parent Paper")
    child_related = _focus_s2("child-related-id", "Child Related")
    child_unrelated = _focus_s2("child-unrelated-id", "Child Unrelated")

    # Mock S2: one call for the focus paper, two for references/citations.
    def fake_fetch_paper(arxiv_id: str):
        assert arxiv_id == "2401.00001"
        return focus

    def fake_fetch_related(s2_id: str, kind: str, limit: int):
        assert s2_id == "focus-id"
        if kind == "references":
            return [parent]
        return [child_related, child_unrelated]

    monkeypatch.setattr(build_lineage, "fetch_paper_by_arxiv", fake_fetch_paper)
    monkeypatch.setattr(build_lineage, "fetch_related", fake_fetch_related)

    # Provider returns different relations by (a, b) pair so we can assert
    # the "unrelated" edge is dropped.
    def fake_classify(a: dict, b: dict):
        if b is focus:  # parent -> focus
            return RelationClassification(
                relation="successor", confidence=0.8, rationale="継承"
            )
        if b is child_related:  # focus -> child_related
            return RelationClassification(
                relation="extends", confidence=0.7, rationale="拡張"
            )
        # focus -> child_unrelated
        return RelationClassification(
            relation="unrelated", confidence=0.3, rationale="無関係"
        )

    provider = _FakeProvider(return_value=None)
    provider.classify_relation = fake_classify  # type: ignore[method-assign]

    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(limit=None)

    # Focus + 1 parent + 2 children = 4 nodes
    node_ids = {n["id"] for n in result["nodes"]}
    assert node_ids == {"focus-id", "parent-id", "child-related-id", "child-unrelated-id"}

    # "unrelated" must be dropped — 2 edges (successor, extends), not 3
    assert len(result["edges"]) == 2
    assert {e["rel"] for e in result["edges"]} == {"successor", "extends"}
    # Focus paper has 2 edges total (one in, one out) → it becomes root
    assert result["root"] == "focus-id"

    # Cache was persisted
    cache = json.loads((cache_dir / "classifications.json").read_text())
    assert "parent-id->focus-id" in cache
    assert "focus-id->child-related-id" in cache


def test_build_skips_papers_without_arxiv_id(tmp_path: Path, monkeypatch):
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    papers_path = tmp_path / "papers.json"
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, tmp_path / "lineage.json"),
    )

    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "Workshop paper",
                    "type": "Oral",
                    "tags": [],
                    "arxiv_url": "",  # missing → should be skipped
                }
            ]
        )
    )

    provider = _FakeProvider(return_value=None)
    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(limit=None)
    assert result == {"root": None, "nodes": [], "edges": []}
    assert provider.calls == []


# ---- S2 helper (#25) ----


def _mock_resp(status: int, body=None):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = body if body is not None else {}
    return resp


def test_s2_get_uses_request_with_retry_and_parses_json():
    """_s2_get must go through utils.http.request_with_retry, not urllib."""
    with patch(
        "paperpilot.scripts.build_lineage.request_with_retry",
        return_value=_mock_resp(200, {"paperId": "abc", "title": "T"}),
    ) as mock:
        out = build_lineage._s2_get(
            "https://api.semanticscholar.org/graph/v1/paper/arXiv:2404.00001"
        )
    assert out == {"paperId": "abc", "title": "T"}
    # Helper hands off the URL + a paperpilot User-Agent
    args = mock.call_args
    assert args.args[0] == "GET"
    assert "api.semanticscholar.org" in args.args[1]
    assert args.kwargs["headers"]["User-Agent"].startswith("PaperPilot")


def test_s2_get_returns_none_on_non_200():
    with patch(
        "paperpilot.scripts.build_lineage.request_with_retry",
        return_value=_mock_resp(404),
    ):
        assert build_lineage._s2_get("https://x") is None


def test_s2_get_returns_none_when_retry_helper_gives_up():
    # request_with_retry returns None when overall_deadline hits
    with patch(
        "paperpilot.scripts.build_lineage.request_with_retry",
        return_value=None,
    ):
        assert build_lineage._s2_get("https://x") is None


# ---- conference parameterization (#21) ----


def test_resolve_paths_defaults_to_iclr_2026():
    papers, output = build_lineage.resolve_paths("iclr-2026")
    assert papers.name == "papers.json"
    assert output.name == "lineage.json"
    assert papers.parent.name == "iclr-2026"


def test_resolve_paths_for_other_conference():
    papers, output = build_lineage.resolve_paths("neurips-2025")
    assert papers.parent.name == "neurips-2025"
    assert output.parent.name == "neurips-2025"


def test_derive_venue_label_turns_slug_into_pretty_name():
    assert build_lineage.derive_venue_label("iclr-2026") == "ICLR 2026"
    assert build_lineage.derive_venue_label("neurips-2025") == "NEURIPS 2025"


def test_build_prefers_arxiv_id_from_papers_json(tmp_path: Path, monkeypatch):
    """Issue #22: when papers.json already carries arxiv_id, skip the regex re-extraction."""
    papers_dir = tmp_path / "docs" / "iclr-2026"
    papers_dir.mkdir(parents=True)
    papers_path = papers_dir / "papers.json"
    # Note the URL is an odd format (pdf, with version) that the regex
    # DOESN'T match — but arxiv_id is set directly. The script should
    # succeed anyway by trusting the structured field.
    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "Direct ID Paper",
                    "type": "Oral",
                    "tags": [],
                    "arxiv_url": "http://arxiv.org/pdf/2404.00001v3",
                    "arxiv_id": "2404.00001",
                }
            ]
        )
    )
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, papers_dir / "lineage.json"),
    )

    called_with: list[str] = []

    def fake_fetch_paper(arxiv_id: str):
        called_with.append(arxiv_id)
        return {
            "paperId": "p1", "title": "Direct ID Paper", "year": 2024,
            "venue": "arXiv", "authors": [], "abstract": "x", "citationCount": 0,
        }

    monkeypatch.setattr(build_lineage, "fetch_paper_by_arxiv", fake_fetch_paper)
    monkeypatch.setattr(build_lineage, "fetch_related", lambda *a, **kw: [])

    provider = _FakeProvider(return_value=None)
    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(conference="iclr-2026")
    assert called_with == ["2404.00001"]
    assert len(result["nodes"]) == 1


def test_build_accepts_conference_argument(tmp_path: Path, monkeypatch):
    """Conference parameter drives file paths and venue override for focus nodes."""
    # Set up a NeurIPS 2025 conference in tmp_path
    papers_dir = tmp_path / "docs" / "neurips-2025"
    papers_dir.mkdir(parents=True)
    papers_path = papers_dir / "papers.json"
    papers_path.write_text(
        json.dumps(
            [
                {
                    "title": "NeurIPS Paper",
                    "type": "Oral",
                    "tags": ["RL"],
                    "arxiv_url": "http://arxiv.org/abs/2501.00001",
                }
            ]
        )
    )
    cache_dir = tmp_path / "lineage-cache"
    cache_dir.mkdir()
    monkeypatch.setattr(build_lineage, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(
        build_lineage, "resolve_paths",
        lambda conf: (papers_path, papers_dir / "lineage.json"),
    )

    focus = {
        "paperId": "focus-id", "title": "NeurIPS Paper", "year": 2025,
        "venue": "arXiv", "authors": [], "abstract": "abs", "citationCount": 5,
    }
    monkeypatch.setattr(build_lineage, "fetch_paper_by_arxiv", lambda _: focus)
    monkeypatch.setattr(build_lineage, "fetch_related", lambda *a, **kw: [])

    provider = _FakeProvider(return_value=None)
    monkeypatch.setattr(
        build_lineage, "build_provider", lambda: (provider, 0)
    )

    result = build_lineage.build(conference="neurips-2025")
    # Focus node should have the conference-derived venue override, not
    # the hardcoded "ICLR 2026".
    focus_node = next(n for n in result["nodes"] if n.get("is_focus"))
    assert focus_node["venue"] == "NEURIPS 2025"
