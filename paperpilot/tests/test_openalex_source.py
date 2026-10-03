"""OpenAlex source tests — `/works` endpoint, polite-pool email, parsing."""

from __future__ import annotations

import logging
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
    # HIGH-1: the surviving works must not make the lost keyword invisible. Stage 0
    # records ok=True for this fetch, so `degraded_keywords` is the only channel that
    # tells PipelineRunner to write `source:openalex: incomplete keyword 'bad' ...` —
    # the error --fail-on-errors and run_history actually read.
    assert src.degraded_keywords == [
        ("bad", "RuntimeError: openalex search failed for 'bad' (status=500)")
    ]


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
    items in the same response.

    Skipping is not answering, though (H-1): the keyword keeps the works it
    could read AND says how many it could not, so the loss reaches
    `degraded_keywords` instead of being one WARNING line in a log nobody reads.
    """
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
        # max_results=2 makes per_page=2, matching len(results)==2: the raw page IS
        # full by count, so page_is_full is False here ONLY because of the dropped
        # item, not because the page happened to come back short too (that was
        # untested before — with max_results=10 this assertion could not fail).
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert len(papers) == 1
    assert papers[0].title == "Good Paper"
    assert unreadable == "1 of 2 works unreadable"
    # A page that filled out by raw count is still not a cut window once one of
    # its items was unreadable.
    assert page_is_full is False


def test_search_records_a_fully_dropped_page_as_unreadable_not_truncated():
    """H-1: a page whose every work item was unreadable returned [] and raised
    nothing, so the keyword read as a clean 0 — and, because the raw item count
    filled the requested page, as a window that simply ran out of papers.

    The count that decides truncation is of works the endpoint handed over, not of
    works this code could read, so a fully-dropped page has to be degraded rather
    than truncated: "raise max_results" would not have recovered anything, while
    the works lost here are exactly what the run is missing.
    """
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            {
                "id": f"https://openalex.org/W{i}",
                "title": 12345,  # .strip() on an int raises AttributeError
                "publication_date": today.isoformat(),
                "authorships": [],
            }
            for i in range(2)
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)

    assert papers == []
    assert page_is_full is False
    assert unreadable == "2 of 2 works unreadable"


def test_fetch_reports_dropped_works_as_an_incomplete_keyword():
    """H-1 through fetch(): the surviving keyword papers still ship, the lost
    works are named on the same channel a failed keyword uses, and the keyword is
    not also reported as a truncated window.

    Stage 0 records ok=True for this fetch (the source did answer), so
    `degraded_keywords` is the only thing that keeps the run's record from reading
    as a complete survey — PipelineRunner turns it into the `source:openalex:
    incomplete keyword ...` error that --fail-on-errors refuses.
    """
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat()),
            {
                "id": "https://openalex.org/W2",
                "title": 12345,  # .strip() on an int raises AttributeError
                "publication_date": today.isoformat(),
                "authorships": [],
            },
            {
                "id": "https://openalex.org/W3",
                "title": 12345,
                "publication_date": today.isoformat(),
                "authorships": [],
            },
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=3,
        )

    assert [p.title for p in papers] == ["Good Paper"]
    assert src.degraded_keywords == [("llm", "2 of 3 works unreadable")]
    assert src.truncated_keywords == []


def test_fetch_reports_a_keyword_whole_page_was_dropped_without_raising():
    """The fully-dropped page must reach the run as a degraded keyword, not as a
    quiet day — and not as an outage either.

    fetch() only raises when every keyword's REQUEST failed. Here the endpoint
    answered 200 with a page this code could not read, so the source's answer is
    "0 papers, and here is the page I could not read": Stage 0 records ok=True and
    the degraded keyword is what keeps --fail-on-errors from calling the run clean.
    """
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            {
                "id": f"https://openalex.org/W{i}",
                "title": 12345,  # .strip() on an int raises AttributeError
                "publication_date": today.isoformat(),
                "authorships": [],
            }
            for i in range(3)
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=3,
        )

    assert papers == []
    assert src.degraded_keywords == [("llm", "3 of 3 works unreadable")]
    assert src.truncated_keywords == []


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
        # (papers, page_is_full, unreadable) — the same contract fetch() reads.
        return [], False, None

    monkeypatch.setattr(src, "_search", _fake_search)
    papers = src.fetch(["bad", "good"], [], date.today() - timedelta(days=7), 10)
    assert papers == []
    assert calls == ["bad", "good"]
    # The keyword that raised is named with its exception, so the run that kept
    # going is not mistaken for one that answered everything (HIGH-1).
    assert src.degraded_keywords == [("bad", "RuntimeError: boom")]


def test_fetch_survives_real_search_raising_for_one_keyword_via_http():
    """Stronger integration test (closes #398 follow-up): unlike the test
    above (which replaces _search() entirely), this exercises the REAL
    _search()/HTTP-response path for both keywords — one keyword's
    response is malformed at the response-body level (a list instead of a
    dict, which _search now refuses outright), the other keyword's response
    is a normal valid payload. The good keyword's real paper must still
    survive."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W999", title="Good Paper", pub_date=today.isoformat())

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("search") == "bad":
            # Malformed at the response-body level: a list, not a dict —
            # _search raises instead of reading `data.get("results")` off it.
            return _resp(200, [1, 2, 3])
        return _resp(200, {"results": [good_work]})

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        side_effect=_fake_request,
    ):
        papers = src.fetch(["bad", "good"], [], today - timedelta(days=7), 10)

    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


# ---- unreadable response bodies (M-2) ----


def test_body_without_the_results_list_is_a_failed_keyword():
    """Regression (M-2): `data.get("results") or []` read a 200 whose body lost the
    work list as a successful 0-paper keyword, so an endpoint that changed its
    response shape was indistinguishable from a quiet day in run_history.

    A body this code cannot read is an answer the run does not have, so the keyword
    fails; with the only keyword failing, fetch() raises so Stage 0 records
    sources_status["openalex"]["ok"] = False.
    """
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})

    for body in ({"meta": {"count": 0}}, {"results": None}, "a string", {}):
        with patch(
            "paperpilot.sources.openalex_source.request_with_retry",
            return_value=_resp(200, body),
        ):
            with pytest.raises(RuntimeError, match="openalex fetch failed for all"):
                src.fetch(
                    keywords=["x"],
                    categories=[],
                    since_date=date.today(),
                    max_results=5,
                )


def test_unreadable_body_fails_only_its_own_keyword():
    """The strictness must not convert one changed response into a whole-source loss:
    the unreadable keyword is dropped while the other keyword's real works ship —
    the same partial-success contract as a per-keyword HTTP failure."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat())

    def _fake_request(method, url, params=None, **kw):
        if params and params.get("search") == "bad":
            return _resp(200, {"error": "results unavailable"})
        return _resp(200, {"results": [good_work]})

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        side_effect=_fake_request,
    ):
        papers = src.fetch(
            ["bad", "good"], [], today - timedelta(days=7), max_results=10
        )

    assert [p.title for p in papers] == ["Good Paper"]
    assert src.truncated_keywords == []
    # The response-shape loss is reported like any other keyword failure: a 200 this
    # code cannot read is a keyword the run never got an answer for.
    assert [kw for kw, _reason in src.degraded_keywords] == ["bad"]
    assert "no 'results' list" in src.degraded_keywords[0][1]


# ---- truncated pages (the keyword filled the requested page) ----


def test_filled_page_is_recorded_as_truncated(caplog):
    """Regression (M-6): `/works` answers one page. A keyword that took all
    `per-page` works still had matches inside the date filter that this run never
    fetched, so the survey is thinner than the window and the run has to say so —
    the report ArxivSource already makes through the CLI summary."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            _openalex_work(
                work_id=f"W{i}",
                title=f"Paper {i}",
                pub_date=(today - timedelta(days=1)).isoformat(),
            )
            for i in range(3)
        ]
    }
    with caplog.at_level(logging.WARNING):
        with patch(
            "paperpilot.sources.openalex_source.request_with_retry",
            return_value=_resp(200, body),
        ) as mock:
            papers = src.fetch(
                keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
                max_results=3,
            )

    assert len(papers) == 3
    assert mock.call_args.kwargs["params"]["per-page"] == 3
    assert src.truncated_keywords == ["llm"]
    assert "llm" in caplog.text


def test_a_page_with_room_left_is_not_reported_as_truncated():
    """Fewer works than the requested page means the endpoint had nothing more
    inside the filter — a complete answer, not a cut one."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            _openalex_work(work_id="W1", pub_date=today.isoformat()),
            _openalex_work(work_id="W2", pub_date=today.isoformat()),
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=5,
        )

    assert len(papers) == 2
    assert src.truncated_keywords == []


def test_truncated_keywords_reset_between_fetches():
    """A stale report would make the next run claim a page it never filled."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    pub = today.isoformat()
    full_page = {
        "results": [_openalex_work(work_id=f"W{i}", pub_date=pub) for i in range(2)]
    }

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, full_page),
    ):
        src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=2,
        )
    assert src.truncated_keywords == ["llm"]

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, {"results": []}),
    ):
        src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=2,
        )
    assert src.truncated_keywords == []


def test_degraded_keywords_reset_between_fetches():
    """HIGH-1's other half: the report is per fetch, not per process. A stale entry
    would make the next clean run carry `source:openalex: incomplete keyword ...`,
    which --fail-on-errors refuses, so a recovered throttle would fail a complete
    survey."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat())

    def _one_bad_keyword(method, url, params=None, **kw):
        if params and params.get("search") == "bad":
            return _resp(500)
        return _resp(200, {"results": [good_work]})

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        side_effect=_one_bad_keyword,
    ):
        src.fetch(["bad", "good"], [], today - timedelta(days=7), 10)
    assert [kw for kw, _reason in src.degraded_keywords] == ["bad"]

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, {"results": [good_work]}),
    ):
        src.fetch(["good"], [], today - timedelta(days=7), 10)
    assert src.degraded_keywords == []


def test_parse_pub_date_fallback_to_year():
    work = {"publication_date": None, "publication_year": 2024}
    assert OpenAlexSource._parse_pub_date(work) == date(2024, 1, 1)


def test_parse_pub_date_invalid():
    assert OpenAlexSource._parse_pub_date({}) is None
    assert OpenAlexSource._parse_pub_date({"publication_date": "garbage"}) is None


# ---- D-1: skipped (data-quality) records vs. dropped (shape-error) records ----


def test_a_single_blank_title_record_beside_a_good_one_does_not_degrade_the_keyword():
    """D-1: a lone upstream data-quality artifact (blank title) must not turn an
    otherwise-healthy page red. It is logged and counted as `skipped`, not
    `dropped`, and the keyword stays clean as long as something else on the page
    was usable."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat())
    blank_title_work = _openalex_work(work_id="W2", pub_date=today.isoformat())
    blank_title_work["title"] = ""
    blank_title_work["display_name"] = ""
    body = {"results": [good_work, blank_title_work]}
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
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
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    good_work = _openalex_work(work_id="W1", title="Good Paper", pub_date=today.isoformat())
    unparseable_date_work = _openalex_work(work_id="W2", pub_date=None)
    unparseable_date_work["publication_year"] = None
    body = {"results": [good_work, unparseable_date_work]}
    with caplog.at_level(logging.WARNING):
        with patch(
            "paperpilot.sources.openalex_source.request_with_retry",
            return_value=_resp(200, body),
        ):
            papers = src.fetch(
                keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
                max_results=10,
            )
    assert [p.title for p in papers] == ["Good Paper"]
    assert src.degraded_keywords == []
    assert "skipping unusable work item" in caplog.text


def test_search_records_a_fully_skipped_page_as_unreadable():
    """When EVERY item on a non-empty page is a data-quality skip (not a single
    shape error in sight), that is itself a shape change (e.g. a renamed field)
    the run must still be told about — the keyword degrades."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            {
                "id": f"https://openalex.org/W{i}",
                "title": "",
                "display_name": "",
                "publication_date": today.isoformat(),
                "authorships": [],
            }
            for i in range(2)
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 2)
    assert papers == []
    assert unreadable == "2 of 2 works skipped (blank title or unparseable date); no paper survived this page"
    # Skipped-only: a full raw page still means more results exist (D-1).
    assert page_is_full is True


def test_fetch_reports_a_fully_skipped_page_as_a_degraded_keyword():
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            {
                "id": "https://openalex.org/W1",
                "title": "",
                "display_name": "",
                "publication_date": today.isoformat(),
                "authorships": [],
            }
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=today - timedelta(days=7),
            max_results=10,
        )
    assert papers == []
    assert src.degraded_keywords == [
        ("llm", "1 of 1 works skipped (blank title or unparseable date); no paper survived this page")
    ]


def test_dropped_takes_priority_in_the_unreadable_message_when_mixed_with_skipped():
    """A genuine shape error (dropped) alongside a data-quality skip must still
    degrade via the `dropped` path, with the skip count folded into the same
    message rather than silently discarded."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    body = {
        "results": [
            _openalex_work(work_id="good", title="Good Paper", pub_date=today.isoformat()),
            {  # blank title: skipped
                "id": "https://openalex.org/W2",
                "title": "",
                "display_name": "",
                "publication_date": today.isoformat(),
                "authorships": [],
            },
            {  # .strip() on an int raises AttributeError: dropped
                "id": "https://openalex.org/W3",
                "title": 12345,
                "publication_date": today.isoformat(),
                "authorships": [],
            },
        ]
    }
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, page_is_full, unreadable = src._search("kw", today - timedelta(days=7), 3)
    assert [p.title for p in papers] == ["Good Paper"]
    assert unreadable == "1 of 3 works unreadable (1 further skipped: blank title/unparseable date)"
    assert page_is_full is False


def test_a_date_filtered_item_beside_a_skipped_item_still_degrades_the_keyword():
    """MEDIUM-1: a page with ZERO surviving papers must degrade even when one of
    its items was only a legitimate date-window exclusion rather than a second
    skip — comparing `unusable` to `total` (the old rule) wrongly counted that
    date-filtered item toward "every item was unusable" and let this page read as
    clean (`unreadable=None`) purely because the denominator was inflated by an
    item that isn't unusable at all."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    since = today - timedelta(days=7)
    old_work = _openalex_work(
        work_id="old", title="Old Paper", pub_date=f"{since.year - 1}-01-01"
    )
    blank_title_work = _openalex_work(work_id="blank", pub_date=today.isoformat())
    blank_title_work["title"] = ""
    blank_title_work["display_name"] = ""
    body = {"results": [old_work, blank_title_work]}
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, _page_is_full, unreadable = src._search("kw", since, 2)
    assert papers == []
    assert unreadable == (
        "1 of 2 works skipped (blank title or unparseable date); "
        "no paper survived this page"
    )

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        fetched = src.fetch(
            keywords=["llm"], categories=[], since_date=since, max_results=10
        )
    assert fetched == []
    assert src.degraded_keywords == [
        (
            "llm",
            "1 of 2 works skipped (blank title or unparseable date); "
            "no paper survived this page",
        )
    ]


def test_an_all_date_filtered_page_with_no_unusable_items_stays_clean():
    """The counterpart: a page where every item is a legitimate date-window
    exclusion and NOTHING was skipped/dropped must stay clean — zero papers
    surviving is not itself evidence of a lost page."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    since = today - timedelta(days=7)
    old_work_1 = _openalex_work(
        work_id="old1", title="Old Paper 1", pub_date=f"{since.year - 1}-01-01"
    )
    old_work_2 = _openalex_work(
        work_id="old2", title="Old Paper 2", pub_date=f"{since.year - 2}-01-01"
    )
    body = {"results": [old_work_1, old_work_2]}
    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        papers, _page_is_full, unreadable = src._search("kw", since, 2)
    assert papers == []
    assert unreadable is None

    with patch(
        "paperpilot.sources.openalex_source.request_with_retry",
        return_value=_resp(200, body),
    ):
        fetched = src.fetch(
            keywords=["llm"], categories=[], since_date=since, max_results=10
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
    and `test_search_records_a_fully_skipped_page_as_unreadable`).
    """
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(title="", pub_date=today.isoformat())
    work["display_name"] = ""
    with pytest.raises(ValueError, match="no title"):
        src._to_paper(work, "kw", since_date=today - timedelta(days=7))


def test_to_paper_raises_when_date_unparseable():
    """No parseable publication date is also an unreadable record, not a
    legitimate date-window exclusion — it must RAISE (``_UnusableRecordError``,
    D-1), not return ``None``, so it is counted as `skipped` (upstream
    data-quality noise) rather than silently filtered or conflated with a
    genuine shape error."""
    src = OpenAlexSource({"enabled": True, "delay_seconds": 0})
    today = date.today()
    work = _openalex_work(pub_date=None)
    work["publication_year"] = None
    with pytest.raises(ValueError, match="no parseable publication date"):
        src._to_paper(work, "kw", since_date=today - timedelta(days=7))


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
