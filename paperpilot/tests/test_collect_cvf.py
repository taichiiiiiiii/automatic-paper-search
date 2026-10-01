"""Tests for paperpilot/scripts/collect_cvf.py.

Parsing (detail_paths, parse_detail) is pure given HTML strings; the network
(fetch_listing / collect) is exercised by patching request_with_retry. No network.
"""

from __future__ import annotations

import csv as _csv
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

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
    """A listing failure must not raise, and must report ok=False so the
    caller can tell it apart from a genuinely empty conference id."""
    with patch.object(cvf, "request_with_retry", return_value=None):
        assert cvf.fetch_listing("CVPR2025") == ([], False)


def test_collect_end_to_end_mocked():
    listing_resp = SimpleNamespace(status_code=200, text=_LISTING)
    detail_resp = SimpleNamespace(status_code=200, text=_DETAIL)

    def fake(method, url, **kw):
        return listing_resp if url.endswith("?day=all") else detail_resp

    with patch.object(cvf, "request_with_retry", side_effect=fake):
        rows, complete = cvf.collect("CVPR2025", "CVPR", max_workers=2, delay_seconds=0)
    # two distinct detail pages, both parse to the same (mocked) detail -> deduped by url
    assert len(rows) == 2
    assert all(r["venue"] == "CVPR" for r in rows)
    assert complete is True


def test_collect_shares_one_rate_limiter_across_all_workers():
    """Regression test (closes #395): concurrent workers must share a
    SINGLE RateLimiter instance so the combined request rate — not each
    thread independently — is throttled, avoiding 429s / anti-scraping
    blocks on openaccess.thecvf.com. (RateLimiter.wait() itself is
    unit-tested for thread-safety in test_rate_limiter.py.)"""
    listing_resp = SimpleNamespace(status_code=200, text=_LISTING)
    detail_resp = SimpleNamespace(status_code=200, text=_DETAIL)

    def fake(method, url, **kw):
        return listing_resp if url.endswith("?day=all") else detail_resp

    created_limiters = []
    real_rate_limiter_cls = cvf.RateLimiter

    class _SpyRateLimiter(real_rate_limiter_cls):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            created_limiters.append(self)

    with patch.object(cvf, "RateLimiter", _SpyRateLimiter):
        with patch.object(cvf, "request_with_retry", side_effect=fake):
            cvf.collect("CVPR2025", "CVPR", max_workers=8, delay_seconds=0)

    # Exactly one limiter for the whole collect() call, not one per worker.
    assert len(created_limiters) == 1


def test_collect_counts_and_logs_failed_pages(caplog):
    """Regression test (closes #395 follow-up): failures must be tracked
    (not silently dropped) so operators can see partial-collection risk."""
    listing_resp = SimpleNamespace(status_code=200, text=_LISTING)

    def fake(method, url, **kw):
        if url.endswith("?day=all"):
            return listing_resp
        return SimpleNamespace(status_code=500, text="")

    with patch.object(cvf, "request_with_retry", side_effect=fake):
        with caplog.at_level("WARNING"):
            rows, complete = cvf.collect("CVPR2025", "CVPR", max_workers=2, delay_seconds=0)
    assert rows == []
    assert complete is False
    # _LISTING has exactly 2 distinct detail paths (deduped); both fail here,
    # so the reported count must be exactly "2/2", not just any warning text.
    assert any(
        r.message == "cvf: 2/2 detail pages failed to fetch/parse (dropped)"
        for r in caplog.records
    )


def test_rows_write_via_shared_writer(tmp_path: Path):
    row = cvf.parse_detail(
        _DETAIL, "https://openaccess.thecvf.com/content/CVPR2025/html/x.html", "CVPR"
    )
    csv_path = cc.write_outputs("cvpr-2025", [row], [], output_root=tmp_path, date="2026-06-28")
    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS
    assert read[0]["venue"] == "CVPR"
    assert read[0]["source"] == "cvf"
    assert read[0]["source_id"] == "x"


def test_collect_is_incomplete_when_one_detail_page_fails():
    """A single dropped detail page is a silently missing accepted paper,
    so the result must not be reported as the authoritative full set."""
    listing_resp = SimpleNamespace(status_code=200, text=_LISTING)
    seen: list[str] = []

    def fake(method, url, **kw):
        if url.endswith("?day=all"):
            return listing_resp
        seen.append(url)
        # Fail only the first detail page; the second parses fine.
        if len(seen) == 1:
            return SimpleNamespace(status_code=500, text="")
        return SimpleNamespace(status_code=200, text=_DETAIL)

    with patch.object(cvf, "request_with_retry", side_effect=fake):
        rows, complete = cvf.collect("CVPR2025", "CVPR", max_workers=1, delay_seconds=0)

    assert len(rows) == 1
    assert complete is False


def test_collect_is_incomplete_when_the_listing_itself_fails():
    with patch.object(cvf, "request_with_retry", return_value=None):
        rows, complete = cvf.collect("CVPR2025", "CVPR", max_workers=2, delay_seconds=0)
    assert rows == []
    assert complete is False


def test_main_writes_nothing_when_the_fetch_is_incomplete(tmp_path, monkeypatch, capsys):
    """Regression test: a partial CVF fetch must not overwrite the day's
    catalog. Mirrors collect_openreview's #388 policy — there is no marker
    in papers_<date>.csv that would let a consumer tell a partial catalog
    from a complete one, so a partial one is never published."""
    wrote: list[object] = []

    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([{"url": "u", "title": "t"}], False))
    monkeypatch.setattr(cvf, "write_outputs", lambda *a, **kw: wrote.append(a) or Path("x"))
    monkeypatch.setattr(
        "sys.argv",
        ["collect_cvf", "--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025"],
    )

    assert cvf.main() == 1
    assert wrote == []
    assert "INCOMPLETE" in capsys.readouterr().out


def test_main_writes_when_the_fetch_is_complete(tmp_path, monkeypatch, capsys):
    wrote: list[object] = []

    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([{"url": "u", "title": "t"}], True))
    monkeypatch.setattr(
        cvf, "write_outputs", lambda *a, **kw: (wrote.append(a), Path("papers.csv"))[1]
    )
    monkeypatch.setattr(
        "sys.argv",
        ["collect_cvf", "--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025"],
    )

    assert cvf.main() == 0
    assert len(wrote) == 1


def test_main_passes_clear_oral_through(tmp_path, monkeypatch) -> None:
    """--clear-oral must reach the shared writer; the default must not clear.

    CVF marks no oral/highlight, so without --oral-arxiv-query this collector always
    writes with an empty oral list. Clearing the published oral list must therefore
    stay an explicit operator choice, never a side effect of a plain re-collection.
    """
    captured: list[dict[str, object]] = []
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([{"url": "u", "title": "t"}], True))
    monkeypatch.setattr(
        cvf, "write_outputs", lambda *a, **kw: captured.append(kw) or Path("papers.csv")
    )
    argv = ["collect_cvf", "--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025"]

    monkeypatch.setattr("sys.argv", argv)
    assert cvf.main() == 0
    monkeypatch.setattr("sys.argv", [*argv, "--clear-oral"])
    assert cvf.main() == 0

    assert [call["clear_oral"] for call in captured] == [False, True]


def _cvf_row():
    url = "https://openaccess.thecvf.com/content/CVPR2025/html/Xiao_Det_paper.html"
    row = cvf.parse_detail(_DETAIL, url, "CVPR")
    assert row is not None
    return row


def _oral_argv(*extra: str) -> list[str]:
    argv = [
        "collect_cvf",
        "--conference",
        "cvpr-2025",
        "--venue",
        "CVPR",
        "--cvf-id",
        "CVPR2025",
        "--oral-arxiv-query",
        'co:"CVPR 2025"',
    ]
    return [*argv, *extra]


def test_main_oral_max_defaults_to_the_overlay_cap(monkeypatch) -> None:
    """--oral-max must widen the very cap the overlay reports hitting.

    A second literal default would let the operator raise one and still trip the
    other, so the collector's default is the overlay's own constant.
    """
    captured: list[tuple] = []
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([_cvf_row()], True))
    monkeypatch.setattr(
        cvf, "write_outputs", lambda *a, **kw: (captured.append(a), Path("papers.csv"))[1]
    )
    monkeypatch.setattr("sys.argv", _oral_argv())
    with patch.object(cc, "fetch_results", return_value=[]) as fetch:
        assert cvf.main() == 0

    assert fetch.call_args.args[1] == cc.ORAL_MAX_RESULTS_DEFAULT
    assert captured[0][2] == []


def test_main_skips_a_truncated_overlay_and_keeps_the_published_oral_md(
    tmp_path, monkeypatch, capsys
) -> None:
    """A full arXiv window must not replace the published oral list with a partial one.

    The overlay is newest-first and bounded, so filling it says nothing about the
    older acceptances. The collector then passes an empty list, which is what
    ``write_outputs`` already treats as "leave oral_summaries_ja.md alone".
    """
    conf_dir = tmp_path / "output" / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n"
    oral_md.write_text(existing, encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([_cvf_row()], True))
    # Exactly --oral-max results: the window is full, so the overlay is incomplete.
    filled = [
        SimpleNamespace(title=f"Oral {i}", comment="Accepted to CVPR 2025 (Oral)")
        for i in range(2)
    ]
    monkeypatch.setattr(cc, "fetch_results", lambda *a, **kw: filled)
    monkeypatch.setattr("sys.argv", _oral_argv("--oral-max", "2"))

    assert cvf.main() == 0
    assert oral_md.read_text(encoding="utf-8") == existing
    today = cc.datetime.now(cc.timezone.utc).strftime("%Y-%m-%d")
    assert (conf_dir / f"papers_{today}.csv").is_file()
    out = capsys.readouterr().out
    assert "oral overlay filled the --oral-max 2 window" in out
    assert "(0 oral via arXiv)" in out


def test_main_overlays_the_oral_md_when_the_window_is_not_full(
    tmp_path, monkeypatch, capsys
) -> None:
    """The other side of the gate: a window that came back short is complete."""
    conf_dir = tmp_path / "output" / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    oral_md.write_text("# old\n## 1. Some Old Oral Title\n", encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([_cvf_row()], True))
    monkeypatch.setattr(
        cc,
        "fetch_results",
        lambda *a, **kw: [
            SimpleNamespace(
                title="Fresh Oral",
                comment="Accepted to CVPR 2025 (Oral)",
                summary="",
                entry_id="https://arxiv.org/abs/2501.00001v1",
                pdf_url="",
                authors=[],
            )
        ],
    )
    monkeypatch.setattr("sys.argv", _oral_argv("--oral-max", "8"))

    assert cvf.main() == 0
    assert "## 1. Fresh Oral" in oral_md.read_text(encoding="utf-8")
    assert "Some Old Oral Title" not in oral_md.read_text(encoding="utf-8")
    assert "(1 oral via arXiv)" in capsys.readouterr().out


def _malformed_feed_fetch(results: list[SimpleNamespace]):
    """A stand-in for ``fetch_results`` that logs the client's malformed-feed warning.

    Mirrors arxiv 4.0.1, which logs and hands back the partial page instead of raising —
    see test_collect_conference.py for the test that pins that against the library.
    """

    def _fetch(*_args: object, **_kwargs: object) -> list[SimpleNamespace]:
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
        )
        return results

    return _fetch


@pytest.mark.parametrize("incomplete", ["window", "malformed"])
def test_main_an_incomplete_overlay_does_not_authorize_clear_oral(
    tmp_path: Path, monkeypatch, capsys, incomplete: str
) -> None:
    """--clear-oral is an operator decision about a KNOWN oral set, nothing else.

    Both incomplete cases hand back no titles, and neither says the venue has no orals:
    the window never reached the older acceptances, the malformed feed dropped entries from
    the middle. Removing the published list on that reading would turn every paper into
    Poster. Each case must also print its own advice, because only one of them is fixed by
    raising --oral-max.
    """
    conf_dir = tmp_path / "output" / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n"
    oral_md.write_text(existing, encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([_cvf_row()], True))
    filled = [
        SimpleNamespace(title=f"Oral {i}", comment="Accepted to CVPR 2025 (Oral)")
        for i in range(2)
    ]
    fetch = _malformed_feed_fetch(filled) if incomplete == "malformed" else lambda *a, **kw: filled
    monkeypatch.setattr(cc, "fetch_results", fetch)
    monkeypatch.setattr("sys.argv", _oral_argv("--oral-max", "2", "--clear-oral"))

    assert cvf.main() == 0
    assert oral_md.read_text(encoding="utf-8") == existing
    out = capsys.readouterr().out
    assert "(0 oral via arXiv)" in out
    if incomplete == "window":
        assert "filled the --oral-max 2 window" in out and "malformed" not in out
    else:
        assert "malformed feed" in out and "filled the --oral-max" not in out


def test_main_clear_oral_still_clears_after_a_complete_but_empty_overlay(
    tmp_path: Path, monkeypatch
) -> None:
    """The gate separates an unknown oral set from an empty one, it is not a refusal.

    A fetch that came back short of the cap and found no arXiv-tagged oral does state
    something about the venue, so --clear-oral keeps removing the file there.
    """
    conf_dir = tmp_path / "output" / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    oral_md.write_text("# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n", encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(cvf, "collect", lambda *a, **kw: ([_cvf_row()], True))
    monkeypatch.setattr(cc, "fetch_results", lambda *a, **kw: [])
    monkeypatch.setattr("sys.argv", _oral_argv("--oral-max", "8", "--clear-oral"))

    assert cvf.main() == 0
    assert not oral_md.exists()
