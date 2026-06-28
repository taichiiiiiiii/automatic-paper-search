"""Tests for paperpilot/scripts/collect_cvf.py.

Parsing (detail_paths, parse_detail) is pure given HTML strings; the network
(fetch_listing / collect) is exercised by patching request_with_retry. No network.
"""

from __future__ import annotations

import csv as _csv
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.scripts import collect_conference as cc
from paperpilot.scripts import collect_cvf as cvf

_LISTING = """
<dt class="ptitle"><a href="/content/CVPR2025/html/Xiao_Det_paper.html">Det</a></dt>
<dd><a href="/content/CVPR2025/papers/Xiao_Det_paper.pdf">pdf</a></dd>
<dt class="ptitle"><a href="/content/CVPR2025/html/Lee_Seg_paper.html">Seg</a></dt>
<dd><a href="/content/CVPR2025/html/Xiao_Det_paper.html">dup link</a></dd>
"""

_DETAIL = """<html><head>
<meta name="citation_title" content="Deterministic Image Translation &amp; Bridges" />
<meta name="citation_author" content="Xiao, Bohan" />
<meta name="citation_author" content="Wang, Peiyong" />
<meta name="citation_pdf_url" content="https://openaccess.thecvf.com/content/CVPR2025/papers/Xiao_Det_paper.pdf" />
</head><body>
<div id="abstract">
   Image-to-Image translation converts an image  from one domain to another.
</div></body></html>"""


def test_detail_paths_extracts_and_dedups_in_order():
    paths = cvf.detail_paths(_LISTING, "CVPR2025")
    assert paths == [
        "/content/CVPR2025/html/Xiao_Det_paper.html",
        "/content/CVPR2025/html/Lee_Seg_paper.html",
    ]


def test_detail_paths_scopes_to_the_given_conference():
    mixed = _LISTING + '<a href="/content/ICCV2025/html/Other_paper.html">x</a>'
    assert all("CVPR2025" in p for p in cvf.detail_paths(mixed, "CVPR2025"))


def test_parse_detail_maps_meta_and_abstract():
    url = "https://openaccess.thecvf.com/content/CVPR2025/html/Xiao_Det_paper.html"
    row = cvf.parse_detail(_DETAIL, url, "CVPR")
    assert row is not None
    assert row["title"] == "Deterministic Image Translation & Bridges"  # entity unescaped
    assert row["authors"] == "Bohan Xiao; Peiyong Wang"  # "Last, First" -> "First Last"
    assert row["abstract"].startswith("Image-to-Image translation converts")
    assert "  " not in row["abstract"]  # whitespace collapsed
    assert row["venue"] == "CVPR" and row["venue_tier"] == 2
    assert row["url"] == url
    assert row["pdf_url"].endswith("Xiao_Det_paper.pdf")
    assert row["arxiv_id"] == "" and row["comment"] == ""


def test_parse_detail_iccv_is_tier_3():
    row = cvf.parse_detail(_DETAIL, "u", "ICCV")
    assert row is not None and row["venue_tier"] == 3


def test_parse_detail_returns_none_without_title():
    assert cvf.parse_detail("<html>no meta</html>", "u", "CVPR") is None


def test_fetch_listing_failsafe():
    with patch.object(cvf, "request_with_retry", return_value=None):
        assert cvf.fetch_listing("CVPR2025") == []


def test_collect_end_to_end_mocked():
    listing_resp = SimpleNamespace(status_code=200, text=_LISTING)
    detail_resp = SimpleNamespace(status_code=200, text=_DETAIL)

    def fake(method, url, **kw):
        return listing_resp if url.endswith("?day=all") else detail_resp

    with patch.object(cvf, "request_with_retry", side_effect=fake):
        rows = cvf.collect("CVPR2025", "CVPR", max_workers=2)
    # two distinct detail pages, both parse to the same (mocked) detail -> deduped by url
    assert len(rows) == 2
    assert all(r["venue"] == "CVPR" for r in rows)


def test_rows_write_via_shared_writer(tmp_path: Path):
    row = cvf.parse_detail(_DETAIL, "https://openaccess.thecvf.com/content/CVPR2025/html/x.html", "CVPR")
    csv_path = cc.write_outputs("cvpr-2025", [row], [], output_root=tmp_path, date="2026-06-28")
    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS
    assert read[0]["venue"] == "CVPR"
