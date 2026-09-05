"""P2 identity, provenance and cache-v2 tests for the deep producer."""

from __future__ import annotations

import json

import pytest

from paperpilot.scripts import build_deep_lineage as bdl
from paperpilot.scripts._lineage_contract import validate_lineage_artifact

PAPER_ID = "1" * 40


class _Provider:
    name = "fixture"
    model = "fixture-model"

    def __init__(self, response: dict | None = None) -> None:
        self.response = response or {
            "relation": "extends",
            "confidence": 0.8,
            "rationale": "Paper B extends the concrete method introduced by Paper A.",
        }
        self.calls = 0

    def _chat(self, system, user, *, json_mode=False):
        self.calls += 1
        return json.dumps(self.response)


def _paper(paper_id: str = "S2-focus", *, title: str = "Focus") -> dict:
    return {
        "paperId": paper_id,
        "title": title,
        "year": 2026,
        "venue": "",
        "citationCount": 1,
        "authors": [{"name": "Author"}],
        "abstract": "A sufficiently detailed abstract used as classification evidence.",
        "externalIds": {"ArXiv": "2602.18473"},
    }


def test_invalid_seed_fails_before_provider_or_network(monkeypatch) -> None:
    called = False

    def fail_provider():
        nonlocal called
        called = True
        raise AssertionError("provider must not be constructed")

    monkeypatch.setattr(bdl, "build_provider", fail_provider)
    with pytest.raises(ValueError, match="40-hex"):
        bdl.build_deep("2602.18473", seed_paper_id="invalid", depth=0)
    assert called is False


def test_build_deep_preserves_seed_aliases_and_schema(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bdl, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(bdl, "build_provider", lambda: (_Provider(), 0.0))
    monkeypatch.setattr(bdl, "fetch_paper_by_arxiv", lambda arxiv_id: _paper())

    result = bdl.build_deep(
        "2602.18473v2",
        seed_paper_id=PAPER_ID,
        depth=0,
        venue_override="ICLR 2026",
        tier_override="A+",
    )

    assert result["schema_version"] == "lineage-artifact-v1"
    assert result["root"] == "S2-focus"
    assert result["clusters"] == []
    focus = result["nodes"][0]
    expected_aliases = [["arxiv", "2602.18473"], ["semantic_scholar", "S2-focus"]]
    assert focus["seed_paper_id"] == result["meta"]["seed_paper_id"] == PAPER_ID
    assert focus["aliases"] == result["meta"]["aliases"] == expected_aliases
    assert (
        validate_lineage_artifact(
            result,
            kind="deep",
            catalog_ids={PAPER_ID},
            expected_seed_paper_id=PAPER_ID,
        )
        == []
    )


@pytest.mark.parametrize("external_ids", [{"ArXiv": "2401.00001"}, {}, None])
def test_s2_focus_must_confirm_requested_arxiv_before_provider(external_ids, monkeypatch) -> None:
    focus = _paper()
    focus["externalIds"] = external_ids
    provider_called = False

    def fail_provider():
        nonlocal provider_called
        provider_called = True
        raise AssertionError("provider must not be constructed for an identity mismatch")

    monkeypatch.setattr(bdl, "fetch_paper_by_arxiv", lambda _arxiv_id: focus)
    monkeypatch.setattr(bdl, "build_provider", fail_provider)
    with pytest.raises(ValueError, match="Semantic Scholar"):
        bdl.build_deep("2602.18473", seed_paper_id=PAPER_ID, depth=0)
    assert provider_called is False


def test_cache_v2_ignores_legacy_key_and_hits_identical_evidence(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bdl.time, "sleep", lambda _seconds: None)
    provider = _Provider()
    classifications = {
        "A->B": {
            "relation": "contrasts",
            "confidence": 0.1,
            "rationale": "This legacy cache entry must never be consumed.",
        }
    }
    cache_path = tmp_path / "classifications.json"

    first = bdl._classify_cached_lenient(
        provider,
        _paper("A", title="Parent"),
        _paper("B", title="Child"),
        src_id="A",
        dst_id="B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    second = bdl._classify_cached_lenient(
        provider,
        _paper("A", title="Parent"),
        _paper("B", title="Child"),
        src_id="A",
        dst_id="B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )

    assert provider.calls == 1
    assert first == second
    assert first["provenance"]["classification"]["method"] == "llm"
    assert first["provenance"]["classification"]["model"] == "fixture:fixture-model"
    assert first["status"] == "success"
    assert first["expires_at"].endswith("Z")
    assert first["cache_identity"]["version"] == "lineage-classification-cache-v2"
    assert any(key.startswith("v2:") for key in classifications)

    changed = _paper("B", title="Child")
    changed["abstract"] = "Changed evidence with enough content to produce a different hash."
    bdl._classify_cached_lenient(
        provider,
        _paper("A", title="Parent"),
        changed,
        src_id="A",
        dst_id="B",
        classifications=classifications,
        cache_path=cache_path,
        rate_delay=0,
    )
    assert provider.calls == 2


def test_expired_or_unversioned_v2_cache_entry_is_a_miss(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bdl.time, "sleep", lambda _seconds: None)
    provider = _Provider()
    classifications: dict[str, dict] = {}
    cache_path = tmp_path / "classifications.json"
    args = {
        "src_id": "A",
        "dst_id": "B",
        "classifications": classifications,
        "cache_path": cache_path,
        "rate_delay": 0,
    }
    bdl._classify_cached_lenient(
        provider, _paper("A", title="Parent"), _paper("B", title="Child"), **args
    )
    cache_key = next(key for key in classifications if key.startswith("v2:"))
    classifications[cache_key]["expires_at"] = "1970-01-01T00:00:00Z"

    bdl._classify_cached_lenient(
        provider, _paper("A", title="Parent"), _paper("B", title="Child"), **args
    )
    assert provider.calls == 2

    classifications[cache_key].pop("status")
    bdl._classify_cached_lenient(
        provider, _paper("A", title="Parent"), _paper("B", title="Child"), **args
    )
    assert provider.calls == 3


def test_unknown_relation_is_not_cached_or_emitted(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bdl.time, "sleep", lambda _seconds: None)
    provider = _Provider(
        {
            "relation": "fabricated",
            "confidence": 0.8,
            "rationale": "A long but invalid relation classification response.",
        }
    )
    classifications: dict[str, dict] = {}
    result = bdl._classify_cached_lenient(
        provider,
        _paper("A"),
        _paper("B"),
        src_id="A",
        dst_id="B",
        classifications=classifications,
        cache_path=tmp_path / "classifications.json",
        rate_delay=0,
    )
    assert result is None
    assert classifications == {}
