from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / "docs"
CONFERENCES = (
    "aaai-2026",
    "acl-2025",
    "cvpr-2025",
    "cvpr-2026",
    "eccv-2024",
    "emnlp-2025",
    "iccv-2025",
    "iclr-2026",
    "icml-2025",
    "neurips-2025",
)
NODE_SCRIPTS = (
    "test_lineage_focus_app.mjs",
    "test_catalog_pilot_lineage.mjs",
)


@pytest.mark.parametrize("script", NODE_SCRIPTS)
def test_lineage_focus_node_contract(script: str) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not installed")
    completed = subprocess.run(
        [node, str(Path(__file__).with_name(script))],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "contract passed" in completed.stdout


def test_focus_route_is_static_fail_closed() -> None:
    html = (DOCS / "lineage" / "index.html").read_text(encoding="utf-8")
    assert '<article id="lineage-ready" hidden' in html
    assert '<section id="lineage-audit-status"' in html
    assert 'id="lineage-audit-heading"' in html
    assert "<noscript>" in html
    assert "lineage-v2-core.js" in html
    assert html.index("lineage-v2-core.js") < html.index("lineage-focus.js")
    assert html.index('id="lineage-graph-panel"') < html.index('id="lineage-list-panel"')
    assert html.index('id="lineage-list-panel"') < html.index('id="lineage-node-cards"')
    advanced = html.index('<details class="lineage-focus__advanced">')
    assert " open" not in html[advanced : html.index(">", advanced)]
    assert html.index('id="lineage-hops"') < advanced
    assert advanced < html.index('id="lineage-confidence"') < html.index("</details>", advanced)
    assert 'id="lineage-advanced-summary">詳細な絞り込み' in html
    assert "fonts.googleapis.com" not in html
    assert "connect-src 'self'" in html


@pytest.mark.parametrize("conference", CONFERENCES)
def test_catalog_loads_pilot_core_before_selected_card_app(conference: str) -> None:
    html = (DOCS / conference / "index.html").read_text(encoding="utf-8")
    assert "lineage-focus.css" in html
    assert html.index("lineage-v2-core.js") < html.index('src="../assets/app.js')


def test_selected_card_is_the_only_pilot_link_owner() -> None:
    source = (DOCS / "assets" / "app.js").read_text(encoding="utf-8")
    assert 'const pilotLineageHtml = isSelected ? renderPilotLineageSection(p) : "";' in source
    assert "startPilotLineageLookup(paperId);" in source
    assert "abandonPilotLineageLookup(previousPaperId);" in source
    assert "../lineage/?paper=" in source
    assert (
        "artifact.path"
        not in source[
            source.index("function startPilotLineageLookup") : source.index(
                "function lineageIsPublishable"
            )
        ]
    )


def test_focus_view_keeps_observation_review_and_navigation_boundaries() -> None:
    source = (DOCS / "assets" / "lineage-focus.js").read_text(encoding="utf-8")
    assert "label.review_id === claim.review_binding.review_id" in source
    assert "label.evidence_sha256 === claim.review_binding.evidence_sha256" in source
    assert "label.src === claim.src" not in source
    assert 'factsHeading.textContent = "観測された事実"' in source
    assert 'interpretationHeading.textContent = "解釈と判定"' in source
    assert '...valueRow("引用側 work ID", item.citing_work_id)' in source
    assert "els.title.textContent = model.projection.focus.title" in source
    assert "hops: String(state.hops)" in source
    assert "min_conf: String(state.minConfidence)" in source
