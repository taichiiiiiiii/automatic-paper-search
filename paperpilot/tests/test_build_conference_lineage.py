"""Tests for paperpilot/scripts/build_conference_lineage.py.

The OpenAlex HTTP layer is patched (request_with_retry); pure helpers and the
graph assembly are exercised directly. No network.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.scripts import build_conference_lineage as bcl

PAPER_ID = "1" * 40
OTHER_PAPER_ID = "2" * 40


def _resp(payload):
    return SimpleNamespace(status_code=200, json=lambda: payload)


def _work(wid, title, year, refs=None, authors=("Alice",)):
    return {
        "id": f"https://openalex.org/{wid}",
        "title": title,
        "publication_year": year,
        "authorships": [{"author": {"display_name": a}} for a in authors],
        "primary_location": {"source": {"display_name": "Some Venue"}},
        "referenced_works": [f"https://openalex.org/{r}" for r in (refs or [])],
        "cited_by_count": 10,
        "ids": {"openalex": f"https://openalex.org/{wid}"},
        "locations": [],
    }


def _oral(title, paper_id=PAPER_ID, *, openalex_id=None):
    row = {"title": title, "paper_id": paper_id}
    if openalex_id is not None:
        row["openalex_id"] = openalex_id
    return row


# ---- pure helpers ----


def test_short_id():
    assert bcl._short_id("https://openalex.org/W123") == "W123"
    assert bcl._short_id("https://openalex.org/W123/") == "W123"
    assert bcl._short_id("") == ""


def test_kinds_from_title():
    assert "Diffusion" in bcl._kinds("A Diffusion Model for image generation")
    assert "Vision" in bcl._kinds("Object detection in video")
    assert bcl._kinds("A purely theoretical note") == []


def test_clusters_group_focus_by_kind():
    nodes = [
        {"id": "a", "is_focus": True, "kinds": ["Vision", "Diffusion"]},
        {"id": "b", "is_focus": True, "kinds": ["Vision"]},
        {"id": "c", "is_focus": True, "kinds": []},  # -> Other
        {"id": "d", "is_focus": False, "kinds": ["Vision"]},  # non-focus ignored
    ]
    clusters = {c["label"]: c["focus_ids"] for c in bcl._clusters(nodes)}
    assert set(clusters["Vision"]) == {"a", "b"}  # not d (non-focus)
    assert clusters["Diffusion"] == ["a"]
    assert clusters["Other"] == ["c"]


def test_edge_is_heuristic_successor():
    e = bcl._edge("x", "y", 2020, 2024)
    assert e["rel"] == e["relation"] == "successor"
    assert e["conf"] == e["confidence"] == 0.4
    assert "後継" in e["rationale"]
    assert e["provenance"]["producer"] == {
        "name": "paperpilot.scripts.build_conference_lineage",
        "version": "1",
    }
    assert e["provenance"]["evidence"]["source"] == "openalex"
    assert len(e["provenance"]["evidence"]["sha256"]) == 64
    assert e["provenance"]["classification"]["method"] == "citation_heuristic"


# ---- build_graph (network mocked) ----


def test_build_graph_assembles_nodes_edges_clusters():
    oral = _work("W1", "A Diffusion Model for images", 2024, refs=["W100"])
    ref = _work("W100", "Foundational GAN work", 2014)
    citer = _work("W200", "Follow-up on diffusion", 2025)

    def fake(method, url, *, params=None, **kw):
        f = params.get("filter", "")
        if f.startswith("title.search:"):
            return _resp({"results": [oral]})
        if f.startswith("ids.openalex:"):
            return _resp({"results": [ref]})
        if f.startswith("cites:"):
            return _resp({"results": [citer]})
        return _resp({"results": []})

    with patch.object(bcl, "request_with_retry", side_effect=fake):
        graph = bcl.build_graph(
            [_oral("A Diffusion Model for images", openalex_id="W1")],
            display="ECCV 2024",
            refs_per=4,
            citers_per=2,
            generated_at="2026-08-30T00:00:00Z",
        )

    ids = {n["id"] for n in graph["nodes"]}
    assert ids == {"W1", "W100", "W200"}
    focus = [n for n in graph["nodes"] if n["is_focus"]]
    assert [n["id"] for n in focus] == ["W1"]
    assert focus[0]["seed_paper_id"] == PAPER_ID
    assert graph["schema_version"] == "lineage-artifact-v1"
    assert graph["root"] == "W1"
    # nodes sorted by graph-local ID (shared artifact contract)
    assert [n["id"] for n in graph["nodes"]] == ["W1", "W100", "W200"]
    # edges: ref -> oral, oral -> citer
    pairs = {(e["src"], e["dst"]) for e in graph["edges"]}
    assert pairs == {("W100", "W1"), ("W1", "W200")}
    # focus oral clustered by its kind
    assert any(c["label"] == "Diffusion" and "W1" in c["focus_ids"] for c in graph["clusters"])


def test_build_graph_skips_unresolvable_oral():
    def fake(method, url, *, params=None, **kw):
        return _resp({"results": []})  # nothing resolves

    with patch.object(bcl, "request_with_retry", side_effect=fake):
        graph = bcl.build_graph(
            [_oral("Nonexistent paper", openalex_id="W404")], display="X", refs_per=2, citers_per=1
        )
    assert graph["nodes"] == [] and graph["edges"] == []


def test_invalid_seed_fails_before_network():
    with patch.object(bcl, "request_with_retry") as request:
        try:
            bcl.build_graph(
                [{"title": "Paper", "paper_id": "invalid"}],
                display="X",
                refs_per=0,
                citers_per=0,
            )
        except ValueError as exc:
            assert "40-hex" in str(exc)
        else:
            raise AssertionError("invalid seed must fail closed")
    request.assert_not_called()


def test_distinct_seeds_cannot_share_an_openalex_work():
    oral = _work("W1", "Same normalized title", 2024)
    oral["locations"] = [{"landing_page_url": "https://arxiv.org/abs/2403.06764"}]

    def fake(method, url, *, params=None, **kw):
        if params.get("filter", "").startswith("title.search:"):
            return _resp({"results": [oral]})
        return _resp({"results": []})

    with patch.object(bcl, "request_with_retry", side_effect=fake):
        try:
            bcl.build_graph(
                [
                    _oral("Same normalized title", openalex_id="W1"),
                    {
                        **_oral("Same normalized title", OTHER_PAPER_ID),
                        "source": "arxiv",
                        "source_id": "2403.06764",
                    },
                ],
                display="X",
                refs_per=0,
                citers_per=0,
            )
        except ValueError as exc:
            assert "same OpenAlex work" in str(exc)
        else:
            raise AssertionError("ambiguous OpenAlex mapping must fail closed")


def test_root_tie_break_is_independent_of_input_order():
    works = {
        "A": _work("W2", "A", 2024),
        "B": _work("W1", "B", 2024),
    }

    def fake(method, url, *, params=None, **kw):
        query = params.get("filter", "")
        if query.startswith("title.search:"):
            return _resp({"results": [works[query.rsplit(":", 1)[-1]]]})
        return _resp({"results": []})

    args = dict(display="X", refs_per=0, citers_per=0, generated_at="2026-08-30T00:00:00Z")
    with patch.object(bcl, "request_with_retry", side_effect=fake):
        first = bcl.build_graph(
            [
                _oral("A", openalex_id="W2"),
                _oral("B", OTHER_PAPER_ID, openalex_id="W1"),
            ],
            **args,
        )
        second = bcl.build_graph(
            [
                _oral("B", OTHER_PAPER_ID, openalex_id="W1"),
                _oral("A", openalex_id="W2"),
            ],
            **args,
        )
    assert first["root"] == second["root"] == "W1"
    assert first == second


def test_get_failsafe_on_non_json_and_error():
    with patch.object(bcl, "request_with_retry", return_value=None):
        assert bcl._get({"filter": "x"}) is None
    bad = SimpleNamespace(status_code=200, json=lambda: (_ for _ in ()).throw(ValueError()))
    with patch.object(bcl, "request_with_retry", return_value=bad):
        assert bcl._get({"filter": "x"}) is None


def test_strong_arxiv_alias_selects_exact_match_not_first_search_result():
    wrong = _work("W9", "Catalog title", 2024)
    right = _work("W1", "A preprint title variation", 2024)
    right["primary_location"]["landing_page_url"] = "https://arxiv.org/abs/2403.06764v3"

    selected = bcl._select_openalex_match(
        [wrong, right],
        title="Catalog title",
        aliases=frozenset({("arxiv", "2403.06764")}),
    )

    assert selected is right


def test_arxiv_datacite_doi_is_an_exact_external_alias():
    work = _work("W1", "A title variation", 2024)
    work["doi"] = "https://doi.org/10.48550/arXiv.2403.06764"

    assert (
        bcl._select_openalex_match(
            [work],
            title="Catalog title",
            aliases=frozenset({("arxiv", "2403.06764")}),
        )
        is work
    )


def test_strong_alias_never_falls_back_to_an_exact_title():
    exact_title_but_wrong_identity = _work("W9", "Catalog title", 2024)

    selected = bcl._select_openalex_match(
        [exact_title_but_wrong_identity],
        title="Catalog title",
        aliases=frozenset({("arxiv", "2403.06764")}),
    )

    assert selected is None


def test_no_alias_never_uses_even_a_unique_normalized_exact_title():
    exact = _work("W1", "  CATALOG\u3000TITLE  ", 2024)
    assert bcl._select_openalex_match([exact], title="Catalog title", aliases=frozenset()) is None


def test_openreview_location_is_an_exact_external_alias():
    work = _work("W1", "Different title", 2024)
    work["locations"] = [{"landing_page_url": "https://openreview.net/forum?id=AbC_123"}]
    assert (
        bcl._select_openalex_match(
            [work],
            title="Catalog title",
            aliases=frozenset({("openreview", "AbC_123")}),
        )
        is work
    )


def test_all_catalog_rows_are_validated_before_first_network_request():
    valid = _oral("Valid")
    invalid_later = {
        "title": "Invalid later row",
        "paper_id": OTHER_PAPER_ID,
        "source": "arxiv",
        "source_id": "not-an-arxiv-id",
    }
    with patch.object(bcl, "request_with_retry") as request:
        try:
            bcl.build_graph([valid, invalid_later], display="X", refs_per=0, citers_per=0)
        except ValueError as exc:
            assert "source alias" in str(exc)
        else:
            raise AssertionError("invalid alias must fail before resolution")
    request.assert_not_called()


def test_duplicate_strong_alias_fails_before_network():
    first = {
        **_oral("First"),
        "source": "arxiv",
        "source_id": "2403.06764",
    }
    second = {
        **_oral("Second", OTHER_PAPER_ID),
        "source": "arxiv",
        "source_id": "2403.06764v2",
    }
    with patch.object(bcl, "request_with_retry") as request:
        try:
            bcl.build_graph([first, second], display="X", refs_per=0, citers_per=0)
        except ValueError as exc:
            assert "multiple catalog papers" in str(exc)
        else:
            raise AssertionError("ambiguous strong alias must fail before resolution")
    request.assert_not_called()


def test_resolve_requests_enough_candidates_and_external_ids():
    with patch.object(bcl, "_get", return_value={"results": []}) as get:
        assert bcl.resolve_oral("Title", aliases=frozenset({("arxiv", "2403.06764")})) is None
    params = get.call_args.args[0]
    assert params["per-page"] > 1
    assert {"ids", "doi", "locations"}.issubset(set(params["select"].split(",")))


def test_title_only_resolution_is_rejected_without_network():
    with patch.object(bcl, "_get") as get:
        assert bcl.resolve_oral("Title", aliases=frozenset()) is None
    get.assert_not_called()
