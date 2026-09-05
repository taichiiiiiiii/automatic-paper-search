"""`docs/sitemap.xml` must stay in step with the pages that exist.

Issue #367: the sitemap was hand-maintained and listed 6 URLs while 16
pages existed — eight conference catalogues (~23,000 of the 28,300 papers)
and `eccv-2024/lineage.html` were missing. Nothing generated it, so every
conference added through `scaffold_conference_page.py` skipped it silently.
"""

from __future__ import annotations

import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from xml.etree import ElementTree

import pytest

from paperpilot.scripts import build_sitemap
from paperpilot.scripts._lineage_contract import validate_lineage_quality_manifest

REPO_ROOT = Path(__file__).resolve().parents[2]
NS = {"s": "https://www.sitemaps.org/schemas/sitemap/0.9"}


def _locs(xml: str) -> set[str]:
    root = ElementTree.fromstring(xml)
    return {e.text or "" for e in root.findall("s:url/s:loc", NS)}


def test_generated_sitemap_is_well_formed_xml() -> None:
    """A double hyphen in the header comment made the first version unparseable.

    The generator's own comparison is string-based, so it reported the
    broken file as up to date; only a parse catches this.
    """
    ElementTree.fromstring(build_sitemap.render(build_sitemap.page_paths()))


def test_repo_sitemap_is_up_to_date() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "paperpilot.scripts.build_sitemap", "--check"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, (
        "docs/sitemap.xml does not match the pages in docs/. Run "
        "`uv run python -m paperpilot.scripts.build_sitemap`.\n"
        f"{result.stdout}\n{result.stderr}"
    )


def test_every_published_page_is_listed(tmp_path: Path) -> None:
    """Parity in both directions, computed independently of the generator."""
    docs = REPO_ROOT / "docs"
    expected = set()
    for path in docs.rglob("*.html"):
        rel = path.relative_to(docs).as_posix()
        if build_sitemap.is_excluded(rel):
            continue
        expected.add(rel[: -len("index.html")] if rel.endswith("index.html") else rel)

    listed = {
        loc.removeprefix(build_sitemap.BASE_URL)
        for loc in _locs((docs / "sitemap.xml").read_text(encoding="utf-8"))
    }
    assert listed == expected, (
        f"missing from sitemap: {sorted(expected - listed)}; "
        f"listed but not published: {sorted(listed - expected)}"
    )


def test_404_is_excluded() -> None:
    """404.html is the SPA fallback, served with HTTP 404 — never index it."""
    listed = _locs((REPO_ROOT / "docs" / "sitemap.xml").read_text(encoding="utf-8"))
    assert not any(loc.endswith("404.html") for loc in listed)


def test_nojs_duplicate_pages_are_noindex_and_excluded() -> None:
    docs = REPO_ROOT / "docs"
    fallbacks = sorted(docs.glob("*/paper-links.html"))
    assert fallbacks
    listed = _locs((docs / "sitemap.xml").read_text(encoding="utf-8"))
    for fallback in fallbacks:
        source = fallback.read_text(encoding="utf-8")
        assert '<meta name="robots" content="noindex" />' in source
        assert build_sitemap.is_excluded(fallback.relative_to(docs).as_posix())
        assert not any(loc.endswith(fallback.relative_to(docs).as_posix()) for loc in listed)


def test_deck_revisions_fail_closed_until_manifest_driven_listing(tmp_path: Path) -> None:
    """Neither current-looking nor stale deck files are trusted by discovery."""

    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    deck_id = f"sd1-{'a' * 64}"
    revisions = {
        "current": f"{'b' * 64}-{'c' * 64}.html",
        "old": f"{'d' * 64}-{'e' * 64}.html",
    }
    deck_root = tmp_path / "paper-slides-v1" / "decks" / deck_id
    deck_root.mkdir(parents=True)
    for revision in revisions.values():
        (deck_root / revision).write_text("<!doctype html>", encoding="utf-8")

    paths = build_sitemap.page_paths(tmp_path)

    assert paths == [""]
    for revision in revisions.values():
        relative = f"paper-slides-v1/decks/{deck_id}/{revision}"
        assert build_sitemap.is_excluded(relative)
        assert relative not in paths


def _quality_manifest() -> dict:
    return json.loads((REPO_ROOT / "docs" / "lineage-quality-v1.json").read_text(encoding="utf-8"))


def _write_quality_fixture(tmp_path: Path, rows: list[dict]) -> None:
    payload = _quality_manifest()
    payload["collections"] = sorted(rows, key=lambda row: row["collection_id"])
    (tmp_path / "lineage-quality-v1.json").write_text(json.dumps(payload), encoding="utf-8")


def _passed(row: dict) -> dict:
    row = deepcopy(row)
    row["availability"] = "ready"
    row["audit_status"] = "passed"
    row["artifact_schema_version"] = "lineage-artifact-v1"
    row["input_sha256"] = "a" * 64
    row["audit"]["fixture_sha256"] = "b" * 64
    for check in row["audit"]["checks"]:
        check["status"] = "passed"
        check["observed"] = check["expected"]
        check["evidence"] = []
    names = {check["name"] for check in row["audit"]["checks"]}
    for name in sorted({"artifact_contract_v1", "golden_fixture"} - names):
        row["audit"]["checks"].append(
            {"name": name, "status": "passed", "observed": 0, "expected": 0, "evidence": []}
        )
    row["audit"]["checks"].sort(key=lambda check: check["name"])
    if row["kind"] == "deep":
        row["paper_id"] = "d" * 40
        row["arxiv_id"] = "2601.00001"
        row["manifest_input_sha256"] = "c" * 64
    return row


def test_lineage_routes_fail_closed_when_no_collection_is_eligible(tmp_path: Path) -> None:
    for relative in ("themes/index.html", "iclr-2026/lineage.html", "iclr-2026/deep.html"):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("<!doctype html>", encoding="utf-8")
    _write_quality_fixture(tmp_path, _quality_manifest()["collections"])

    assert build_sitemap.page_paths(tmp_path) == []


def test_sitemap_lists_only_ready_and_passed_lineage_routes(tmp_path: Path) -> None:
    rows = _quality_manifest()["collections"]
    selected = [
        _passed(next(row for row in rows if row["kind"] == kind))
        for kind in ("conference", "theme", "deep")
    ]
    for row in selected:
        relative = (
            "themes/index.html"
            if row["kind"] == "theme"
            else f"{row['slug']}/{'deep.html' if row['kind'] == 'deep' else 'lineage.html'}"
        )
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("<!doctype html>", encoding="utf-8")
    _write_quality_fixture(tmp_path, selected)

    assert set(build_sitemap.page_paths(tmp_path)) == {
        "themes/",
        f"{selected[0]['slug']}/lineage.html",
        f"{selected[2]['slug']}/deep.html",
    }


def test_malformed_quality_manifest_excludes_every_lineage_route(tmp_path: Path) -> None:
    path = tmp_path / "themes" / "index.html"
    path.parent.mkdir(parents=True)
    path.write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "lineage-quality-v1.json").write_text("{}", encoding="utf-8")

    assert build_sitemap.page_paths(tmp_path) == []


def test_public_quality_manifest_matches_the_canonical_strict_contract() -> None:
    assert validate_lineage_quality_manifest(_quality_manifest()) == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda row: row["audit"]["checks"].reverse(),
        lambda row: row["audit"]["checks"].append(deepcopy(row["audit"]["checks"][0])),
        lambda row: row["audit"]["checks"][0].__setitem__("status", "unknown"),
        lambda row: row.__setitem__("audit_status", "failed"),
    ],
    ids=(
        "checks-descending",
        "check-name-duplicate",
        "passed-row-has-unknown-check",
        "failed-status-without-failed-check",
    ),
)
def test_adversarial_audit_manifest_excludes_all_lineage_routes(
    tmp_path: Path,
    mutation,
) -> None:
    theme_row = _passed(
        next(row for row in _quality_manifest()["collections"] if row["kind"] == "theme")
    )
    mutation(theme_row)
    page = tmp_path / "themes" / "index.html"
    page.parent.mkdir(parents=True)
    page.write_text("<!doctype html>", encoding="utf-8")
    _write_quality_fixture(tmp_path, [theme_row])

    assert build_sitemap.page_paths(tmp_path) == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda row: row.__setitem__("collection_id", f"conference:not-{row['slug']}"),
        lambda row: row.__setitem__("path", f"not-{row['slug']}/lineage.json"),
    ],
    ids=("ineligible-collection-id-mismatch", "ineligible-kind-slug-path-mismatch"),
)
def test_invalid_ineligible_row_rejects_otherwise_publishable_manifest(
    tmp_path: Path,
    mutate,
) -> None:
    rows = _quality_manifest()["collections"]
    theme_row = _passed(next(row for row in rows if row["kind"] == "theme"))
    ineligible = deepcopy(next(row for row in rows if row["kind"] == "conference"))
    mutate(ineligible)
    page = tmp_path / "themes" / "index.html"
    page.parent.mkdir(parents=True)
    page.write_text("<!doctype html>", encoding="utf-8")
    _write_quality_fixture(tmp_path, [theme_row, ineligible])

    assert build_sitemap.page_paths(tmp_path) == []
