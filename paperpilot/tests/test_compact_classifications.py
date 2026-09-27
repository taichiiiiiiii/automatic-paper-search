"""Classification-cache v2 compaction contract."""

import pytest

from paperpilot.scripts.compact_classifications import _cache_endpoints


def test_cache_endpoints_supports_legacy_and_opaque_v2_keys() -> None:
    assert _cache_endpoints("a->b", {}) == ("a", "b")
    assert _cache_endpoints("v2:" + "f" * 64, {"src": "a", "dst": "b"}) == ("a", "b")


def test_cache_endpoints_rejects_malformed_v2_values() -> None:
    assert _cache_endpoints("v2:" + "f" * 64, {}) is None
    assert _cache_endpoints("not-a-pair", {}) is None


def test_cache_endpoints_reads_theme_entries_nested_identity() -> None:
    """build_theme_lineage writes src/dst only inside cache_identity. They
    used to read as "no endpoints", which compaction treats as orphaned —
    so live theme classifications were deleted and re-paid for on the next
    rebuild."""
    theme_entry = {
        "status": "success",
        "expires_at": "2099-01-01T00:00:00Z",
        "cache_identity": {"version": 2, "src": "a", "dst": "b"},
        "classification": {"relation": "extends", "confidence": 0.8, "rationale": "r"},
    }
    assert _cache_endpoints("v2:" + "f" * 64, theme_entry) == ("a", "b")


def test_cache_endpoints_prefers_top_level_endpoints() -> None:
    """Deep-lineage entries carry both; the top level stays authoritative."""
    entry = {"src": "top-a", "dst": "top-b", "cache_identity": {"src": "x", "dst": "y"}}
    assert _cache_endpoints("v2:" + "f" * 64, entry) == ("top-a", "top-b")


def test_cache_endpoints_still_rejects_an_identity_without_endpoints() -> None:
    assert _cache_endpoints("v2:" + "f" * 64, {"cache_identity": {"version": 2}}) is None


# ---- compaction must not delete on the strength of an incomplete survey ----


def _seed_cache(tmp_path, entries):
    import json

    cache = tmp_path / "cache" / "classifications.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(entries), encoding="utf-8")
    return cache


def test_compact_refuses_when_a_lineage_artifact_is_unreadable(tmp_path, monkeypatch, capsys):
    """A truncated artifact contributes no ids, so every classification
    only it references looks orphaned — and dropping is irreversible.
    The builders write some artifacts with a plain write_text, so a
    concurrent read catching a partial file is expected, not exotic."""
    import json

    from paperpilot.scripts import compact_classifications as cc

    docs = tmp_path / "docs"
    (docs / "good").mkdir(parents=True)
    (docs / "good" / "lineage.json").write_text(
        json.dumps({"nodes": [{"id": "a"}, {"id": "b"}]}), encoding="utf-8"
    )
    (docs / "bad").mkdir(parents=True)
    (docs / "bad" / "lineage.json").write_text('{"nodes": [{"id": "c"', encoding="utf-8")

    cache = _seed_cache(tmp_path, {"a->b": {}, "c->a": {}})
    monkeypatch.setattr(cc, "DOCS_DIR", docs)
    monkeypatch.setattr(cc, "CACHE_PATH", cache)

    assert cc.compact() == 1
    assert "refusing to compact" in capsys.readouterr().err
    # Nothing was dropped.
    assert json.loads(cache.read_text()) == {"a->b": {}, "c->a": {}}


def test_compact_carries_over_entries_written_during_the_survey(tmp_path, monkeypatch):
    """The docs survey runs outside the lock, so a build can add a
    classification after the snapshot. Judging it against a survey that
    predates it would erase it; it is carried over instead."""
    import json

    from paperpilot.scripts import compact_classifications as cc

    docs = tmp_path / "docs"
    (docs / "conf").mkdir(parents=True)
    (docs / "conf" / "lineage.json").write_text(
        json.dumps({"nodes": [{"id": "a"}, {"id": "b"}]}), encoding="utf-8"
    )

    cache = _seed_cache(tmp_path, {"a->b": {"keep": 1}, "x->y": {"orphan": 1}})
    monkeypatch.setattr(cc, "DOCS_DIR", docs)
    monkeypatch.setattr(cc, "CACHE_PATH", cache)
    monkeypatch.setattr(cc, "ROOT", tmp_path)

    real_collect = cc._collect_live_paper_ids

    def collect_then_concurrent_write():
        result = real_collect()
        # A lineage build persists a new classification right after our
        # survey finished and before we take the lock.
        current = json.loads(cache.read_text())
        current["p->q"] = {"written": "after the survey"}
        cache.write_text(json.dumps(current), encoding="utf-8")
        return result

    monkeypatch.setattr(cc, "_collect_live_paper_ids", collect_then_concurrent_write)

    assert cc.compact() == 0
    final = json.loads(cache.read_text())
    assert final["a->b"] == {"keep": 1}          # surveyed and live -> kept
    assert "x->y" not in final                    # surveyed and orphaned -> dropped
    assert final["p->q"] == {"written": "after the survey"}  # unsurveyed -> carried over


@pytest.mark.parametrize(
    "nodes",
    ["broken", [{"id": "c"}, {}], [{"id": "c"}, "x"], [{"id": 7}], [{"id": ""}]],
    ids=["non-list", "empty-element", "non-mapping-element", "non-string-id", "empty-id"],
)
def test_compact_refuses_when_a_lineage_nodes_block_is_structurally_broken(
    nodes, tmp_path, monkeypatch, capsys
):
    """Parsing the file was not enough.

    A node this survey cannot read makes every classification only that
    artifact references look orphaned, and the drop is irreversible.
    "Keep the ids we could parse" is the partial-page bug with a
    destructive consequence.
    """
    import json

    from paperpilot.scripts import compact_classifications as cc

    docs = tmp_path / "docs"
    (docs / "good").mkdir(parents=True)
    (docs / "good" / "lineage.json").write_text(
        json.dumps({"nodes": [{"id": "a"}, {"id": "b"}]}), encoding="utf-8"
    )
    (docs / "bad").mkdir(parents=True)
    (docs / "bad" / "lineage.json").write_text(json.dumps({"nodes": nodes}), encoding="utf-8")

    cache = _seed_cache(tmp_path, {"a->b": {}, "c->a": {}})
    monkeypatch.setattr(cc, "DOCS_DIR", docs)
    monkeypatch.setattr(cc, "CACHE_PATH", cache)

    assert cc.compact() == 1
    assert "refusing to compact" in capsys.readouterr().err
    assert json.loads(cache.read_text()) == {"a->b": {}, "c->a": {}}


def test_compact_accepts_an_artifact_with_no_nodes_at_all(tmp_path, monkeypatch):
    """An empty graph is a real state, not a broken file."""
    import json

    from paperpilot.scripts import compact_classifications as cc

    docs = tmp_path / "docs"
    (docs / "empty").mkdir(parents=True)
    (docs / "empty" / "lineage.json").write_text(json.dumps({"nodes": []}), encoding="utf-8")

    cache = _seed_cache(tmp_path, {"a->b": {}})
    monkeypatch.setattr(cc, "DOCS_DIR", docs)
    monkeypatch.setattr(cc, "CACHE_PATH", cache)
    monkeypatch.setattr(cc, "ROOT", tmp_path)

    assert cc.compact() == 0
    assert json.loads(cache.read_text()) == {}


def test_compact_refuses_when_a_lineage_artifact_has_no_nodes_key(tmp_path, monkeypatch, capsys):
    """An ABSENT `nodes` key is not an empty graph.

    Our builders always write it, so a parseable file without one is
    not an artifact this survey can read — and counting it as
    "contributes no ids" is precisely what makes the classifications
    only it references look orphaned, right before they are deleted
    for good.
    """
    import json

    from paperpilot.scripts import compact_classifications as cc

    docs = tmp_path / "docs"
    (docs / "good").mkdir(parents=True)
    (docs / "good" / "lineage.json").write_text(
        json.dumps({"nodes": [{"id": "a"}, {"id": "b"}]}), encoding="utf-8"
    )
    (docs / "bad").mkdir(parents=True)
    (docs / "bad" / "lineage.json").write_text(
        json.dumps({"meta": {"source": "something else"}}), encoding="utf-8"
    )

    cache = _seed_cache(tmp_path, {"a->b": {}, "c->a": {}})
    monkeypatch.setattr(cc, "DOCS_DIR", docs)
    monkeypatch.setattr(cc, "CACHE_PATH", cache)
    monkeypatch.setattr(cc, "ROOT", tmp_path)

    assert cc.compact() == 1
    assert "refusing to compact" in capsys.readouterr().err
    assert json.loads(cache.read_text()) == {"a->b": {}, "c->a": {}}
