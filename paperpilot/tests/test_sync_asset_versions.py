"""Tests for paperpilot/scripts/sync_asset_versions.py.

The cache-bust version on every asset reference must agree across all HTML
pages. It drifted before: utils.js shipped as ?v=75 on ten pages and ?v=82 on
four, so four pages served a different utils.js than the rest. CLAUDE.md
records the same class of bug ("themes だけ別バージョンでズレた既往") and
prescribes a manual grep|sed sweep, which is exactly what keeps failing.

These tests cover:
    - versions bump only when the asset's bytes actually change
    - the first run seeds from the highest version already in the HTML, so
      adopting the script does not gratuitously bust every cache
    - every reference to one asset ends up on one version
    - the sweep is idempotent
    - a guard over the real docs/ tree that fails if versions ever diverge
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from paperpilot.scripts import sync_asset_versions as sav

REPO_DOCS = Path(__file__).resolve().parents[2] / "docs"


def _mk(docs: Path, assets: dict[str, str], pages: dict[str, str]) -> None:
    (docs / "assets").mkdir(parents=True, exist_ok=True)
    for name, body in assets.items():
        (docs / "assets" / name).write_text(body, encoding="utf-8")
    for rel, body in pages.items():
        p = docs / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")


# ---- hashing ----


def test_asset_hash_changes_with_content(tmp_path: Path) -> None:
    a = tmp_path / "a.css"
    a.write_text("body{}", encoding="utf-8")
    first = sav.asset_hash(a)
    a.write_text("body{color:red}", encoding="utf-8")
    assert sav.asset_hash(a) != first


def test_asset_hash_is_stable_for_identical_content(tmp_path: Path) -> None:
    a = tmp_path / "a.css"
    b = tmp_path / "b.css"
    a.write_text("body{}", encoding="utf-8")
    b.write_text("body{}", encoding="utf-8")
    assert sav.asset_hash(a) == sav.asset_hash(b)


# ---- seeding + bumping ----


def test_first_run_seeds_from_highest_version_in_html(tmp_path: Path) -> None:
    # utils.js is referenced at v=75 and v=82; adopting the script must land
    # on 82 (the max), not restart at 1 and not bust every cached copy.
    _mk(
        tmp_path,
        {"utils.js": "export const x=1"},
        {
            "index.html": '<script src="assets/utils.js?v=75"></script>',
            "a/index.html": '<script src="../assets/utils.js?v=82"></script>',
        },
    )
    _, versions = sav.sync(tmp_path)
    assert versions["utils.js"]["v"] == 82


def test_unchanged_asset_keeps_its_version(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {"index.html": '<script src="assets/utils.js?v=40"></script>'})
    sav.sync(tmp_path)
    _, versions = sav.sync(tmp_path)
    assert versions["utils.js"]["v"] == 40


def test_changed_asset_bumps_version(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {"index.html": '<script src="assets/utils.js?v=40"></script>'})
    sav.sync(tmp_path)
    (tmp_path / "assets" / "utils.js").write_text("changed", encoding="utf-8")
    _, versions = sav.sync(tmp_path)
    assert versions["utils.js"]["v"] == 41


def test_bump_is_per_asset_not_global(tmp_path: Path) -> None:
    _mk(
        tmp_path,
        {"a.js": "1", "b.js": "2"},
        {
            "index.html": '<script src="assets/a.js?v=10"></script><script src="assets/b.js?v=20"></script>'
        },
    )
    sav.sync(tmp_path)
    (tmp_path / "assets" / "a.js").write_text("changed", encoding="utf-8")
    _, versions = sav.sync(tmp_path)
    assert versions["a.js"]["v"] == 11
    assert versions["b.js"]["v"] == 20  # untouched asset must not bust


# ---- rewriting ----


def test_sync_converges_all_references_to_one_version(tmp_path: Path) -> None:
    _mk(
        tmp_path,
        {"utils.js": "x"},
        {
            "index.html": '<script src="assets/utils.js?v=75"></script>',
            "a/index.html": '<script src="../assets/utils.js?v=82"></script>',
            "b/index.html": '<script src="../assets/utils.js?v=75"></script>',
        },
    )
    sav.sync(tmp_path)
    found = set()
    for p in tmp_path.rglob("*.html"):
        found |= set(re.findall(r"utils\.js\?v=(\d+)", p.read_text(encoding="utf-8")))
    assert found == {"82"}


def test_sync_reports_only_files_it_changed(tmp_path: Path) -> None:
    _mk(
        tmp_path,
        {"utils.js": "x"},
        {
            "index.html": '<script src="assets/utils.js?v=75"></script>',
            "a/index.html": '<script src="../assets/utils.js?v=82"></script>',
        },
    )
    changed, _ = sav.sync(tmp_path)
    assert [p.name for p in changed] == ["index.html"]  # only the stale one


def test_sync_is_idempotent(tmp_path: Path) -> None:
    _mk(
        tmp_path,
        {"utils.js": "x"},
        {
            "index.html": '<script src="assets/utils.js?v=75"></script>',
            "a/index.html": '<script src="../assets/utils.js?v=82"></script>',
        },
    )
    sav.sync(tmp_path)
    changed, _ = sav.sync(tmp_path)
    assert changed == []


def test_sync_leaves_unknown_assets_alone(tmp_path: Path) -> None:
    # A ?v= on something that is not in docs/assets/ (e.g. a vendored file)
    # must not be rewritten to a version we did not compute.
    _mk(
        tmp_path,
        {"utils.js": "x"},
        {
            "index.html": '<link href="/vendor/x.css?v=3"><script src="assets/utils.js?v=9"></script>'
        },
    )
    sav.sync(tmp_path)
    html = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert "/vendor/x.css?v=3" in html


def test_versions_file_is_written_and_readable(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {"index.html": '<script src="assets/utils.js?v=5"></script>'})
    sav.sync(tmp_path)
    data = json.loads((tmp_path / "assets" / sav.VERSIONS_FILENAME).read_text(encoding="utf-8"))
    assert data["utils.js"]["v"] == 5
    assert len(data["utils.js"]["sha"]) == sav.HASH_CHARS


# ---- guard over the real tree ----


def test_repo_docs_have_no_divergent_asset_versions() -> None:
    """The bug this script exists to prevent, asserted on the real site.

    Fails if any asset is referenced at two different versions across
    docs/**/*.html.
    """
    divergent = sav.find_divergent(REPO_DOCS)
    assert divergent == {}, f"assets referenced at multiple versions: {divergent}"
