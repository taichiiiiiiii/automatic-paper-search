"""Tests for paperpilot/scripts/scaffold_conference_page.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from paperpilot.scripts import scaffold_conference_page as scaffold


def _write_template(docs: Path) -> None:
    (docs / "cvpr-2026").mkdir(parents=True)
    (docs / "cvpr-2026" / "index.html").write_text(
        "<title>CVPR 2026 — PaperPilot</title>\n"
        '<link rel="canonical" href="https://x/automatic-paper-search/cvpr-2026/" />\n'
        '<nav class="hero__breadcrumb"><a href="../">PaperPilot</a> / CVPR 2026</nav>\n'
        '<h1 class="hero__title">CVPR 2026 <em>採択論文</em></h1>\n'
        '<p class="hero__lede">\n      old CVPR-specific lede with <code>CVPR 2026</code>.\n    </p>\n'
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


def test_scaffold_writes_empty_lineage(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    scaffold.scaffold("eccv-2026", "ECCV 2026", "lede", docs_root=docs)

    lineage = json.loads((docs / "eccv-2026" / "lineage.json").read_text(encoding="utf-8"))
    assert lineage["nodes"] == [] and lineage["edges"] == []
    assert lineage["meta"]["conference"] == "eccv-2026"


def test_scaffold_refuses_template_conference(tmp_path: Path):
    docs = tmp_path / "docs"
    _write_template(docs)
    with pytest.raises(ValueError):
        scaffold.scaffold("cvpr-2026", "CVPR 2026", "lede", docs_root=docs)
