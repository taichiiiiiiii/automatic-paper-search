"""Focused P2T producer contract tests; no network or real LLM calls."""

from __future__ import annotations

import copy
import json
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from paperpilot.identity import make_paper_id
from paperpilot.llm.base import AbstractLLMProvider, RelationClassification
from paperpilot.scripts import build_theme_lineage as btl


class _Provider(AbstractLLMProvider):
    name = "test-provider"
    model = "test-model"

    def __init__(self, result: RelationClassification | None) -> None:
        super().__init__({"enabled": True})
        self.result = result
        self.calls = 0

    def evaluate_batch(self, papers, profile):  # pragma: no cover - unused
        return []

    def classify_relation(self, a, b):
        self.calls += 1
        return self.result


def _paper(
    graph_id: str,
    arxiv_id: str | None,
    *,
    title: str = "A paper",
    year: int = 2024,
    citations: int = 10,
) -> dict:
    return {
        "paperId": graph_id,
        "title": title,
        "year": year,
        "venue": "arXiv",
        "citationCount": citations,
        "abstract": "A sufficiently specific abstract for deterministic tests.",
        "authors": [],
        "externalIds": {} if arxiv_id is None else {"ArXiv": arxiv_id},
    }


def _classification() -> RelationClassification:
    return RelationClassification(
        relation="extends",
        confidence=0.87,
        rationale="B は A の注意機構を長文コンテキストへ拡張している",
    )


def test_seed_resolution_prefers_exact_sidecar_and_mints_unregistered_alias() -> None:
    registered = "a" * 40
    index = {("arxiv", "2401.00001"): {registered}}
    seed, aliases = btl._resolve_seed_paper_id(_paper("s", "2401.00001"), index)
    assert seed == registered
    assert aliases == (("arxiv", "2401.00001"),)

    minted, _ = btl._resolve_seed_paper_id(_paper("u", "2401.00002"), index)
    assert minted == make_paper_id("arxiv", "2401.00002")


def test_doi_only_never_mints_but_can_join_through_sidecar() -> None:
    doi_only = _paper("doi", None)
    doi_only["externalIds"] = {"DOI": "https://doi.org/10.1000/XYZ"}
    seed, _ = btl._resolve_seed_paper_id(doi_only, {})
    assert seed is None

    canonical = "b" * 40
    seed, _ = btl._resolve_seed_paper_id(
        doi_only,
        {("doi", "10.1000/xyz"): {canonical}},
    )
    assert seed == canonical


def test_openalex_datacite_doi_is_not_promoted_to_identity_arxiv_alias() -> None:
    work = {
        "id": "https://openalex.org/W123",
        "title": "DOI-only work",
        "publication_year": 2024,
        "cited_by_count": 1,
        "abstract_inverted_index": {"identity": [0]},
        "authorships": [],
        "ids": {"doi": "https://doi.org/10.48550/arXiv.2401.00001"},
        "doi": "https://doi.org/10.48550/arXiv.2401.00001",
        "primary_location": {},
        "locations": [],
    }
    paper = btl._work_to_paper_dict(work)
    assert paper is not None
    assert paper["externalIds"] == {
        "OpenAlex": "W123",
        "DOI": "10.48550/arXiv.2401.00001",
    }
    seed, aliases = btl._resolve_seed_paper_id(paper, {})
    assert seed is None
    assert aliases == (("doi", "10.48550/arxiv.2401.00001"),)


def test_seed_alias_conflict_and_alias_field_mismatch_fail_closed() -> None:
    conflicting = _paper("s", "2401.00001")
    conflicting["externalIds"]["OpenReview"] = "forum-two"
    with pytest.raises(ValueError, match="conflicting canonical seed IDs"):
        btl._resolve_seed_paper_id(conflicting, {})

    mismatched = _paper("s", "2401.00001")
    mismatched["arxiv_id"] = "2401.00002"
    with pytest.raises(ValueError, match="conflicting canonical seed IDs"):
        btl._resolve_seed_paper_id(mismatched, {})


def test_seed_dedup_is_alias_exact_and_survivor_is_deterministic() -> None:
    low = _paper("z-low", "2401.00001", citations=10)
    high = _paper("a-high", "2401.00001", citations=100)
    survivors_a, ids_a = btl._resolve_and_dedup_seeds([low, high], {})
    survivors_b, ids_b = btl._resolve_and_dedup_seeds([high, low], {})
    assert [row["paperId"] for row in survivors_a] == ["a-high"]
    assert survivors_a == survivors_b
    assert ids_a == ids_b == {"a-high": make_paper_id("arxiv", "2401.00001")}


def test_same_title_year_distinct_aliases_are_not_deduped() -> None:
    first = _paper("a", "2401.00001", title="Same title", year=2024)
    second = _paper("b", "2401.00002", title="Same title", year=2024)
    survivors, seed_ids = btl._resolve_and_dedup_seeds([second, first], {})
    assert [row["paperId"] for row in survivors] == ["a", "b"]
    assert len(set(seed_ids.values())) == 2


def test_final_dedup_rejects_shared_doi_with_distinct_strong_aliases() -> None:
    focus = _paper("focus-low", "2401.00001", citations=10)
    focus["externalIds"]["DOI"] = "10.1000/shared"
    other = _paper("other-high", "2401.00002", citations=100)
    other["externalIds"]["DOI"] = "10.1000/shared"
    nodes = {
        "focus-low": btl._to_theme_node(focus, focus=True),
        "other-high": btl._to_theme_node(other),
    }
    with pytest.raises(ValueError, match="conflicting seed IDs on exact alias"):
        btl._dedup_nodes_by_strong_alias(
            nodes,
            {"focus-low": make_paper_id("arxiv", "2401.00001")},
            {},
        )


def test_final_dedup_keeps_isolated_exact_identity_deterministically() -> None:
    low = _paper("z-low", "2401.00001", citations=10)
    high = _paper("a-high", "2401.00001", citations=100)
    nodes = {
        "z-low": btl._to_theme_node(low, focus=True),
        "a-high": btl._to_theme_node(high),
    }
    canonical = make_paper_id("arxiv", "2401.00001")
    survivors, remap, seeds = btl._dedup_nodes_by_strong_alias(nodes, {"z-low": canonical}, {})
    assert list(survivors) == ["a-high"]
    assert remap == {"z-low": "a-high"}
    assert seeds == {"a-high": canonical}


def test_unresolvable_candidates_produce_no_focus_candidates() -> None:
    doi_only = _paper("doi", None)
    doi_only["externalIds"] = {"DOI": "10.1000/no-sidecar"}
    assert btl._resolve_and_dedup_seeds([doi_only], {}) == ([], {})


def test_every_edge_has_closed_endpoint_bound_structured_provenance() -> None:
    provider = _Provider(None)
    parent = {
        **_paper("parent", "2301.00001", year=2023),
        "_is_influential": True,
        "_intents": ["methodology"],
        "_contexts": ["B extends the parent method"],
    }
    child = _paper("child", "2401.00001", year=2024)
    derived = btl.derive_relation(parent, parent=parent, child=child)
    assert derived is not None
    edge = btl._make_edge(
        derived,
        src_id="parent",
        dst_id="child",
        parent=parent,
        child=child,
        intent_record=parent,
        provider=provider,
    )
    assert edge["rel"] == edge["relation"]
    assert edge["conf"] == edge["confidence"]
    assert set(edge["provenance"]) == {"producer", "evidence", "classification"}
    assert edge["provenance"]["classification"]["provider"] is None
    original_hash = edge["provenance"]["evidence"]["sha256"]
    changed = btl._make_edge(
        derived,
        src_id="different-parent",
        dst_id="child",
        parent=parent,
        child=child,
        intent_record=parent,
        provider=provider,
    )
    assert changed["provenance"]["evidence"]["sha256"] != original_hash


def test_cache_v2_exact_hit_has_required_entry_shape() -> None:
    cache: dict[str, dict] = {}
    first = _Provider(_classification())
    wrapped = btl._ThemeCachedClassifyProvider(first, cache, cache_path=None)
    a, b = _paper("a", "2301.00001"), _paper("b", "2401.00001")
    assert wrapped.classify_relation(a, b) is not None
    assert first.calls == 1
    key = next(iter(cache))
    assert key.startswith("v2:")
    entry = cache[key]
    assert set(entry) == {
        "status",
        "expires_at",
        "cache_identity",
        "classification",
        "provenance",
    }

    second = _Provider(None)
    replay = btl._ThemeCachedClassifyProvider(second, cache, cache_path=None)
    result = replay.classify_relation(a, b)
    assert result is not None and result.relation == "extends"
    assert second.calls == 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda entry: entry.update(status="failure"),
        lambda entry: entry.update(expires_at="2000-01-01T00:00:00Z"),
        lambda entry: entry["cache_identity"].update(provider="other"),
        lambda entry: entry["cache_identity"].update(model="other-model"),
        lambda entry: entry["cache_identity"].update(prompt_version="old"),
        lambda entry: entry["cache_identity"].update(schema_version="old"),
        lambda entry: entry["cache_identity"]["producer"].update(version="old"),
        lambda entry: entry["cache_identity"].update(evidence_sha256="0" * 64),
        lambda entry: entry["cache_identity"].update(src="other"),
        lambda entry: entry["provenance"]["evidence"].update(sha256="0" * 64),
    ],
)
def test_cache_v2_mismatch_expiry_and_failure_are_misses(mutate) -> None:
    cache: dict[str, dict] = {}
    a, b = _paper("a", "2301.00001"), _paper("b", "2401.00001")
    btl._ThemeCachedClassifyProvider(
        _Provider(_classification()), cache, cache_path=None
    ).classify_relation(a, b)
    mutate(next(iter(cache.values())))
    inner = _Provider(None)
    assert (
        btl._ThemeCachedClassifyProvider(inner, cache, cache_path=None).classify_relation(a, b)
        is None
    )
    assert inner.calls == 1


def test_cache_v2_changed_endpoint_or_evidence_and_legacy_key_are_misses() -> None:
    cache: dict[str, dict] = {
        "a->b": {
            "relation": "extends",
            "confidence": 0.9,
            "rationale": "legacy cache rationale that must not replay",
        }
    }
    inner = _Provider(None)
    wrapped = btl._ThemeCachedClassifyProvider(inner, cache, cache_path=None)
    a, b = _paper("a", "2301.00001"), _paper("b", "2401.00001")
    assert wrapped.classify_relation(a, b) is None
    changed_title = {**b, "title": "Changed classifier input"}
    assert wrapped.classify_relation(a, changed_title) is None
    assert wrapped.classify_relation(a, {**b, "paperId": "c"}) is None
    assert inner.calls == 3


def test_llm_failure_is_not_saved_as_success() -> None:
    cache: dict[str, dict] = {}
    inner = _Provider(None)
    result = btl._ThemeCachedClassifyProvider(inner, cache, cache_path=None).classify_relation(
        _paper("a", "2301.00001"), _paper("b", "2401.00001")
    )
    assert result is None
    assert cache == {}


def _stub_build(
    monkeypatch: pytest.MonkeyPatch,
    seeds: list[dict],
    *,
    nodes: dict[str, dict] | None = None,
    edges: list[dict] | None = None,
) -> None:
    provider = _Provider(None)
    monkeypatch.setattr(btl, "load_env", lambda: {})
    monkeypatch.setattr(btl, "build_provider", lambda: (provider, 0.0))
    monkeypatch.setattr(btl, "_load_identity_aliases", lambda: {})
    monkeypatch.setattr(btl, "discover_seeds", lambda **kwargs: copy.deepcopy(seeds))
    monkeypatch.setattr(btl, "_aliases_for", lambda theme: [])
    default_nodes = {seed["paperId"]: btl._to_theme_node(seed, focus=True) for seed in seeds}
    monkeypatch.setattr(
        btl,
        "_run_bfs_and_descendants",
        lambda *args, **kwargs: btl._BFSResult(
            nodes=copy.deepcopy(nodes if nodes is not None else default_nodes),
            edges=copy.deepcopy(edges or []),
            seed_ids=[seed["paperId"] for seed in seeds],
            classify_attempted=0,
            classify_succeeded=0,
        ),
    )
    monkeypatch.setattr(btl, "_add_cross_node_edges", lambda *args, **kwargs: 0)
    monkeypatch.setattr(btl, "_enrich_github_stars", lambda *args, **kwargs: 0)


def test_artifact_v1_empty_and_nonempty_root_node_order_and_meta(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_build(monkeypatch, [])
    empty_path = btl.build_theme_lineage(
        theme="Empty",
        depth=1,
        seeds_count=1,
        width=1,
        since_year=None,
        output=tmp_path / "empty.json",
    )
    empty = json.loads(empty_path.read_text())
    assert empty["schema_version"] == "lineage-artifact-v1"
    assert empty["root"] is None
    assert empty["clusters"] == []
    assert empty["meta"]["kind"] == "theme"
    assert empty["meta"]["generator"] == btl._PRODUCER_NAME

    high = _paper("z", "2401.00001", citations=100)
    low = _paper("a", "2401.00002", citations=10)
    _stub_build(monkeypatch, [high, low])
    path = btl.build_theme_lineage(
        theme="Ordered",
        depth=1,
        seeds_count=2,
        width=1,
        since_year=None,
        output=tmp_path / "ordered.json",
    )
    artifact = json.loads(path.read_text())
    assert [node["id"] for node in artifact["nodes"]] == ["a", "z"]
    assert artifact["root"] == "a"  # equal degree: graph-local ID asc
    assert all(isinstance(node["is_focus"], bool) for node in artifact["nodes"])
    assert all(len(node["seed_paper_id"]) == 40 for node in artifact["nodes"])
    assert artifact["nodes"][0]["aliases"] == [["arxiv", "2401.00002"]]


def test_edge_order_duplicate_removal_and_degree_root_are_deterministic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = _paper("a", "2401.00001")
    z = _paper("z", "2401.00002")
    x = _paper("x", "2301.00001", year=2023)
    provider = _Provider(None)

    def edge(src: dict, dst: dict, relation: str) -> dict:
        classification = {
            "relation": relation,
            "confidence": 0.8,
            "rationale": f"{dst['paperId']} は {src['paperId']} の手法を拡張している",
            "provenance": "intent_map",
        }
        return btl._make_edge(
            classification,
            src_id=src["paperId"],
            dst_id=dst["paperId"],
            parent=src,
            child=dst,
            intent_record={**src, "_intents": ["methodology"]},
            provider=provider,
        )

    az = edge(a, z, "extends")
    zx = edge(z, x, "successor")
    nodes = {
        paper["paperId"]: btl._to_theme_node(paper, focus=paper is not x) for paper in (x, z, a)
    }
    alternate_az = copy.deepcopy(az)
    alternate_az["rationale"] = "alternate deterministic rationale for the same edge"
    _stub_build(monkeypatch, [z, a], nodes=nodes, edges=[zx, alternate_az, az])
    first_path = btl.build_theme_lineage(
        theme="Edges",
        depth=1,
        seeds_count=2,
        width=1,
        since_year=None,
        output=tmp_path / "first.json",
    )
    first = json.loads(first_path.read_text())
    assert first["root"] == "z"
    assert [(e["src"], e["dst"], e["relation"]) for e in first["edges"]] == [
        ("a", "z", "extends"),
        ("z", "x", "successor"),
    ]

    _stub_build(monkeypatch, [a, z], nodes=nodes, edges=[az, zx, alternate_az])
    second_path = btl.build_theme_lineage(
        theme="Edges",
        depth=1,
        seeds_count=2,
        width=1,
        since_year=None,
        output=tmp_path / "second.json",
    )
    second = json.loads(second_path.read_text())
    assert second["root"] == first["root"]
    assert second["nodes"] == first["nodes"]
    assert second["edges"] == first["edges"]


def test_endpoint_remap_fails_closed_instead_of_reusing_old_evidence_hash() -> None:
    edge = {
        "src": "old",
        "dst": "child",
        "rel": "extends",
        "relation": "extends",
        "conf": 0.8,
        "confidence": 0.8,
        "rationale": "specific evidence for the original endpoint pair",
        "provenance": {
            "producer": {"name": btl._PRODUCER_NAME, "version": btl._PRODUCER_VERSION},
            "evidence": {
                "source": "semantic_scholar",
                "kind": "citation-metadata",
                "sha256": "a" * 64,
            },
            "classification": {
                "method": "intent_map",
                "provider": None,
                "model": None,
                "prompt_version": None,
                "schema_version": btl._CLASSIFICATION_SCHEMA_VERSION,
            },
        },
    }
    with pytest.raises(ValueError, match="endpoint-bound provenance"):
        btl._remap_edge_endpoints([edge], {"old": "survivor"})


def test_build_endpoint_remap_failure_preserves_existing_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    focus = _paper("old-focus", "2401.00001", citations=10)
    duplicate = _paper("new-survivor", "2401.00001", citations=100)
    child = _paper("child", "2401.00002")
    classification = {
        "relation": "extends",
        "confidence": 0.8,
        "rationale": "child は old-focus の具体的な手法を拡張している",
        "provenance": "intent_map",
    }
    edge = btl._make_edge(
        classification,
        src_id="old-focus",
        dst_id="child",
        parent=focus,
        child=child,
        intent_record={**focus, "_intents": ["methodology"]},
        provider=_Provider(None),
    )
    nodes = {
        "old-focus": btl._to_theme_node(focus, focus=True),
        "new-survivor": btl._to_theme_node(duplicate),
        "child": btl._to_theme_node(child),
    }
    _stub_build(monkeypatch, [focus], nodes=nodes, edges=[edge])
    output = tmp_path / "lineage.json"
    output.write_text("sentinel", encoding="utf-8")
    with pytest.raises(ValueError, match="endpoint-bound provenance"):
        btl.build_theme_lineage(
            theme="Endpoint binding",
            depth=1,
            seeds_count=1,
            width=1,
            since_year=None,
            output=output,
        )
    assert output.read_text(encoding="utf-8") == "sentinel"


def test_legacy_edge_is_rejected_before_overwrite(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = _paper("seed", "2401.00001")
    node = btl._to_theme_node(seed, focus=True)
    _stub_build(
        monkeypatch,
        [seed],
        nodes={"seed": node},
        edges=[
            {
                "src": "seed",
                "dst": "seed",
                "rel": "extends",
                "conf": 0.8,
                "rationale": "legacy edge rationale",
                "provenance": "intent_map",
            }
        ],
    )
    output = tmp_path / "lineage.json"
    output.write_text("sentinel", encoding="utf-8")
    with pytest.raises(ValueError, match="legacy or incomplete"):
        btl.build_theme_lineage(
            theme="Legacy",
            depth=1,
            seeds_count=1,
            width=1,
            since_year=None,
            output=output,
        )
    assert output.read_text(encoding="utf-8") == "sentinel"


def test_validation_failure_preserves_existing_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = _paper("seed", "2401.00001")
    _stub_build(monkeypatch, [seed])
    output = tmp_path / "lineage.json"
    output.write_text("sentinel", encoding="utf-8")
    monkeypatch.setattr(
        btl,
        "validate_lineage_artifact",
        lambda *args, **kwargs: [SimpleNamespace(code="broken", path="$.nodes")],
    )
    with pytest.raises(ValueError, match="generated theme violates"):
        btl.build_theme_lineage(
            theme="Failure",
            depth=1,
            seeds_count=1,
            width=1,
            since_year=None,
            output=output,
        )
    assert output.read_text(encoding="utf-8") == "sentinel"


def test_producer_enforces_focus_seed_even_if_shared_validator_does_not(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = _paper("seed", "2401.00001")
    _stub_build(monkeypatch, [seed])
    monkeypatch.setattr(btl, "validate_lineage_artifact", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        btl,
        "_dedup_nodes_by_strong_alias",
        lambda nodes, seed_ids, alias_index: (nodes, {}, {}),
    )
    output = tmp_path / "lineage.json"
    output.write_text("sentinel", encoding="utf-8")
    with pytest.raises(ValueError, match="lacks canonical seed"):
        btl.build_theme_lineage(
            theme="Missing seed",
            depth=1,
            seeds_count=1,
            width=1,
            since_year=None,
            output=output,
        )
    assert output.read_text(encoding="utf-8") == "sentinel"


def test_cache_expiry_is_future_utc() -> None:
    cache: dict[str, dict] = {}
    before = btl._utc_now()
    btl._ThemeCachedClassifyProvider(
        _Provider(_classification()), cache, cache_path=None
    ).classify_relation(_paper("a", "2301.00001"), _paper("b", "2401.00001"))
    expiry = next(iter(cache.values()))["expires_at"]
    parsed = btl.datetime.fromisoformat(expiry.replace("Z", "+00:00"))
    assert parsed >= before + timedelta(days=29)
