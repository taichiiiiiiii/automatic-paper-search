"""OpenAlex source tests — `/works` endpoint, polite-pool email, parsing."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.sources.openalex_source import OpenAlexSource


def _resp(status: int, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _openalex_work(
    work_id="W123",
    title="Sample Work",
    abstract_inverted=None,
    pub_date="2026-04-10",
    doi="10.1/xyz",
    concepts=("artificial intelligence", "language model"),
    authors=("Alice", "Bob"),
    venue="ICLR",
    pdf="http://pdf",
):
    return {
        "id": f"https://openalex.org/{work_id}",
        "title": title,
        "display_name": title,
        "abstract_inverted_index": abstract_inverted
        or {"We": [0], "propose": [1], "a": [2], "new": [3], "method": [4]},
        "publication_date": pub_date,
        "publication_year": int(pub_date.split("-")[0]) if pub_date else None,
        "doi": f"https://doi.org/{doi}" if doi else None,
        "ids": {"doi": f"https://doi.org/{doi}" if doi else None},
        "authorships": [
            {
                "author": {"display_name": a, "id": f"https://openalex.org/A{i}"},
                "institutions": [{"display_name": "Test University"}],
            }
            for i, a in enumerate(authors)
        ],
        "host_venue": {"display_name": venue} if venue else {},
        "open_access": {"oa_url": pdf} if pdf else {},
        "concepts": [{"display_name": c, "level": 1} for c in concepts],
    }


def test_fetch_happy_path():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=(today - timedelta(days=2)).isoformat())
    body = {"results": [work]}
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["language model"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    p = papers[0]
    assert p.title == "Sample Work"
    assert p.source == "openalex"
    assert p.doi == "10.1/xyz"
    assert p.pdf_url == "http://pdf"
    assert p.venue == "ICLR"
    assert p.authors == ["Alice", "Bob"]
    assert p.matched_keywords == ["language model"]
    # Abstract rehydrated from inverted index preserves word order.
    assert p.abstract == "We propose a new method"


def test_fetch_drops_before_since_date():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            _openalex_work(work_id="old", pub_date=(today - timedelta(days=60)).isoformat()),
            _openalex_work(work_id="new", pub_date=(today - timedelta(days=1)).isoformat()),
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["x"], categories=[], since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert len(papers) == 1
    assert "new" in papers[0].url


def test_fetch_http_failure_returns_empty():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(500),
    ):
        papers = src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)
    assert papers == []


def test_polite_pool_email_added_to_mailto():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0}, email="me@example.com")
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, {"results": []}),
    ) as mock:
        src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)
    params = mock.call_args.kwargs["params"]
    assert params.get("mailto") == "me@example.com"


def test_no_email_omits_mailto():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0}, email=None)
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, {"results": []}),
    ) as mock:
        src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)
    params = mock.call_args.kwargs["params"]
    assert "mailto" not in params


def test_abstract_inverted_index_empty_abstract():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    assert src._rehydrate_abstract(None) == ""
    assert src._rehydrate_abstract({}) == ""


def test_abstract_inverted_index_preserves_word_order():
    # "Hello world hello" -> {"Hello": [0, 2], "world": [1]} -> but that's one word "hello" at positions 0 and 2 after casefold
    # The OpenAlex format uses the original token casing; we just re-order by position.
    inverted = {"Fast": [0, 3], "and": [1], "reliable": [2]}
    out = OpenAlexSource._rehydrate_abstract(inverted)
    assert out == "Fast and reliable Fast"


def test_parse_pub_date_fallback_to_year():
    work = {"publication_date": None, "publication_year": 2024}
    assert OpenAlexSource._parse_pub_date(work) == date(2024, 1, 1)


def test_parse_pub_date_invalid():
    assert OpenAlexSource._parse_pub_date({}) is None
    assert OpenAlexSource._parse_pub_date({"publication_date": "garbage"}) is None


def test_to_paper_skips_empty_title():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(title="", pub_date=today.isoformat())
    work["display_name"] = ""
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is None


def test_doi_normalized_without_prefix():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat(), doi="10.1/abc")
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert p.doi == "10.1/abc"  # 'https://doi.org/' prefix stripped


def test_venue_prefers_primary_location_over_host_venue():
    """OpenAlex v2: primary_location.source.display_name is the canonical field."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat(), venue="LEGACY_VENUE")
    # Inject both: new-style primary_location (should win) + legacy host_venue
    work["primary_location"] = {"source": {"display_name": "Nature"}}
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert p.venue == "Nature"


def test_venue_falls_back_to_host_venue_when_primary_missing():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat(), venue="ICLR")
    # primary_location returns null (actual live-API default)
    work["primary_location"] = None
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert p.venue == "ICLR"


def test_affiliations_flattened_from_authorships():
    """OpenAlex authorships each carry institutions; we flatten + dedup."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat(), authors=("Alice", "Bob"))
    # Override with a richer institutions shape (Alice at Meta+OpenAI, Bob at Meta)
    work["authorships"] = [
        {
            "author": {"display_name": "Alice", "id": "A1"},
            "institutions": [
                {"display_name": "Meta AI Research"},
                {"display_name": "OpenAI"},
            ],
        },
        {
            "author": {"display_name": "Bob", "id": "A2"},
            "institutions": [{"display_name": "Meta AI Research"}],
        },
    ]
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    # Deduped: Meta AI Research only appears once; order follows first-seen.
    assert p.affiliations == ["Meta AI Research", "OpenAI"]


def test_affiliations_empty_when_institutions_missing():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat())
    work["authorships"] = [{"author": {"display_name": "Alice"}}]  # no institutions
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert p.affiliations == []


def test_venue_none_when_both_missing():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=today.isoformat(), venue=None)
    work["primary_location"] = None
    p = src._to_paper(work, "kw", since_date=today - timedelta(days=7))
    assert p is not None
    assert p.venue is None
