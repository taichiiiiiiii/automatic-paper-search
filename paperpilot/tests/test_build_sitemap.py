"""`docs/sitemap.xml` must stay in step with the pages that exist.

Issue #367: the sitemap was hand-maintained and listed 6 URLs while 16
pages existed — eight conference catalogues (~23,000 of the 28,300 papers)
and `eccv-2024/lineage.html` were missing. Nothing generated it, so every
conference added through `scaffold_conference_page.py` skipped it silently.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

from paperpilot.scripts import build_sitemap

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
        if rel in build_sitemap.EXCLUDED:
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
