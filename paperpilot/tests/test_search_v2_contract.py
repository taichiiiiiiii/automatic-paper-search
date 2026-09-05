"""Static and HTML contracts for the unified landing search."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "docs" / "index.html"
SEARCH = ROOT / "docs" / "assets" / "search.js"
LANDING = ROOT / "docs" / "assets" / "landing.js"


def test_landing_exposes_search_v2_states() -> None:
    html = INDEX.read_text(encoding="utf-8")
    for element_id in (
        "s0-search-retry",
        "s0-search-more",
        "s0-results",
        "s0-results-list",
        "s0-results-pagination",
        "s0-lineages-list",
    ):
        assert f'id="{element_id}"' in html


def test_search_owns_query_and_paging_url_state() -> None:
    search = SEARCH.read_text(encoding="utf-8")
    landing = LANDING.read_text(encoding="utf-8")
    assert "search-index-v2.json" in search
    assert "search-paper-ids-v1/" in search
    assert "replaceState" in search
    assert "pushState" in search
    assert "popstate" in search
    assert 'addEventListener("focus"' not in search
    assert "URLSearchParams(window.location.search)" not in landing
    assert "MutationObserver" not in landing


def test_search_has_fail_closed_validation_and_retry() -> None:
    search = SEARCH.read_text(encoding="utf-8")
    assert "validateIndex" in search
    assert "validateIdBlock" in search
    assert "s0-search-retry" in search
    assert ".textContent" in search


def test_lineage_shelf_uses_quality_read_model() -> None:
    landing = LANDING.read_text(encoding="utf-8")
    assert 'fetch("lineage-quality-v1.json"' in landing
    assert "LineageCore.parseQualityManifest" in landing
    assert "LineageCore.qualityRowIsEligible" in landing
    assert "collection.node_count > 0" in landing
    assert 'new Set(["eccv-2024", "iclr-2026"])' in landing
    assert "innerHTML" not in landing
