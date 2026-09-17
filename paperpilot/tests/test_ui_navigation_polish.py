"""Accessible search guidance and lineage recovery contracts."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "docs"


def test_search_help_is_associated_and_feature_status_is_honest():
    html = (ROOT / "index.html").read_text()
    assert 'aria-describedby="s0-search-help s0-search-status"' in html
    assert 'id="s0-search-help"' in html
    assert "要旨・本文の全文検索には未対応" in html
    assert "検索した後は？" in html
    assert "公開済みの場合のみ" in html


def test_lineage_has_recovery_and_keyboard_scroll_region():
    html = (ROOT / "lineage/index.html").read_text()
    audit = html.split('id="lineage-audit-status"')[1].split("</section>")[0]
    assert 'href="../"' in audit
    assert "論文を探し直す" in audit
    graph = html.split('id="lineage-graph"')[1].split(">")[0]
    assert 'tabindex="0"' in graph
    assert 'aria-describedby="lineage-graph-help"' in graph
    assert 'id="lineage-graph-help"' in html


def test_lineage_long_text_and_focus_are_visible():
    css = (ROOT / "assets/lineage-focus.css").read_text()
    assert ".lineage-focus :focus-visible" in css
    assert ".lineage-focus__header > div" in css
    assert "overflow-wrap: anywhere" in css


def test_empty_search_explains_recovery():
    source = (ROOT / "assets/search.js").read_text()
    assert "短いキーワードに変えるか、絞り込みをクリアしてください。" in source


def test_available_conferences_precede_pending_lineages():
    html = (ROOT / "index.html").read_text()
    assert html.index('id="s0-confs"') < html.index('id="s0-lineages"')
    assert ".s0__confs-list[hidden] { display: none; }" in html


def test_search_detail_dialog_behavior():
    import shutil
    import subprocess

    import pytest

    node = shutil.which("node")
    if node is None:
        pytest.skip("node not installed")
    script = Path(__file__).parent / "viewer" / "test_search_detail_dialog.mjs"
    result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
