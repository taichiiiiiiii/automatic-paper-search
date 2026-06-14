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


def _patch_env(monkeypatch, **values):
    """Patch config_loader.load_env to return a fixed secrets dict.

    Patching the function is more deterministic than monkeypatching the
    environment: earlier versions of this test relied on dotenv being
    a no-op, but dotenv re-reads paperpilot/.env and restored real keys
    in developer environments, making the tests non-hermetic.
    """
    # Annotate the dict shape so mypy can see the heterogeneous values
    # (None / str / nested dict) — without it, mypy infers
    # `dict[str, dict[Never, Never]]` from the empty smtp sub-dict and
    # base.update(values) becomes a type error.
    base: dict[str, object] = {
        "github_token": None, "s2_api_key": None, "openalex_email": None,
        "slack_webhook_url": None, "gemini_api_key": None, "claude_api_key": None,
        "groq_api_key": None, "groq_model": None, "gemini_model": None,
        "smtp": {},
    }
    base.update(values)
    monkeypatch.setattr(
        "paperpilot.utils.config_loader.load_env", lambda *a, **kw: base
    )
    # Belt and braces: clear the unprefixed fallbacks that build_provider
    # also reads from os.environ.
    for v in ("GROQ_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(v, raising=False)


def test_build_provider_prefers_groq(monkeypatch):
    _patch_env(monkeypatch, groq_api_key="gsk_x", gemini_api_key="gemini_y")
    provider, delay = build_lineage.build_provider()
    assert provider.name == "groq"
    assert delay == build_lineage.LLM_RATE_DELAY["groq"]


def test_build_provider_falls_back_to_gemini(monkeypatch):
    _patch_env(monkeypatch, gemini_api_key="gemini_y")  # no groq
    provider, delay = build_lineage.build_provider()
    assert provider.name == "gemini"
    assert delay == build_lineage.LLM_RATE_DELAY["gemini"]


def test_build_provider_raises_without_any_key(monkeypatch):
    # Phase 0a (closes #110): RuntimeError lets Modal import build_provider
    # safely; sys.exit would tear down the ASGI worker. Detailed contract is
    # pinned in test_build_lineage_provider_error.py.
    _patch_env(monkeypatch)  # no keys at all
    with pytest.raises(RuntimeError):
        build_lineage.build_provider()


def test_build_provider_uses_model_override_from_env(monkeypatch):
    """`PAPERPILOT_GROQ_MODEL` (via load_env) overrides the default model."""
    _patch_env(monkeypatch, groq_api_key="gsk_x", groq_model="llama-4-800b")
    provider, _ = build_lineage.build_provider()
    # `.model` is concrete-provider state (GroqProvider / GeminiProvider),
    # not part of the AbstractLLMProvider base API — mypy needs the cast.
    assert getattr(provider, "model", None) == "llama-4-800b"


def test_build_provider_accepts_unprefixed_fallback(monkeypatch):
    """Ambient `GROQ_API_KEY` (no PAPERPILOT_ prefix) is still picked up."""
    _patch_env(monkeypatch)  # clears load_env-sourced keys
    monkeypatch.setenv("GROQ_API_KEY", "gsk_ambient")
    provider, _ = build_lineage.build_provider()
    assert provider.name == "groq"


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
    # Rationale must clear the #297 min-length floor so it's served on hit.
    reason = "論文 B は論文 A の手法を別タスクへ拡張している。"
    rc = RelationClassification(relation="extends", confidence=0.9, rationale=reason)
    provider = _FakeProvider(return_value=rc)

    out = build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert out == {"relation": "extends", "confidence": 0.9, "rationale": reason}
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


def test_classify_cached_merges_concurrent_writes(tmp_path: Path):
    """Two pipelines sharing classifications.json must not lose each other's
    additions. Simulate the race: we hold a stale in-memory snapshot while a
    "concurrent" writer adds a new entry to disk; our subsequent classify
    call must merge that entry rather than overwrite it.
    """
    cache_path = tmp_path / "cls.json"
    # Snapshot held by "process A" (initially empty).
    classifications: dict[str, dict] = {}

    # Process B writes a different entry to disk between A's reads.
    cache_path.write_text(
        json.dumps(
            {
                "B->C": {
                    "relation": "successor",
                    "confidence": 0.7,
                    "rationale": "B made by another writer",
                }
            }
        )
    )

    # Process A now classifies its own pair; the on-disk JSON must end up
    # containing both A's new entry AND B's pre-existing one.
    rc = RelationClassification(relation="extends", confidence=0.9, rationale="A new")
    provider = _FakeProvider(return_value=rc)
    build_lineage._classify_cached(
        provider,
        {"title": "X"}, {"title": "Y"},
        cache_key="X->Y",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )

    on_disk = json.loads(cache_path.read_text())
    assert "X->Y" in on_disk, "process A's new entry persisted"
    assert "B->C" in on_disk, "process B's concurrent entry must be preserved"


def test_classify_cached_atomic_write_no_temp_leftover(tmp_path: Path):
    """The atomic rename must clean up — no stray .tmp.* files left behind."""
    cache_path = tmp_path / "cls.json"
    classifications: dict[str, dict] = {}
    rc = RelationClassification(relation="extends", confidence=0.9, rationale="x")
    provider = _FakeProvider(return_value=rc)
    build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    leftovers = list(tmp_path.glob("cls.json.tmp*"))
    assert leftovers == [], f"unexpected temp files: {leftovers}"


def test_classify_cached_tolerates_corrupt_disk_cache(tmp_path: Path):
    """If a previous writer left a corrupt JSON, treat as empty and proceed —
    the next successful write will replace it."""
    cache_path = tmp_path / "cls.json"
    cache_path.write_text("{not valid json")
    classifications: dict[str, dict] = {}
    rc = RelationClassification(relation="extends", confidence=0.8, rationale="x")
    provider = _FakeProvider(return_value=rc)
    build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    on_disk = json.loads(cache_path.read_text())
    assert on_disk == {"A->B": {"relation": "extends", "confidence": 0.8, "rationale": "x"}}


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


# ---- #297: degenerate-rationale cache-hit guard ----


def test_classify_cached_treats_degenerate_cache_entry_as_miss(tmp_path: Path):
    """Defense in depth (#297): a cached entry whose rationale is below the
    `_MIN_RATIONALE_LEN` floor (e.g. the production "A" / "VLLM" entries)
    must NOT be served from cache. The cache hit returns the raw dict
    without going through `from_dict`, so this path bypasses the Part 1
    fix — the guard here treats the degenerate entry as a cache MISS and
    re-derives via the provider, which yields a full rationale."""
    cache_path = tmp_path / "cls.json"
    # Pre-seed the cache with a degenerate entry (mirrors a poisoned cache
    # written before the #297 fix landed).
    classifications: dict[str, dict] = {
        "A->B": {"relation": "extends", "confidence": 0.9, "rationale": "A"}
    }
    rc = RelationClassification(
        relation="extends",
        confidence=0.8,
        rationale="論文 B は論文 A のスペクトル法を空間領域へ再定式化している。",
    )
    provider = _FakeProvider(return_value=rc)

    out = build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    # Re-derived (cache treated as miss) — provider WAS called.
    assert provider.calls, "degenerate cache entry must trigger re-derivation"
    assert out is not None
    assert len(out["rationale"]) >= 10
    # Cache overwritten with the full rationale.
    assert classifications["A->B"]["rationale"] == rc.rationale


def test_classify_cached_still_serves_wellformed_cache_entry(tmp_path: Path):
    """Counter-test: a well-formed cached entry (>= floor) is still served
    from cache without calling the provider — the #297 guard only catches
    degenerate entries."""
    cache_path = tmp_path / "cls.json"
    good = "論文 B は論文 A の注意機構を線形時間に近似している。"
    classifications: dict[str, dict] = {
        "A->B": {"relation": "extends", "confidence": 0.9, "rationale": good}
    }
    provider = _FakeProvider(return_value=None)  # would fail if invoked

    out = build_lineage._classify_cached(
        provider,
        {"title": "A"}, {"title": "B"},
        cache_key="A->B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert provider.calls == [], "well-formed cache entry must be a hit"
    assert out is not None
    assert out["rationale"] == good


def test_build_final_filter_drops_short_rationale_edges():
    """The final edge filter must drop edges whose rationale is below the
    `_MIN_RATIONALE_LEN` floor (#297), not just empty ones. This is the
    belt-and-braces filter that catches degenerate edges that slipped past
    earlier guards (e.g. directly-constructed edges in legacy cache data)."""
    from paperpilot.llm.base import _MIN_RATIONALE_LEN

    edges = [
        {"src": "a", "dst": "b", "rel": "extends", "conf": 0.7, "rationale": "A"},
        {"src": "a", "dst": "c", "rel": "extends", "conf": 0.7, "rationale": "   "},
        {
            "src": "a", "dst": "d", "rel": "extends", "conf": 0.7,
            "rationale": "論文 B は論文 A の手法を別ドメインに拡張している。",
        },
    ]
    kept = build_lineage._filter_edges_by_rationale(edges)
    assert len(kept) == 1
    assert kept[0]["dst"] == "d"
    assert all(
        len((e.get("rationale") or "").strip()) >= _MIN_RATIONALE_LEN for e in kept
    )


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
        # Rationales must clear the #297 min-length floor (>=10 chars) so the
        # final filter keeps the kept edges; this test asserts unrelated-drop.
        if b is focus:  # parent -> focus
            return RelationClassification(
                relation="successor", confidence=0.8,
                rationale="論文 B は論文 A の研究を継承している。",
            )
        if b is child_related:  # focus -> child_related
            return RelationClassification(
                relation="extends", confidence=0.7,
                rationale="論文 B は論文 A の手法を拡張している。",
            )
        # focus -> child_unrelated
        return RelationClassification(
            relation="unrelated", confidence=0.3,
            rationale="論文 B は論文 A と無関係である。",
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
    assert result == {"root": None, "nodes": [], "edges": [], "clusters": []}
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


# ---- fetch_related propagates isInfluential (#50) ----


def test_fetch_related_requests_is_influential_field(tmp_path, monkeypatch):
    """The S2 references endpoint must be queried with isInfluential in fields,
    so the entry-level flag actually arrives in the response."""
    monkeypatch.setattr(build_lineage, "CACHE_DIR", tmp_path)
    captured: dict = {}

    def _capture(url):
        captured["url"] = url
        return {"data": []}

    with patch.object(build_lineage, "_s2_get", side_effect=_capture):
        build_lineage.fetch_related("paperX", "references", 5)
    assert "isInfluential" in captured["url"], (
        f"fields query missing isInfluential: {captured['url']}"
    )


def test_fetch_related_propagates_is_influential_flag(tmp_path, monkeypatch):
    """isInfluential lives at the entry level (alongside citedPaper) — the
    helper must lift it onto the inner paper dict so BFS callers can pre-
    filter without reaching back to the raw S2 envelope."""
    monkeypatch.setattr(build_lineage, "CACHE_DIR", tmp_path)
    fake_data = {
        "data": [
            {
                "isInfluential": True,
                "citedPaper": {"paperId": "P1", "title": "Influential one"},
            },
            {
                "isInfluential": False,
                "citedPaper": {"paperId": "P2", "title": "Background only"},
            },
            {
                # Some entries omit the flag entirely — treat as unknown
                # (carry None) so callers can keep them for compatibility.
                "citedPaper": {"paperId": "P3", "title": "Unknown"},
            },
        ]
    }
    with patch.object(build_lineage, "_s2_get", return_value=fake_data):
        items = build_lineage.fetch_related("paperX", "references", 5)
    by_id = {it["paperId"]: it for it in items}
    assert by_id["P1"]["_is_influential"] is True
    assert by_id["P2"]["_is_influential"] is False
    assert by_id["P3"]["_is_influential"] is None  # unknown ≠ False


def test_fetch_related_citations_also_carries_flag(tmp_path, monkeypatch):
    """citations endpoint uses citingPaper as the inner key — flag must
    propagate symmetrically."""
    monkeypatch.setattr(build_lineage, "CACHE_DIR", tmp_path)
    fake_data = {
        "data": [
            {
                "isInfluential": True,
                "citingPaper": {"paperId": "C1", "title": "Cites us"},
            }
        ]
    }
    with patch.object(build_lineage, "_s2_get", return_value=fake_data):
        items = build_lineage.fetch_related("paperX", "citations", 5)
    assert items[0]["_is_influential"] is True


# ---- intents propagation (#53) ----


def test_fetch_related_requests_intents_field(tmp_path, monkeypatch):
    """The references query must include `intents` so we can derive the
    relation type without an LLM call (issue #53)."""
    monkeypatch.setattr(build_lineage, "CACHE_DIR", tmp_path)
    captured: dict = {}

    def _capture(url):
        captured["url"] = url
        return {"data": []}

    with patch.object(build_lineage, "_s2_get", side_effect=_capture):
        build_lineage.fetch_related("paperX", "references", 5)
    assert "intents" in captured["url"], (
        f"fields query missing intents: {captured['url']}"
    )


def test_fetch_related_propagates_intents(tmp_path, monkeypatch):
    """intents is an entry-level array — lift onto the inner paper dict
    as `_intents` so BFS callers can derive the relation."""
    monkeypatch.setattr(build_lineage, "CACHE_DIR", tmp_path)
    fake_data = {
        "data": [
            {
                "isInfluential": True,
                "intents": ["methodology"],
                "citedPaper": {"paperId": "P1", "title": "Method ref"},
            },
            {
                "isInfluential": True,
                "intents": ["background", "result"],
                "citedPaper": {"paperId": "P2", "title": "Multi-intent"},
            },
            {
                # Some entries omit intents entirely → treat as None
                "isInfluential": True,
                "citedPaper": {"paperId": "P3", "title": "No intents"},
            },
        ]
    }
    with patch.object(build_lineage, "_s2_get", return_value=fake_data):
        items = build_lineage.fetch_related("paperX", "references", 5)
    by_id = {it["paperId"]: it for it in items}
    assert by_id["P1"]["_intents"] == ["methodology"]
    assert by_id["P2"]["_intents"] == ["background", "result"]
    assert by_id["P3"]["_intents"] is None  # missing ≠ empty list


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


# ---- cluster generation ----


def test_build_clusters_groups_focus_by_primary_tag():
    nodes = [
        {"id": "a", "kinds": ["Vision", "SSL"], "is_focus": True},
        {"id": "b", "kinds": ["LLM"], "is_focus": True},
        {"id": "c", "kinds": ["Vision"], "is_focus": True},
        {"id": "e", "kinds": ["LLM"], "is_focus": True},
        {"id": "d", "kinds": ["LLM", "Eval"], "is_focus": True},
    ]
    clusters = build_lineage.build_clusters(nodes)
    labels = [(c["label"], c["focus_ids"]) for c in clusters]
    # LLM (3) comes before Vision (2); focus_ids within each cluster are
    # sorted so output is deterministic regardless of input order.
    assert labels == [("LLM", ["b", "d", "e"]), ("Vision", ["a", "c"])]


def test_build_clusters_ignores_non_focus_nodes():
    nodes: list[dict] = [
        {"id": "f", "kinds": ["Vision"], "is_focus": True},
        {"id": "r", "kinds": ["Vision"]},  # related, not focus — must be ignored
    ]
    clusters = build_lineage.build_clusters(nodes)
    assert [c["focus_ids"] for c in clusters] == [["f"]]


def test_build_clusters_slugifies_labels():
    nodes = [
        {"id": "x", "kinds": ["Time Series"], "is_focus": True},
        {"id": "y", "kinds": ["A+"], "is_focus": True},
    ]
    clusters = build_lineage.build_clusters(nodes)
    ids = sorted(c["id"] for c in clusters)
    assert ids == ["a", "time-series"]


def test_build_clusters_disambiguates_colliding_slugs():
    """When two labels slugify to the same id, preserve both clusters with
    suffixed ids so papers don't get silently merged under the wrong label."""
    nodes = [
        {"id": "p1", "kinds": ["A+"], "is_focus": True},
        {"id": "p2", "kinds": ["A-"], "is_focus": True},
    ]
    clusters = build_lineage.build_clusters(nodes)
    # Both labels survive as distinct clusters — neither silently inherits
    # the other's label.
    labels = sorted(c["label"] for c in clusters)
    assert labels == ["A+", "A-"]
    # Ids are disambiguated so the UI can route correctly.
    ids = [c["id"] for c in clusters]
    assert len(set(ids)) == 2, f"expected distinct ids, got {ids}"


def test_build_clusters_uncategorized_fallback():
    nodes = [
        {"id": "n1", "kinds": [], "is_focus": True},
        {"id": "n2", "is_focus": True},  # no kinds key at all
    ]
    clusters = build_lineage.build_clusters(nodes)
    assert len(clusters) == 1
    assert clusters[0]["id"] == "uncategorized"
    assert sorted(clusters[0]["focus_ids"]) == ["n1", "n2"]


def test_build_clusters_ordered_alphabetically_when_tied():
    nodes = [
        {"id": "a", "kinds": ["Vision"], "is_focus": True},
        {"id": "b", "kinds": ["LLM"], "is_focus": True},
        {"id": "c", "kinds": ["Eval"], "is_focus": True},
    ]
    clusters = build_lineage.build_clusters(nodes)
    # All three tied at 1 member → alphabetical.
    assert [c["label"] for c in clusters] == ["Eval", "LLM", "Vision"]
