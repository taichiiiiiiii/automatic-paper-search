"""Tests for paperpilot/scripts/build_conference_lineage.py.

The OpenAlex HTTP layer is patched (request_with_retry); pure helpers and the
graph assembly are exercised directly. No network.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.scripts import build_conference_lineage as bcl


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
    }


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
    assert e == {"src": "x", "dst": "y", "rel": "successor", "conf": 0.4,
                 "rationale": e["rationale"]}
    assert "後継" in e["rationale"]


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
            [{"title": "A Diffusion Model for images"}],
            display="ECCV 2024", refs_per=4, citers_per=2,
        )

    ids = {n["id"] for n in graph["nodes"]}
    assert ids == {"W1", "W100", "W200"}
    focus = [n for n in graph["nodes"] if n["is_focus"]]
    assert [n["id"] for n in focus] == ["W1"]
    # nodes sorted by year ascending
    assert [n["year"] for n in graph["nodes"]] == [2014, 2024, 2025]
    # edges: ref -> oral, oral -> citer
    pairs = {(e["src"], e["dst"]) for e in graph["edges"]}
    assert pairs == {("W100", "W1"), ("W1", "W200")}
    # focus oral clustered by its kind
    assert any(c["label"] == "Diffusion" and "W1" in c["focus_ids"] for c in graph["clusters"])


def test_build_graph_skips_unresolvable_oral():
    def fake(method, url, *, params=None, **kw):
        return _resp({"results": []})  # nothing resolves

    with patch.object(bcl, "request_with_retry", side_effect=fake):
        graph = bcl.build_graph([{"title": "Nonexistent paper"}], display="X", refs_per=2, citers_per=1)
    assert graph["nodes"] == [] and graph["edges"] == []


def test_get_failsafe_on_non_json_and_error():
    with patch.object(bcl, "request_with_retry", return_value=None):
        assert bcl._get({"filter": "x"}) is None
    bad = SimpleNamespace(status_code=200, json=lambda: (_ for _ in ()).throw(ValueError()))
    with patch.object(bcl, "request_with_retry", return_value=bad):
        assert bcl._get({"filter": "x"}) is None
