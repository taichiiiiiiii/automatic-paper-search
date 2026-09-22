"""OpenAlex source tests — `/works` endpoint, polite-pool email, parsing."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

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


def test_fetch_raises_when_every_keyword_fails():
    """Regression test (closes #399): if EVERY keyword's HTTP request
    fails, this is an outage — fetch() must raise so Stage 0 records
    sources_status["openalex"]["ok"] = False, not silently return []
    (which would be indistinguishable from "genuinely 0 new papers this
    run"). Mirrors the arxiv/S2 fix in #387."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(500),
    ):
        with pytest.raises(RuntimeError, match="openalex fetch failed for all"):
            src.fetch(keywords=["x"], categories=[], since_date=date.today(), max_results=5)


def test_fetch_keeps_partial_results_when_only_some_keywords_fail_via_http():
    """A per-keyword HTTP failure alongside at least one success is NOT an
    outage worth failing the whole source over — the successful keyword's
    real papers must still be returned, not discarded."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat())

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("search") == "bad":
            return _resp(500)
        return _resp(200, {"results": [good_work]})

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        side_effect=_fake_request,
    ):
        papers = src.fetch(["bad", "good"], [], today - timedelta(days=7), 10)

    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


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


def test_abstract_inverted_index_negative_position_discards_whole_abstract():
    """Regression test (closes #398): a malformed negative position must
    not raise. It degrades the ENTIRE abstract to "" (not a partial
    abstract with just that token dropped) — a silently incomplete
    abstract is riskier than an explicit "no abstract" state, since
    downstream keyword/exclusion/embedding/LLM stages treat the abstract
    as authoritative text."""
    inverted = {"Fast": [0], "corrupt": [-1], "reliable": [1]}
    out = OpenAlexSource._rehydrate_abstract(inverted)
    assert out == ""


def test_abstract_inverted_index_non_integer_position_discards_whole_abstract():
    """A string/float position (e.g. upstream sends "0" or 0.5) must be
    rejected rather than crashing sorted() with mixed types."""
    inverted = {"Fast": [0], "bad_str": ["1"], "reliable": [1]}
    assert OpenAlexSource._rehydrate_abstract(inverted) == ""
    inverted2 = {"Fast": [0], "bad_float": [2.5], "reliable": [1]}
    assert OpenAlexSource._rehydrate_abstract(inverted2) == ""


def test_abstract_inverted_index_bool_position_discards_whole_abstract():
    """bool is a subclass of int in Python; a boolean position is still
    nonsensical and must be rejected explicitly."""
    inverted = {"Fast": [0], "boolean": [True]}
    assert OpenAlexSource._rehydrate_abstract(inverted) == ""


def test_abstract_inverted_index_non_list_positions_discards_whole_abstract():
    """A token whose positions value isn't a list at all (e.g. a single
    int, or a dict) must be rejected, not crash the `for idx in indices`
    iteration or raise a confusing TypeError."""
    inverted = {"Fast": [0], "malformed": 5}
    assert OpenAlexSource._rehydrate_abstract(inverted) == ""


def test_abstract_inverted_index_non_string_token_discards_whole_abstract():
    """A non-string token key (structurally impossible from real JSON, but
    defensive against a malformed Python dict passed directly) must be
    rejected rather than crashing the final `" ".join(...)` on a
    non-string element."""
    inverted = {"Fast": [0], 123: [1]}
    assert OpenAlexSource._rehydrate_abstract(inverted) == ""


def test_abstract_inverted_index_wrong_top_level_type_returns_empty():
    """A non-dict abstract_inverted_index (list/string/int) must not raise
    when passed through the isinstance guard."""
    assert OpenAlexSource._rehydrate_abstract([1, 2, 3]) == ""
    assert OpenAlexSource._rehydrate_abstract("not-a-dict") == ""
    assert OpenAlexSource._rehydrate_abstract(123) == ""


def test_to_paper_survives_malformed_abstract_inverted_index():
    """End-to-end (closes #398): a work item with a malformed abstract
    inverted index must still produce a Paper (title/other fields intact,
    abstract cleared to ""), not raise and abort the whole batch."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = {
        "id": "https://openalex.org/W1",
        "title": "A Paper With Bad Abstract Data",
        "publication_date": today.isoformat(),
        "abstract_inverted_index": {"ok": [0], "bad": ["not-an-int"]},
        "authorships": [],
    }
    paper = src._to_paper(work, "kw", today - timedelta(days=1))
    assert paper is not None
    assert paper.title == "A Paper With Bad Abstract Data"
    assert paper.abstract == ""


def test_search_skips_malformed_work_item_and_keeps_valid_siblings():
    """Regression test (closes #398 follow-up): a malformed work item
    anywhere in the results list (not just a bad abstract index — any
    unexpected shape) must not abort processing of the other, valid work
    items in the same response."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = {
        "id": "https://openalex.org/W1",
        "title": "Good Paper",
        "publication_date": today.isoformat(),
        "authorships": [],
    }
    malformed_work = {
        "id": "https://openalex.org/W2",
        "title": 12345,  # .strip() on an int raises AttributeError
        "publication_date": today.isoformat(),
        "authorships": [],
    }
    body = {"results": [malformed_work, good_work]}
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src._search("kw", today - timedelta(days=7), 10)
    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


def test_fetch_continues_to_next_keyword_after_search_failure(monkeypatch):
    """Regression test (closes #398 follow-up): an unexpected exception
    while processing one keyword's results must not prevent later
    keywords in the same fetch() call from being processed."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})

    calls: list[str] = []

    def _fake_search(keyword, since_date, max_results):
        calls.append(keyword)
        if keyword == "bad":
            raise RuntimeError("boom")
        return []

    monkeypatch.setattr(src, "_search", _fake_search)
    papers = src.fetch(["bad", "good"], [], date.today() - timedelta(days=7), 10)
    assert papers == []
    assert calls == ["bad", "good"]


def test_fetch_survives_real_search_raising_for_one_keyword_via_http():
    """Stronger integration test (closes #398 follow-up): unlike the test
    above (which replaces _search() entirely), this exercises the REAL
    _search()/HTTP-response path for both keywords — one keyword's
    response is malformed at the response-body level (a list instead of a
    dict, so `data.get("results")` itself raises inside _search, not just
    a per-work-item issue), the other keyword's response is a normal valid
    payload. The good keyword's real paper must still survive."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W999", title="Good Paper", pub_date=today.isoformat())

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("search") == "bad":
            # Malformed at the response-body level: a list, not a dict —
            # `data.get("results")` raises AttributeError inside _search.
            return _resp(200, [1, 2, 3])
        return _resp(200, {"results": [good_work]})

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        side_effect=_fake_request,
    ):
        papers = src.fetch(["bad", "good"], [], today - timedelta(days=7), 10)

    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


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
