"""Paper dataclass roundtrip tests."""

from __future__ import annotations

from datetime import date

from paperpilot.models import Paper


def test_uid_prefers_arxiv_id():
    p = Paper(
        title="t", authors=[], abstract="", url="u",
        published_date=date.today(), source="arxiv",
        arxiv_id="2604.001", doi="10.1000/x",
    )
    assert p.uid == "arxiv:2604.001"


def test_uid_falls_back_to_doi():
    p = Paper(
        title="t", authors=[], abstract="", url="u",
        published_date=date.today(), source="s2",
        doi="10.1000/x",
    )
    assert p.uid == "doi:10.1000/x"


def test_uid_falls_back_to_url():
    p = Paper(
        title="t", authors=[], abstract="", url="http://x/1",
        published_date=date.today(), source="openalex",
    )
    assert p.uid == "url:http://x/1"


def test_to_dict_roundtrip():
    p = Paper(
        title="Hello",
        authors=["A", "B"],
        abstract="Abs",
        url="http://x",
        published_date=date(2026, 3, 15),
        source="arxiv",
        arxiv_id="2603.1",
        categories=["cs.LG"],
    )
    d = p.to_dict()
    assert d["published_date"] == "2026-03-15"
    assert d["uid"] == "arxiv:2603.1"
    back = Paper.from_dict(d)
    assert back.title == p.title
    assert back.published_date == p.published_date
    assert back.categories == p.categories
