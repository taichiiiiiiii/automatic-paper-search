"""Fail-closed public UI contracts for currently unaudited lineage routes."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
THEME_HTML = ROOT / "docs" / "themes" / "index.html"
DIRECT_HTML = [
    ROOT / "docs" / "iclr-2026" / "lineage.html",
    ROOT / "docs" / "iclr-2026" / "deep.html",
    ROOT / "docs" / "eccv-2024" / "lineage.html",
]


def _ready_region(html: str) -> str:
    match = re.search(
        r'<div id="lineage-ready-ui" hidden>(?P<body>.*)</div>\s*</main>',
        html,
        re.DOTALL,
    )
    assert match, "interactive lineage region must be hidden in source HTML"
    return match.group("body")


def test_theme_route_defaults_to_truthful_empty_state() -> None:
    html = THEME_HTML.read_text(encoding="utf-8")
    head = html.partition("</head>")[0]
    assert "系譜の公開準備状況" in head
    assert "数分でオンデマンド生成可能" not in head
    assert 'id="lineage-audit-status"' in html
    assert "公開基準を満たしたコレクションはまだありません" in html
    assert 'id="theme-request" autocomplete="off" novalidate hidden' in html
    assert 'id="hero-new-theme"\n        hidden' in html
    assert 'id="hero-toggle"\n        hidden' in html

    ready = _ready_region(html)
    for control in (
        'id="theme-gallery"',
        'id="filters-toggle"',
        'id="theme-search-input"',
        'id="export-svg"',
        'id="export-png"',
        'id="lineage-svg"',
    ):
        assert control in ready


def test_direct_routes_expose_no_controls_before_audit_passes() -> None:
    for path in DIRECT_HTML:
        html = path.read_text(encoding="utf-8")
        assert "監査待ち" in html.partition("</head>")[0], path
        assert 'id="lineage-audit-status"' in html, path
        assert "公開監査を待っています" in html, path
        assert "JavaScript が無効な状態では公開可否を確認できない" in html, path
        ready = _ready_region(html)
        assert 'id="search-input"' in ready, path
        assert 'id="relation-filter"' in ready, path
        assert 'id="lineage-svg"' in ready, path
        assert 'data-view="list"' in ready, path

    deep_html = DIRECT_HTML[1].read_text(encoding="utf-8")
    assert (
        '<span id="deep-footer-hint">品質監査に合格した深掘り系譜のみ公開します</span>'
    ) in deep_html
    assert "エッジにホバー → 分類理由" not in deep_html


def test_surrounding_calls_to_action_describe_status_not_a_live_viewer() -> None:
    guide = (ROOT / "docs" / "how-it-works" / "index.html").read_text(encoding="utf-8")
    not_found = (ROOT / "docs" / "404.html").read_text(encoding="utf-8")
    assert "系譜ビューアで実際に見る" not in guide
    assert "系譜の公開準備状況を見る" in guide
    assert "系譜ビューアを開く" not in not_found
    assert "系譜の公開準備状況を見る" in not_found
