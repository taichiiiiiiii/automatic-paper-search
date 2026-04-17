"""ArxivSource tests — query building, parsing, fetch loop (mocked)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.sources.arxiv_source import ArxivSource


def test_build_query_single_word():
    q = ArxivSource._build_query("transformer", "cat:cs.LG")
    assert q == "(all:transformer) AND (cat:cs.LG)"


def test_build_query_multi_word_is_quoted():
    q = ArxivSource._build_query("large language model", "cat:cs.AI OR cat:cs.CL")
    assert q == '(all:"large language model") AND (cat:cs.AI OR cat:cs.CL)'


def test_build_query_without_categories():
    q = ArxivSource._build_query("gpt", "")
    assert q == "all:gpt"


def test_build_category_clause():
    assert ArxivSource._build_category_clause(["cs.LG", "cs.AI"]) == "cat:cs.LG OR cat:cs.AI"
    assert ArxivSource._build_category_clause([]) == ""


def test_to_date_handles_naive_datetime():
    dt = datetime(2026, 3, 10, 5, 30)  # naive
    d = ArxivSource._to_date(dt)
    assert d == date(2026, 3, 10)


def test_to_date_handles_tz_aware():
    dt = datetime(2026, 3, 10, 23, 0, tzinfo=timezone.utc)
    d = ArxivSource._to_date(dt)
    assert d == date(2026, 3, 10)


def _fake_arxiv_result(
    title="Attention Is All You Need",
    summary="We propose the Transformer.",
    authors=None,
    entry_id="http://arxiv.org/abs/1706.03762v5",
    published=None,
    categories=None,
    comment="Accepted at NeurIPS 2017",
    doi="10.1234/abc",
    pdf_url="http://arxiv.org/pdf/1706.03762v5",
    short_id="1706.03762v5",
):
    return SimpleNamespace(
        title=title,
        summary=summary,
        authors=[SimpleNamespace(name=n) for n in (authors or ["Vaswani", "Shazeer"])],
        entry_id=entry_id,
        published=published or datetime(2026, 4, 10, tzinfo=timezone.utc),
        categories=categories or ["cs.CL", "cs.LG"],
        comment=comment,
        doi=doi,
        pdf_url=pdf_url,
        get_short_id=lambda: short_id,
    )


def test_to_paper_maps_all_fields():
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    result = _fake_arxiv_result()
    paper = src._to_paper(result, matched_kw="transformer")

    assert paper.title == "Attention Is All You Need"
    assert paper.arxiv_id == "1706.03762"  # version stripped
    assert paper.source == "arxiv"
    assert paper.authors == ["Vaswani", "Shazeer"]
    assert "Transformer" in paper.abstract
    assert paper.pdf_url == "http://arxiv.org/pdf/1706.03762v5"
    assert paper.doi == "10.1234/abc"
    assert paper.comment == "Accepted at NeurIPS 2017"
    assert paper.categories == ["cs.CL", "cs.LG"]
    assert paper.matched_keywords == ["transformer"]


def test_fetch_stops_when_before_since_date():
    """Results are sorted DESC; once we see a paper older than since_date,
    the loop should break early (spec §4.1)."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    since = date(2026, 4, 10)

    new_paper = _fake_arxiv_result(
        entry_id="http://arxiv.org/abs/2604.01",
        published=datetime(2026, 4, 14, tzinfo=timezone.utc),
        short_id="2604.01v1",
    )
    old_paper = _fake_arxiv_result(
        entry_id="http://arxiv.org/abs/2601.01",
        published=datetime(2026, 1, 1, tzinfo=timezone.utc),
        short_id="2601.01v1",
    )

    with patch.object(src._client, "results", return_value=iter([new_paper, old_paper])):
        papers = src.fetch(
            keywords=["transformer"],
            categories=["cs.LG"],
            since_date=since,  # only 4/14 paper qualifies
            max_results=10,
        )

    assert len(papers) == 1
    assert papers[0].arxiv_id == "2604.01"


def test_fetch_catches_client_exception():
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def _boom(*args, **kwargs):
        raise RuntimeError("arxiv client exploded")

    with patch.object(src._client, "results", side_effect=_boom):
        papers = src.fetch(
            keywords=["x"], categories=[], since_date=date.today(), max_results=5
        )
    assert papers == []  # Fail-Safe: empty list, no raise
