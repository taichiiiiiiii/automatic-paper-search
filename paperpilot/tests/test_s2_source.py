"""S2Source tests — search flow, date parsing, field mapping (mocked HTTP)."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from paperpilot.sources.s2_source import S2Source


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _item(
    paper_id="pid1",
    title="RAG Paper",
    abstract="Retrieval-Augmented Generation abstract",
    authors=None,
    year=2026,
    pub_date="2026-04-10",
    arxiv_id="2604.01234",
    doi="10.1/abc",
    pdf="http://pdf",
    venue="ICLR",
    url="http://s2/pid1",
):
    return {
        "paperId": paper_id,
        "title": title,
        "abstract": abstract,
        "authors": authors or [{"name": "Alice", "authorId": "AID"}],
        "year": year,
        "publicationDate": pub_date,
        "externalIds": {"ArXiv": arxiv_id, "DOI": doi} if (arxiv_id or doi) else {},
        "openAccessPdf": {"url": pdf} if pdf else {},
        "venue": venue,
        "url": url,
    }


def test_fetch_returns_papers_within_window():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    pub = (today - timedelta(days=3)).isoformat()
    item = _item(pub_date=pub)
    body = {"data": [item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["rag"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    p = papers[0]
    assert p.title == "RAG Paper"
    assert p.arxiv_id == "2604.01234"
    assert p.doi == "10.1/abc"
    assert p.pdf_url == "http://pdf"
    assert p.venue == "ICLR"
    assert p.source == "s2"
    assert p.matched_keywords == ["rag"]
    assert p.authors == ["Alice"]
    assert p.first_author_id == "AID"


def test_first_author_id_absent_when_no_author_has_id():
    """Regression test (closes #393): first_author_id stays None (not KeyError)
    when the authors list has no authorId (e.g. some S2 records omit it)."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    item = _item(
        pub_date=(today - timedelta(days=3)).isoformat(),
        authors=[{"name": "Bob"}],
    )
    body = {"data": [item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["rag"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    assert papers[0].first_author_id is None


def test_first_author_id_uses_first_author_not_any_author_with_id():
    """first_author_id must reflect authors[0] specifically (matching
    CitationSignal's semantics), not just any author that happens to have
    an authorId."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    item = _item(
        pub_date=(today - timedelta(days=3)).isoformat(),
        authors=[{"name": "Bob"}, {"name": "Alice", "authorId": "AID"}],
    )
    body = {"data": [item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["rag"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    assert papers[0].first_author_id is None


def test_fetch_drops_older_than_since_date():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            _item(
                paper_id="old",
                url="http://s2/old",
                pub_date=(today - timedelta(days=30)).isoformat(),
            ),
            _item(
                paper_id="new",
                url="http://s2/new",
                pub_date=(today - timedelta(days=1)).isoformat(),
            ),
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["x"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    assert papers[0].url == "http://s2/new"


def test_fetch_handles_http_failure():
    """Regression test (closes #387): a non-200 response after retries are
    exhausted is a real outage — fetch() must raise so Stage 0 records it
    as sources_status["s2"]["ok"] = False, not silently return [] (which
    would be indistinguishable from "genuinely 0 new papers this run")."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(429),
    ):
        with pytest.raises(RuntimeError, match="s2 fetch failed for all"):
            src.fetch(
                keywords=["x"], categories=[], since_date=date.today(), max_results=10
            )


def test_fetch_handles_none_response():
    """Same as above, for request_with_retry returning None entirely
    (e.g. connection error) rather than an HTTP error response."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.s2_source.request_with_retry", return_value=None
    ):
        with pytest.raises(RuntimeError, match="s2 fetch failed for all"):
            src.fetch(
                keywords=["x"], categories=[], since_date=date.today(), max_results=10
            )


def test_fetch_keeps_partial_results_when_only_some_keywords_fail():
    """Regression test: S2's free tier throttles aggressively, so a single
    keyword hitting a 429 is routine. That must NOT discard the papers the
    other keywords already returned — only a total outage (every keyword
    failing) raises. Mirrors the arxiv (#387) and openalex (#399) contract,
    which this source previously diverged from by raising out of fetch()
    on the very first keyword failure."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    good_body = {
        "data": [
            {
                "paperId": "P1",
                "title": "Good Paper",
                "abstract": "abs",
                "url": "http://s2/good",
                "publicationDate": date.today().isoformat(),
                "authors": [{"authorId": "A1", "name": "Alice"}],
            }
        ]
    }

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("query") == "bad":
            return _resp(429)
        return _resp(200, good_body)

    with patch(
        "paperpilot.sources.s2_source.request_with_retry", side_effect=_fake_request
    ):
        papers = src.fetch(
            keywords=["bad", "good"],
            categories=[],
            since_date=date.today() - timedelta(days=7),
            max_results=10,
        )

    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


def test_parse_pub_date_prefers_publication_date():
    item = _item(pub_date="2026-03-15", year=2020)
    assert S2Source._parse_pub_date(item) == date(2026, 3, 15)


def test_parse_pub_date_falls_back_to_year():
    item = {"year": 2025}
    assert S2Source._parse_pub_date(item) == date(2025, 1, 1)


def test_parse_pub_date_invalid_returns_none():
    assert S2Source._parse_pub_date({}) is None
    assert S2Source._parse_pub_date({"year": "bogus"}) is None
    assert S2Source._parse_pub_date({"publicationDate": "not-a-date"}) is None


def test_to_paper_skips_empty_title():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    item = _item(title="")
    out = src._to_paper(item, "kw", since_date=date.today() - timedelta(days=30))
    assert out is None


def test_to_paper_skips_when_pub_before_since():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    item = _item(pub_date=(today - timedelta(days=30)).isoformat())
    out = src._to_paper(item, "kw", since_date=today - timedelta(days=7))
    assert out is None


def test_api_key_sent_in_headers():
    src = S2Source({"enabled": True, "delay_seconds": 0}, api_key="my_key")
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, {"data": []}),
    ) as mock:
        src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)
    headers = mock.call_args.kwargs["headers"]
    assert headers.get("x-api-key") == "my_key"


def test_no_api_key_header_when_unset():
    src = S2Source({"enabled": True, "delay_seconds": 0}, api_key=None)
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, {"data": []}),
    ) as mock:
        src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)
    headers = mock.call_args.kwargs["headers"]
    assert "x-api-key" not in headers


def test_fallback_url_when_item_has_none():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    item = _item(url=None, pub_date=today.isoformat())
    del item["url"]
    p = src._to_paper(item, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert "semanticscholar.org" in p.url
