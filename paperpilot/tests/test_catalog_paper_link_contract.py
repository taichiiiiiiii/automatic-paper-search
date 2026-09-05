"""Static integration contracts for canonical catalog paper links."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
APP = DOCS / "assets" / "app.js"


def _catalog_pages() -> list[Path]:
    pages = (path.parent / "index.html" for path in DOCS.glob("*/papers.json"))
    return sorted(path for path in pages if path.exists())


def test_every_catalog_loads_core_before_app() -> None:
    pages = _catalog_pages()
    assert len(pages) == 10
    for path in pages:
        html = path.read_text(encoding="utf-8")
        root = html.index('src="../assets/paper-slides-public-root.js?v=')
        core = html.index('src="../assets/catalog-core.js?v=')
        app = html.index('src="../assets/app.js?v=')
        assert root < core < app, path


def test_app_uses_canonical_selection_and_detail_shards() -> None:
    js = APP.read_text(encoding="utf-8")
    assert "PaperPilotCatalogCore" in js
    assert "paper-details-v1" in (DOCS / "assets" / "catalog-core.js").read_text(encoding="utf-8")
    assert "selectedPaperId" in js
    assert "pushState" in js and "popstate" in js
    assert "paper__select" in js and "paper__close" in js
    assert "lineage-quality-v1.json" in js


def test_selected_card_alone_loads_verified_reviewed_slides() -> None:
    js = APP.read_text(encoding="utf-8")
    core = (DOCS / "assets" / "catalog-core.js").read_text(encoding="utf-8")
    trust_root = (DOCS / "assets" / "paper-slides-public-root.js").read_text(encoding="utf-8")
    assert 'const slidesHtml = isSelected ? renderPublicSlidesSection(p) : ""' in js
    assert "startPublicSlidesLoad(paperId)" in js
    assert "loadPublicSlideState" in js
    assert "cryptoImpl.subtle.digest" in core
    assert "PaperPilotPublicSlideTrustRoot" in core
    assert "manifest_sha256: null" in trust_root
    assert "fetch(" not in trust_root
    assert "shardRow.path" in core
    assert "paperId.slice(0, 2)" in core
    assert "スライド案を作る" in js
    assert "data-request-slides" in js
    assert "paperSlideEligibility(paper, publicResult.status, PAPER_SLIDE_API)" in js
    assert 'publicState !== "not_published"' in core
    assert "parsePaperSlideApiBase(apiBase) === null" in core
    assert "!usablePdf && !usableAbstract" in core


def test_app_has_no_title_equality_lineage_join() -> None:
    js = APP.read_text(encoding="utf-8")
    assert "n.title.toLowerCase" not in js
    assert "lineageNodeByPaperId" in js


def test_catalog_lineage_is_bound_to_quality_artifact_sha() -> None:
    js = APP.read_text(encoding="utf-8")
    assert "qualityRowIsEligible(collection)" in js
    assert "LineageCore.fetchJsonWithSha256" in js
    assert "LineageCore.qualityRowIsPublishable" in js
    assert "artifactSha256: loadedLineage?.sha256" in js
    assert "enableHeroLineage();" in js


def test_catalog_lineage_navigation_defaults_closed_without_js() -> None:
    lineage_catalogs = sorted(path.parent / "index.html" for path in DOCS.glob("*/lineage.html"))
    assert lineage_catalogs
    for page in lineage_catalogs:
        html = page.read_text(encoding="utf-8")
        assert 'data-lineage-state="unavailable"' in html, page
        assert 'aria-disabled="true">家系図ビュー（公開準備中）' in html, page
        assert '<a class="hero__meta-link" href="lineage.html">' not in html, page

    js = APP.read_text(encoding="utf-8")
    assert 'document.createElement("a")' in js
    assert 'link.href = "lineage.html"' in js
    assert "els.heroLineage.replaceChildren(link)" in js


def test_catalog_join_uses_only_focus_seed_identity() -> None:
    js = APP.read_text(encoding="utf-8")
    assert "node.is_focus !== true" in js
    assert "[node.paper_id, node.seed_paper_id]" not in js


def test_selected_card_styles_are_shared() -> None:
    css = (DOCS / "assets" / "style.css").read_text(encoding="utf-8")
    for selector in (
        ".paper--selected",
        ".paper__select",
        ".paper__close",
        ".paper__detail-status",
        ".paper__slides",
        ".paper__slides-link",
    ):
        assert selector in css
