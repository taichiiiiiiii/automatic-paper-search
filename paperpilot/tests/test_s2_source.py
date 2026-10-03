"""S2Source tests — search flow, date parsing, field mapping (mocked HTTP)."""

from __future__ import annotations

import logging
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


def test_search_bounds_the_window_server_side(caplog):
    """Regression test: /paper/search ranks by RELEVANCE, not recency.

    Basis for the bound: the Semantic Scholar Graph API documents the
    `publicationDateOrYear` filter on the relevance search endpoint
    (`/graph/v1/paper/search`), which restricts the ranked pool to a date range —
    an open-ended `<since>:` value therefore means "rank only what was published
    from the window's start on".

    With no date bound the endpoint ranks every matching paper S2 has ever
    indexed, so an old high-relevance hit takes one of the `limit` slots, the
    client-side `since_date` filter drops it, and the source returns 0 papers on
    every run. The open-ended `publicationDateOrYear=<since>:` range restricts the
    ranked pool to the window instead.

    The same test pins M-6's half of the contract: the endpoint answers one page,
    so a keyword that took all `limit` items still has matches inside the window
    that were never fetched, and the run has to report that keyword as truncated.
    """
    src = S2Source({"enabled": True, "delay_seconds": 0})
    since = date.today() - timedelta(days=7)
    recent = (date.today() - timedelta(days=1)).isoformat()
    # Exactly `limit` items for max_results=10, i.e. a full page.
    body = {"data": [_item(paper_id=f"p{i}", pub_date=recent) for i in range(10)]}
    with caplog.at_level(logging.WARNING):
        with patch(
            "paperpilot.sources.s2_source.request_with_retry",
            return_value=_resp(200, body),
        ) as mock:
            papers = src.fetch(
                keywords=["rag"], categories=[], since_date=since, max_results=10
            )

    params = mock.call_args.kwargs["params"]
    assert params["publicationDateOrYear"] == f"{since.isoformat()}:"
    assert params["limit"] == 10
    assert len(papers) == 10
    assert src.truncated_keywords == ["rag"]
    assert "rag" in caplog.text


def test_a_page_with_room_left_is_not_reported_as_truncated():
    """Fewer items than the requested limit means the endpoint had nothing more
    inside the window — a complete answer, not a cut one."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {"data": [_item(paper_id="p0", pub_date=today.isoformat())]}
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
    assert src.truncated_keywords == []


def test_truncated_keywords_reset_between_fetches():
    """A stale report would make the next run claim a window it never filled."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    pub = (today - timedelta(days=1)).isoformat()
    full_page = {"data": [_item(paper_id=f"p{i}", pub_date=pub) for i in range(2)]}

    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, full_page),
    ):
        src.fetch(
            keywords=["rag"], categories=[], since_date=today - timedelta(days=7),
            max_results=2,
        )
    assert src.truncated_keywords == ["rag"]

    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, {"data": []}),
    ):
        src.fetch(
            keywords=["rag"], categories=[], since_date=today - timedelta(days=7),
            max_results=2,
        )
    assert src.truncated_keywords == []


def test_window_bound_tracks_since_date_per_run():
    """The bound comes from the caller's window, not a fixed year — a stale or
    hard-coded value would silently widen or narrow every run."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    since = date(2026, 1, 5)
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, {"data": []}),
    ) as mock:
        src.fetch(keywords=["rag"], categories=[], since_date=since, max_results=10)

    assert mock.call_args.kwargs["params"]["publicationDateOrYear"] == "2026-01-05:"


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
    # HIGH-1: the surviving papers must not make the lost keyword invisible. Stage 0
    # records ok=True for this fetch, so `degraded_keywords` is the only channel that
    # tells PipelineRunner to write `source:s2: incomplete keyword 'bad' ...` — the
    # error --fail-on-errors and run_history actually read.
    assert src.degraded_keywords == [
        ("bad", "RuntimeError: s2 search failed for 'bad' (status=429)")
    ]


def test_body_without_the_data_list_is_a_failed_keyword():
    """Regression (M-2): `data.get("data") or []` read a 200 whose body lost the item
    list as a successful 0-paper keyword, so an endpoint that changed its response
    shape looked exactly like a quiet day in run_history.

    A body this code cannot read is an answer the run does not have, so the keyword
    fails; with the only keyword failing, fetch() raises so Stage 0 records
    sources_status["s2"]["ok"] = False.
    """
    src = S2Source({"enabled": True, "delay_seconds": 0})

    for body in ({"total": 0, "token": "x"}, [1, 2, 3], "an error string", {}):
        with patch(
            "paperpilot.sources.s2_source.request_with_retry",
            return_value=_resp(200, body),
        ):
            with pytest.raises(RuntimeError, match="s2 fetch failed for all"):
                src.fetch(
                    keywords=["x"],
                    categories=[],
                    since_date=date.today(),
                    max_results=10,
                )


def test_unreadable_body_fails_only_its_own_keyword():
    """The strictness must not convert one changed response into a whole-source loss:
    the unreadable keyword is dropped, the other keyword's real papers still ship —
    the same partial-success contract as a 429."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_body = {
        "data": [_item(paper_id="P1", title="Good Paper", pub_date=today.isoformat())]
    }

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("query") == "bad":
            return _resp(200, {"code": "unavailable", "message": "try later"})
        return _resp(200, good_body)

    with patch(
        "paperpilot.sources.s2_source.request_with_retry", side_effect=_fake_request
    ):
        papers = src.fetch(
            keywords=["bad", "good"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )

    assert [p.title for p in papers] == ["Good Paper"]
    assert src.truncated_keywords == []
    # The response-shape loss is reported like any other keyword failure: a 200 this
    # code could not read is a keyword the run never got an answer for.
    assert [kw for kw, _reason in src.degraded_keywords] == ["bad"]
    assert "no 'data' list" in src.degraded_keywords[0][1]


def test_degraded_keywords_reset_between_fetches():
    """HIGH-1's other half: the report is per fetch, not per process. A stale entry
    would make the next clean run carry `source:s2: incomplete keyword ...`, which
    --fail-on-errors refuses, so a recovered throttle would fail a complete survey."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_body = {
        "data": [_item(paper_id="P1", title="Good Paper", pub_date=today.isoformat())]
    }

    def _one_bad_keyword(method, url, params=None, **kw):
        if params and params.get("query") == "bad":
            return _resp(429)
        return _resp(200, good_body)

    with patch(
        "paperpilot.sources.s2_source.request_with_retry", side_effect=_one_bad_keyword
    ):
        src.fetch(
            keywords=["bad", "good"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert [kw for kw, _reason in src.degraded_keywords] == ["bad"]

    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, good_body),
    ):
        src.fetch(
            keywords=["good"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert src.degraded_keywords == []


def test_search_skips_malformed_s2_item_and_keeps_valid_siblings():
    """S2 equivalent of OpenAlexSource's item-level fail-safe (H-2): a malformed
    item anywhere in `data` must not abort the other, valid items in the same
    response, and the loss must reach `unreadable` instead of being silent."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_item = _item(paper_id="P1", title="Good Paper", pub_date=today.isoformat())
    malformed_item = {
        "paperId": "P2",
        "title": 12345,  # .strip() on an int raises AttributeError
        "publicationDate": today.isoformat(),
        "authors": [],
    }
    body = {"data": [malformed_item, good_item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        # max_results=2 makes limit=2, matching len(results)==2: the raw page IS
        # full by count, so page_is_full being False below is evidence the dropped
        # item is what decided it, not a short raw page (same fix as the
        # OpenAlexSource test this mirrors).
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert len(papers) == 1
    assert papers[0].title == "Good Paper"
    assert unreadable == "1 of 2 papers unreadable"
    assert page_is_full is False


def test_search_records_a_fully_dropped_page_as_unreadable_not_truncated():
    """A page whose every item was unreadable must not read as a window that
    simply ran out of papers (same contract as OpenAlexSource._search)."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            {
                "paperId": f"P{i}",
                "title": 12345,  # .strip() on an int raises AttributeError
                "publicationDate": today.isoformat(),
                "authors": [],
            }
            for i in range(2)
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert papers == []
    assert page_is_full is False
    assert unreadable == "2 of 2 papers unreadable"


def test_fetch_reports_dropped_items_as_an_incomplete_keyword():
    """H-2 through fetch(): the surviving keyword papers still ship, the lost
    items are named on the same channel a failed keyword uses, and the keyword is
    not also reported as a truncated window."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            _item(paper_id="P1", title="Good Paper", pub_date=today.isoformat()),
            {
                "paperId": "P2",
                "title": 12345,
                "publicationDate": today.isoformat(),
                "authors": [],
            },
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["kw"],
            categories=[],
            since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert [p.title for p in papers] == ["Good Paper"]
    assert src.truncated_keywords == []
    assert src.degraded_keywords == [("kw", "1 of 2 papers unreadable")]


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


# ---- D-1: skipped (data-quality) records vs. dropped (shape-error) records ----


def test_a_single_blank_title_record_beside_a_good_one_does_not_degrade_the_keyword():
    """D-1: a lone upstream data-quality artifact (blank title) must not turn an
    otherwise-healthy page red. It is logged and counted as `skipped`, not
    `dropped`, and the keyword stays clean as long as something else on the page
    was usable."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_item = _item(paper_id="P1", title="Good Paper", pub_date=today.isoformat())
    blank_title_item = _item(paper_id="P2", title="", pub_date=today.isoformat())
    body = {"data": [good_item, blank_title_item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert [p.title for p in papers] == ["Good Paper"]
    assert unreadable is None
    # A full raw page still means more results exist, D-1's skipped items don't
    # change that.
    assert page_is_full is True


def test_fetch_does_not_degrade_a_keyword_for_a_single_skipped_record(caplog):
    """End-to-end through fetch(): the skip is logged (visible to an operator)
    but must not land in `degraded_keywords`, unlike a genuine shape error."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_item = _item(paper_id="P1", title="Good Paper", pub_date=today.isoformat())
    unparseable_date_item = _item(paper_id="P2", pub_date=None, year=None)
    body = {"data": [good_item, unparseable_date_item]}
    with caplog.at_level(logging.WARNING):
        with patch(
            "paperpilot.sources.s2_source.request_with_retry",
            return_value=_resp(200, body),
        ):
            papers = src.fetch(
                keywords=["rag"], categories=[], since_date=today - timedelta(days=7),
                max_results=10,
            )
    assert [p.title for p in papers] == ["Good Paper"]
    assert src.degraded_keywords == []
    assert "skipping unusable paper item" in caplog.text


def test_search_records_a_fully_skipped_page_as_unreadable():
    """When EVERY item on a non-empty page is a data-quality skip (not a single
    shape error in sight), that is itself a shape change (e.g. a renamed field)
    the run must still be told about — the keyword degrades."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            {
                "paperId": f"P{i}",
                "title": "",
                "publicationDate": today.isoformat(),
                "authors": [],
            }
            for i in range(2)
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert papers == []
    assert unreadable == "2 of 2 papers skipped (blank title or unparseable date); no paper survived this page"
    # Skipped-only: a full raw page still means more results exist (D-1).
    assert page_is_full is True


def test_fetch_reports_a_fully_skipped_page_as_a_degraded_keyword():
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            {
                "paperId": "P1",
                "title": "",
                "publicationDate": today.isoformat(),
                "authors": [],
            }
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["rag"], categories=[], since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert papers == []
    assert src.degraded_keywords == [
        ("rag", "1 of 1 papers skipped (blank title or unparseable date); no paper survived this page")
    ]


def test_dropped_takes_priority_in_the_unreadable_message_when_mixed_with_skipped():
    """A genuine shape error (dropped) alongside a data-quality skip must still
    degrade via the `dropped` path, with the skip count folded into the same
    message rather than silently discarded."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "data": [
            _item(paper_id="good", title="Good Paper", pub_date=today.isoformat()),
            {"paperId": "P2", "title": "", "publicationDate": today.isoformat(), "authors": []},
            {
                "paperId": "P3",
                "title": 12345,  # .strip() on an int raises AttributeError: dropped
                "publicationDate": today.isoformat(),
                "authors": [],
            },
        ]
    }
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 3)
    assert [p.title for p in papers] == ["Good Paper"]
    assert unreadable == "1 of 3 papers unreadable (1 further skipped: blank title/unparseable date)"
    assert page_is_full is False


def test_a_date_filtered_item_beside_a_skipped_item_still_degrades_the_keyword():
    """MEDIUM-1: a page with ZERO surviving papers must degrade even when one of
    its items was only a legitimate date-window exclusion rather than a second
    skip — comparing `unusable` to `total` (the old rule) wrongly counted that
    date-filtered item toward "every item was unusable" and let this page read as
    clean (`unreadable=None`) purely because the denominator was inflated by an
    item that isn't unusable at all."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    since = today - timedelta(days=7)
    old_item = _item(
        paper_id="old", title="Old Paper", pub_date=None, year=(since.year - 1)
    )
    blank_title_item = _item(paper_id="blank", title="  ", pub_date=today.isoformat())
    body = {"data": [old_item, blank_title_item]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, _page_is_full, unreadable = src._search("kw", since, 2)
    assert papers == []
    assert unreadable == (
        "1 of 2 papers skipped (blank title or unparseable date); "
        "no paper survived this page"
    )

    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        fetched = src.fetch(
            keywords=["rag"], categories=[], since_date=since, max_results=10
        )
    assert fetched == []
    assert src.degraded_keywords == [
        (
            "rag",
            "1 of 2 papers skipped (blank title or unparseable date); "
            "no paper survived this page",
        )
    ]


def test_an_all_date_filtered_page_with_no_unusable_items_stays_clean():
    """The counterpart: a page where every item is a legitimate date-window
    exclusion and NOTHING was skipped/dropped must stay clean — zero papers
    surviving is not itself evidence of a lost page."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    since = today - timedelta(days=7)
    old_item_1 = _item(
        paper_id="old1", title="Old Paper 1", pub_date=None, year=(since.year - 1)
    )
    old_item_2 = _item(
        paper_id="old2", title="Old Paper 2", pub_date=None, year=(since.year - 2)
    )
    body = {"data": [old_item_1, old_item_2]}
    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, _page_is_full, unreadable = src._search("kw", since, 2)
    assert papers == []
    assert unreadable is None

    with patch(
        "paperpilot.sources.s2_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        fetched = src.fetch(
            keywords=["rag"], categories=[], since_date=since, max_results=10
        )
    assert fetched == []
    assert src.degraded_keywords == []


def test_to_paper_raises_on_empty_title():
    """A blank title is an unreadable record, not a legitimate filter: it must
    RAISE (``_UnusableRecordError``, a ``ValueError`` subclass — D-1) rather than
    return ``None``, which would be indistinguishable from "filtered out by
    date". `_search` catches this specific exception separately from a generic
    shape error and counts it as `skipped`, not `dropped` — a single blank title
    is upstream data-quality noise, and does not degrade the keyword on its own
    unless every item on the page was equally unusable (see
    `test_a_single_blank_title_record_beside_a_good_one_does_not_degrade_the_keyword`
    and `test_search_records_a_fully_skipped_page_as_unreadable`). Same contract
    as OpenAlexSource._to_paper."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    today = date.today()
    item = _item(title="", pub_date=today.isoformat())
    with pytest.raises(ValueError, match="no title"):
        src._to_paper(item, "kw", since_date=today - timedelta(days=30))


def test_to_paper_raises_when_date_unparseable():
    """No parseable publication date is also an unreadable record, not a
    legitimate date-window exclusion — it must RAISE (``_UnusableRecordError``,
    D-1), not return ``None``, so it is counted as `skipped` (upstream
    data-quality noise) rather than silently filtered or conflated with a
    genuine shape error."""
    src = S2Source({"enabled": True, "delay_seconds": 0})
    item = _item(pub_date=None, year=None)
    with pytest.raises(ValueError, match="no parseable publication date"):
        src._to_paper(item, "kw", since_date=date.today() - timedelta(days=30))


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
