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

import hashlib
import json
import re
from pathlib import Path

import pytest

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


def _write_state(docs: Path, state: object) -> None:
    (docs / "assets" / sav.VERSIONS_FILENAME).write_text(json.dumps(state), encoding="utf-8")


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


def test_unchanged_asset_never_rolls_back_below_mutable_html(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {"index.html": '<script src="assets/utils.js?v=45">'})
    _write_state(
        tmp_path,
        {"utils.js": {"sha": sav.asset_hash(tmp_path / "assets" / "utils.js"), "v": 40}},
    )

    _, versions = sav.sync(tmp_path)

    assert versions["utils.js"]["v"] == 45


def test_changed_asset_bumps_above_higher_branch_version_in_html(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "new"}, {"index.html": '<script src="assets/utils.js?v=45">'})
    _write_state(tmp_path, {"utils.js": {"sha": "0123456789ab", "v": 40}})

    _, versions = sav.sync(tmp_path)

    assert versions["utils.js"]["v"] == 46


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


def test_asset_bump_never_rewrites_hash_bound_deck_html(tmp_path: Path) -> None:
    immutable_relative = "paper-slides-v1/decks/sd1-abc/index.html"
    immutable_html = b'<link href="../../../assets/style.css?v=5">\n'
    _mk(
        tmp_path,
        {"style.css": "body{}"},
        {
            "index.html": '<link href="assets/style.css?v=5">',
            immutable_relative: immutable_html.decode("utf-8"),
        },
    )
    sav.sync(tmp_path)
    immutable_path = tmp_path / immutable_relative
    public_entry = {"html_sha256": hashlib.sha256(immutable_path.read_bytes()).hexdigest()}

    (tmp_path / "assets" / "style.css").write_text("body{color:red}", encoding="utf-8")
    changed, versions = sav.sync(tmp_path)
    final_bytes = immutable_path.read_bytes()

    assert versions["style.css"]["v"] == 6
    assert tmp_path / "index.html" in changed
    assert immutable_path not in changed
    assert final_bytes == immutable_html
    assert hashlib.sha256(final_bytes).hexdigest() == public_entry["html_sha256"]
    assert "style.css?v=6" in (tmp_path / "index.html").read_text(encoding="utf-8")


def test_immutable_deck_versions_do_not_create_false_divergence(tmp_path: Path) -> None:
    _mk(
        tmp_path,
        {"style.css": "body{}"},
        {
            "index.html": '<link href="assets/style.css?v=9">',
            "paper-slides-v1/decks/sd1-old/index.html": (
                '<link href="../../../assets/style.css?v=3">'
            ),
        },
    )

    assert sav.find_divergent(tmp_path) == {}


def test_content_addressed_deck_and_assets_stay_out_of_mutable_versioning(
    tmp_path: Path,
) -> None:
    immutable_asset = "immutable slide css"
    asset_sha = hashlib.sha256(immutable_asset.encode("utf-8")).hexdigest()
    asset_name = f"paper-slides.{asset_sha}.css"
    deck_revision = f"{'a' * 64}-{'b' * 64}.html"
    immutable_relative = f"paper-slides-v1/decks/sd1-immutable/{deck_revision}"
    immutable_html = (
        f'<link href="/automatic-paper-search/assets/{asset_name}" '
        f'integrity="sha256-placeholder">\n'
    )
    _mk(
        tmp_path,
        {
            "paper-slides.css": "mutable slide css",
            asset_name: immutable_asset,
        },
        {
            "index.html": '<link href="assets/paper-slides.css?v=7">',
            immutable_relative: immutable_html,
        },
    )

    immutable_path = tmp_path / immutable_relative
    changed, versions = sav.sync(tmp_path)

    assert set(versions) == {"paper-slides.css"}
    assert immutable_path not in changed
    assert immutable_path.read_text(encoding="utf-8") == immutable_html
    assert sav.find_unversioned(tmp_path) == []


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


@pytest.mark.parametrize("version", [True, -1, sav.MAX_VERSION + 1, "7"])
def test_state_rejects_non_positive_unbounded_or_non_exact_versions(
    tmp_path: Path, version: object
) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    _write_state(tmp_path, {"utils.js": {"sha": "0123456789ab", "v": version}})

    with pytest.raises(sav.StateError, match=r"v must be an integer from 1 through"):
        sav.next_versions(tmp_path)


@pytest.mark.parametrize("sha", ["0123456789AB", "0123456789a", "not-a-digest"])
def test_state_rejects_noncanonical_sha(tmp_path: Path, sha: str) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    _write_state(tmp_path, {"utils.js": {"sha": sha, "v": 7}})

    with pytest.raises(sav.StateError, match=r"sha must be 12 lowercase hexadecimal"):
        sav.next_versions(tmp_path)


def test_state_rejects_extra_record_fields(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    _write_state(
        tmp_path,
        {"utils.js": {"sha": "0123456789ab", "v": 7, "unexpected": "value"}},
    )

    with pytest.raises(sav.StateError, match=r"must contain exactly 'sha' and 'v'"):
        sav.next_versions(tmp_path)


def test_state_rejects_unknown_asset_records(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    _write_state(tmp_path, {"other.js": {"sha": "0123456789ab", "v": 7}})

    with pytest.raises(sav.StateError, match=r"unknown asset 'other.js'"):
        sav.next_versions(tmp_path)


@pytest.mark.parametrize("raw", ["", "[]", "null", "{not-json"])
def test_state_rejects_malformed_root(tmp_path: Path, raw: str) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    (tmp_path / "assets" / sav.VERSIONS_FILENAME).write_text(raw, encoding="utf-8")

    with pytest.raises(sav.StateError, match=r"expected a JSON object"):
        sav.next_versions(tmp_path)


def test_state_rejects_oversize_json_before_parsing(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    state_path = tmp_path / "assets" / sav.VERSIONS_FILENAME
    state_path.write_bytes(b" " * (sav.MAX_STATE_BYTES + 1))

    with pytest.raises(sav.StateError, match=rf"file exceeds {sav.MAX_STATE_BYTES} bytes"):
        sav.next_versions(tmp_path)


def test_state_rejects_duplicate_json_fields(tmp_path: Path) -> None:
    _mk(tmp_path, {"utils.js": "x"}, {})
    state_path = tmp_path / "assets" / sav.VERSIONS_FILENAME
    state_path.write_text('{"utils.js":{"sha":"0123456789ab","v":7,"v":8}}', encoding="utf-8")

    with pytest.raises(sav.StateError, match=r"duplicate field 'v'"):
        sav.next_versions(tmp_path)


# ---- guard over the real tree ----


def test_repo_docs_have_no_divergent_asset_versions() -> None:
    """The bug this script exists to prevent, asserted on the real site.

    Fails if any asset is referenced at two different versions across
    docs/**/*.html.
    """
    divergent = sav.find_divergent(REPO_DOCS)
    assert divergent == {}, f"assets referenced at multiple versions: {divergent}"


# ---- references that carry no ?v= at all ----


def test_find_unversioned_flags_reference_without_version(tmp_path: Path) -> None:
    """A reference with no ?v= is invisible to the rewriter.

    The regex only matches `assets/<file>?v=<digits>`, so a page that ships
    `href="assets/style.css"` is neither divergent nor stale — --check would
    call the site consistent while that page serves whatever the browser
    cached. This is the blind spot, not a style preference.
    """
    _mk(tmp_path, {"style.css": "body{}"}, {"index.html": '<link href="assets/style.css">'})
    assert sav.find_unversioned(tmp_path) == [(tmp_path / "index.html", "assets/style.css")]


def test_find_unversioned_ignores_properly_versioned_references(tmp_path: Path) -> None:
    _mk(tmp_path, {"style.css": "body{}"}, {"index.html": '<link href="assets/style.css?v=9">'})
    assert sav.find_unversioned(tmp_path) == []


def test_find_unversioned_ignores_assets_we_do_not_version(tmp_path: Path) -> None:
    # Images and fonts are not cache-busted by this tool.
    _mk(tmp_path, {"style.css": "body{}"}, {"index.html": '<img src="assets/logo.svg">'})
    assert sav.find_unversioned(tmp_path) == []


def test_check_mode_reports_unversioned(tmp_path: Path) -> None:
    _mk(tmp_path, {"style.css": "body{}"}, {"index.html": '<link href="assets/style.css">'})
    sav.sync(tmp_path)  # establish state so nothing is "stale"
    assert sav.find_unversioned(tmp_path), "adopting the tool must not hide the blind spot"


def test_repo_docs_have_no_unversioned_asset_references() -> None:
    """Guard the real site: every shared asset reference must carry ?v=."""
    missing = sav.find_unversioned(REPO_DOCS)
    assert missing == [], f"asset references with no ?v=: {missing}"
