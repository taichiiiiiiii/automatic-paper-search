"""Tests for paperpilot/scripts/scaffold_conference_page.py."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from paperpilot.scripts import scaffold_conference_page as scaffold
from paperpilot.scripts._lineage_contract import (
    LINEAGE_ARTIFACT_VERSION,
    PAPER_ID_RE,
    validate_lineage_artifact,
)


def _write_template(docs: Path) -> None:
    (docs / "cvpr-2026").mkdir(parents=True)
    (docs / "cvpr-2026" / "index.html").write_text(
        "<title>CVPR 2026 — PaperPilot</title>\n"
        '<meta name="description" content="CVPR 2026 catalog" />\n'
        '<link rel="canonical" href="https://x/automatic-paper-search/cvpr-2026/" />\n'
        '<nav class="hero__breadcrumb"><a href="../">PaperPilot</a> / CVPR 2026</nav>\n'
        '<h1 class="hero__title">CVPR 2026 <em>採択論文</em></h1>\n'
        '<p class="hero__lede">\n      old CVPR-specific lede with <code>CVPR 2026</code>.\n    </p>\n'
        '<noscript><a href="paper-links.html">JavaScript なしの論文リンク一覧</a></noscript>\n'
        '<script src="../assets/paper-slides-public-root.js?v=1" defer></script>\n'
        '<script src="../assets/catalog-core.js?v=1" defer></script>\n'
        '<script src="../assets/app.js?v=79" defer></script>\n',
        encoding="utf-8",
    )


def test_scaffold_substitutes_identifiers_and_lede(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)

    out = scaffold.scaffold(
        "neurips-2026", "NeurIPS 2026", "新しい NeurIPS の説明文", docs_root=docs
    )
    html = out.read_text(encoding="utf-8")

    assert out == docs / "neurips-2026" / "index.html"
    assert "NeurIPS 2026 — PaperPilot" in html
    assert "neurips-2026/" in html  # canonical rewritten
    assert "cvpr-2026" not in html  # no template slug leaks
    assert "CVPR 2026" not in html  # no template display leaks
    assert "新しい NeurIPS の説明文" in html
    assert "old CVPR-specific lede" not in html  # old lede replaced
    assert '<a href="paper-links.html">JavaScript なしの論文リンク一覧</a>' in html
    assert html.index("paper-slides-public-root.js") < html.index("catalog-core.js")
    assert html.index("catalog-core.js") < html.index("app.js")


def test_scaffold_writes_empty_lineage(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    scaffold.scaffold("eccv-2026", "ECCV 2026", "lede", docs_root=docs)

    lineage = json.loads((docs / "eccv-2026" / "lineage.json").read_text(encoding="utf-8"))
    # Empty stub must satisfy the strict lineage-artifact-v1 contract.
    assert lineage["schema_version"] == LINEAGE_ARTIFACT_VERSION
    assert lineage["root"] is None  # empty graph: root must be null, never a guess
    assert lineage["nodes"] == []
    assert lineage["edges"] == []
    assert lineage["clusters"] == []
    assert isinstance(lineage["meta"], dict)
    assert lineage["meta"]["conference"] == "eccv-2026"


def test_scaffold_empty_lineage_passes_shared_validator(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    scaffold.scaffold("eccv-2026", "ECCV 2026", "lede", docs_root=docs)

    lineage = json.loads((docs / "eccv-2026" / "lineage.json").read_text(encoding="utf-8"))
    issues = validate_lineage_artifact(lineage, kind="conference")
    assert issues == []


def test_scaffold_empty_lineage_contains_no_paper_identity(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    scaffold.scaffold("eccv-2026", "ECCV 2026", "lede", docs_root=docs)

    raw = (docs / "eccv-2026" / "lineage.json").read_text(encoding="utf-8")
    # An empty artifact must not invent or guess any paper identity.
    assert PAPER_ID_RE.search(raw) is None
    assert re.search(r"seed_paper_id", raw) is None


def test_scaffold_refuses_template_conference(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    with pytest.raises(ValueError):
        scaffold.scaffold("cvpr-2026", "CVPR 2026", "lede", docs_root=docs)


def test_scaffold_escapes_hostile_display_and_lede_as_plain_text(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    display = 'Bad & "quoted" \'name\'><meta http-equiv="refresh"><script>alert(1)</script>'
    lede = '</p><meta http-equiv="refresh"><script>alert(2)</script>&"\'\\g<1>'

    out = scaffold.scaffold("safe-2026", display, lede, docs_root=docs)
    html = out.read_text(encoding="utf-8")

    assert "<script>alert(1)</script>" not in html
    assert "<script>alert(2)</script>" not in html
    assert '<meta http-equiv="refresh">' not in html
    assert "Bad &amp; &quot;quoted&quot; &#x27;name&#x27;&gt;" in html
    assert 'content="Bad &amp; &quot;quoted&quot; &#x27;name&#x27;&gt;' in html
    assert (
        "&lt;/p&gt;&lt;meta http-equiv=&quot;refresh&quot;&gt;"
        "&lt;script&gt;alert(2)&lt;/script&gt;&amp;&quot;&#x27;\\g&lt;1&gt;" in html
    )
    assert len(re.findall(r'<p class="hero__lede">', html)) == 1
    assert len(re.findall(r"</p>", html)) == 1


@pytest.mark.parametrize(
    "conference",
    [
        "../escape",
        "nested/path",
        ".hidden",
        "-leading",
        "trailing-",
        "UPPER-2026",
        "a",
        "a" * 41,
        "daily",
        "assets",
        "design",
        "how-it-works",
        "paper-details-v1",
        "paper-slides-v1",
        "research",
        "search-paper-ids-v1",
        "themes",
    ],
)
def test_scaffold_rejects_unsafe_or_reserved_conference_slugs(tmp_path: Path, conference: str):
    docs = tmp_path / "docs"
    _write_template(docs)

    with pytest.raises(ValueError):
        scaffold.scaffold(conference, "Display", "lede", docs_root=docs)

    assert not (tmp_path / "escape").exists()
    assert not (docs / conference / "index.html").exists()


def test_scaffold_refuses_to_overwrite_existing_conference_page(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    existing = docs / "existing-2026"
    existing.mkdir()
    original = "existing page\n"
    (existing / "index.html").write_text(original, encoding="utf-8")

    with pytest.raises(FileExistsError):
        scaffold.scaffold("existing-2026", "Existing 2026", "lede", docs_root=docs)

    assert (existing / "index.html").read_text(encoding="utf-8") == original
