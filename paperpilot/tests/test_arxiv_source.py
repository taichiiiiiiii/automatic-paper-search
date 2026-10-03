"""ArxivSource tests — query building, parsing, fetch loop (mocked)."""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import requests
from requests.models import Response

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


def test_fetch_raises_when_every_keyword_fails():
    """Regression test (closes #387 follow-up): if EVERY keyword's client
    call fails, this is an outage — fetch() must raise so Stage 0 records
    sources_status["arxiv"]["ok"] = False, not silently return [] (which
    would be indistinguishable from "genuinely 0 new papers this run")."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def _boom(*args, **kwargs):
        raise RuntimeError("arxiv client exploded")

    with patch.object(src._client, "results", side_effect=_boom):
        with pytest.raises(RuntimeError, match="arxiv fetch failed for all"):
            src.fetch(
                keywords=["x"], categories=[], since_date=date.today(), max_results=5
            )


def test_fetch_keeps_partial_results_when_only_some_keywords_fail():
    """A per-keyword failure alongside at least one success is NOT an
    outage worth failing the whole source over — the successful keyword's
    real papers must still be returned, not discarded."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    good_result = SimpleNamespace(
        title="Good Paper",
        authors=[SimpleNamespace(name="Alice")],
        summary="abs",
        entry_id="http://arxiv.org/abs/2604.00001",
        published=datetime(2026, 4, 1, tzinfo=timezone.utc),
        get_short_id=lambda: "2604.00001",
        doi=None,
        pdf_url="http://pdf",
        categories=["cs.LG"],
        comment=None,
    )

    def fake_results(search):
        if "bad" in search.query:
            raise RuntimeError("boom")
        return iter([good_result])

    with patch.object(src._client, "results", side_effect=fake_results):
        papers = src.fetch(
            keywords=["bad", "good"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )
    assert len(papers) == 1
    assert papers[0].title == "Good Paper"


# ---- malformed feed pages (the client's one silent partial return) ----


def _malformed_results(results: list[SimpleNamespace]):
    """A ``client.results`` stand-in that behaves like arxiv 4.0.1 on a broken page.

    The installed client logs ``Malformed feed; consider handling: ...`` on the
    "arxiv" logger and returns what it could parse instead of raising, so the
    caller sees a finished fetch whose set is missing entries — including an
    empty set when the first page was the broken one.
    """

    def _results(_search):
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
        )
        return iter(results)

    return _results


def test_malformed_empty_page_raises_when_it_is_the_only_keyword(caplog):
    """A malformed first page yields zero results and no exception, which without
    the shared watch would be recorded as a successful 0-paper keyword. It has to
    reach the all-keywords-failed gate so Stage 0 writes
    sources_status["arxiv"]["ok"] = False instead of a misleadingly quiet run."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with caplog.at_level(logging.WARNING):
        with patch.object(src._client, "results", side_effect=_malformed_results([])):
            with pytest.raises(RuntimeError, match="arxiv fetch failed for all"):
                src.fetch(
                    keywords=["transformer"],
                    categories=[],
                    since_date=date(2026, 1, 1),
                    max_results=5,
                )

    assert "Malformed feed" in caplog.text
    assert "'transformer'" in caplog.text


def test_malformed_keyword_is_a_failed_keyword_beside_a_clean_one():
    """The malformed keyword must not make the run look fully successful, and the
    papers it already appended go with it: a set known to be missing entries is not
    evidence about the window (HIGH-1). A clean keyword's real papers still survive
    (the same partial-success contract as an exception path)."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def fake_results(search):
        if "broken" in search.query:
            # A broken page that still yielded one paper before the watch fired.
            return _malformed_results(
                [_fake_arxiv_result(title="Half a set", short_id="2604.00009")]
            )(search)
        return iter([_fake_arxiv_result(title="Good Paper", short_id="2604.00002")])

    with patch.object(src._client, "results", side_effect=fake_results):
        papers = src.fetch(
            keywords=["broken", "good"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )

    assert [p.title for p in papers] == ["Good Paper"]
    # Reported per run, not only logged: this is what lets PipelineRunner write
    # `source:arxiv: incomplete keyword 'broken' (...)` into result.errors, so
    # run_history carries the loss and --fail-on-errors refuses the run.
    assert [kw for kw, _reason in src.degraded_keywords] == ["broken"]
    assert "malformed feed" in src.degraded_keywords[0][1].lower()
    assert src.truncated_keywords == []


class _CannedAdapter(requests.adapters.BaseAdapter):
    """A transport adapter answering every request with one canned 200 body,
    through the real ``requests.Session.send()`` pipeline — so the response hook
    ``detect_malformed_feed(self._client)`` installs on ``src._client._session``
    actually fires, unlike patching ``.results`` (the other tests in this file)
    or ``.get`` directly, both of which bypass hook dispatch entirely.
    """

    def __init__(self, content: bytes) -> None:
        super().__init__()
        self._content = content

    def send(self, request, **_kwargs):  # type: ignore[override]
        resp = Response()
        resp.status_code = 200
        resp._content = self._content
        resp._content_consumed = True
        resp.request = request
        resp.url = request.url
        return resp

    def close(self) -> None:  # pragma: no cover - nothing to release
        pass


def test_html_throttle_body_is_a_degraded_keyword_not_a_quiet_zero():
    """HIGH-1 follow-up: a 200 whose body is an HTML throttle page is NOT
    malformed to the installed client's own lenient parser (``recover=True``) — it
    reads as a clean empty first page with no warning at all (see
    ``paperpilot.utils.arxiv_feed``). Drives the REAL ``arxiv.Client`` over its
    real session (only the transport is replaced), so this is the one test in this
    file that exercises ``detect_malformed_feed``'s response hook end to end rather
    than stubbing ``.results`` with a hand-logged warning.
    """
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    adapter = _CannedAdapter(b"<html><body>rate limited</body></html>")
    src._client._session.mount("http://", adapter)
    src._client._session.mount("https://", adapter)

    with pytest.raises(RuntimeError, match="arxiv fetch failed for all"):
        src.fetch(
            keywords=["transformer"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )

    assert [kw for kw, _reason in src.degraded_keywords] == ["transformer"]
    assert "non-feed 200 response body" in src.degraded_keywords[0][1]


def test_skipped_entry_within_a_well_formed_feed_is_a_degraded_keyword():
    """M-1: a feed whose single <entry> is dropped by the installed client for
    missing <published> logs ``Skipping entry ... missing <published>`` on
    "arxiv._feed" (never "Malformed feed" — the document itself parses fine),
    which `MalformedFeedWatch` did not match before M-1. Drives the REAL
    ``arxiv.Client`` over its real session so the fix is pinned end to end, the
    same way ``test_html_throttle_body_is_a_degraded_keyword_not_a_quiet_zero``
    pins the body-hook half of HIGH-1.
    """
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<feed xmlns="http://www.w3.org/2005/Atom" '
        b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
        b"<opensearch:totalResults>1</opensearch:totalResults>"
        b"<opensearch:itemsPerPage>1</opensearch:itemsPerPage>"
        b"<opensearch:startIndex>0</opensearch:startIndex>"
        b"<entry>"
        b"<id>http://arxiv.org/abs/2604.00002v1</id>"
        b"<updated>2026-04-02T00:00:00Z</updated>"
        b"<title>Missing Published</title>"
        b"<summary>an abstract</summary>"
        b"<author><name>Alice</name></author>"
        b"</entry>"
        b"</feed>"
    )
    adapter = _CannedAdapter(body)
    src._client._session.mount("http://", adapter)
    src._client._session.mount("https://", adapter)

    with pytest.raises(RuntimeError, match="arxiv fetch failed for all"):
        src.fetch(
            keywords=["transformer"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )

    assert [kw for kw, _reason in src.degraded_keywords] == ["transformer"]
    assert "malformed feed" in src.degraded_keywords[0][1].lower()


def test_mid_stream_failure_withdraws_the_papers_it_already_appended():
    """A keyword whose generator dies after yielding papers is known-incomplete in
    exactly the same way (HIGH-1): its partial set must not survive because other
    keywords answered fully, and the reason has to reach the run record."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    def fake_results(search):
        if "risky" in search.query:

            def _partial_then_boom():
                yield _fake_arxiv_result(title="Orphan", short_id="2604.00010")
                raise RuntimeError("stream broke")

            return _partial_then_boom()
        return iter([_fake_arxiv_result(title="Good Paper", short_id="2604.00002")])

    with patch.object(src._client, "results", side_effect=fake_results):
        papers = src.fetch(
            keywords=["risky", "good"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )

    assert [p.title for p in papers] == ["Good Paper"]
    assert src.degraded_keywords == [("risky", "RuntimeError: stream broke")]


def test_degraded_keywords_reset_between_fetches():
    """A stale report would make the next run claim a keyword it never lost."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with patch.object(src._client, "results", side_effect=_malformed_results([])):
        with pytest.raises(RuntimeError, match="arxiv fetch failed for all"):
            src.fetch(
                keywords=["broken"],
                categories=[],
                since_date=date(2026, 1, 1),
                max_results=5,
            )
    assert [kw for kw, _ in src.degraded_keywords] == ["broken"]

    with patch.object(src._client, "results", return_value=iter([])):
        src.fetch(
            keywords=["clean"], categories=[], since_date=date(2026, 1, 1), max_results=5
        )
    assert src.degraded_keywords == []


def test_well_formed_empty_page_is_a_successful_zero_paper_keyword():
    """A clean fetch that genuinely found nothing stays ok: it must not be swept
    into the failure list, or a quiet day reads as an outage."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with patch.object(src._client, "results", return_value=iter([])):
        papers = src.fetch(
            keywords=["obscure term"],
            categories=[],
            since_date=date(2026, 1, 1),
            max_results=5,
        )

    assert papers == []
    assert src.truncated_keywords == []


# ---- truncated windows (the fetch never reached the date boundary) ----


def _results_newest_first(count: int) -> list[SimpleNamespace]:
    return [
        _fake_arxiv_result(
            title=f"Paper {i}",
            entry_id=f"http://arxiv.org/abs/2604.000{i}",
            short_id=f"2604.000{i}v1",
            published=datetime(2026, 4, 10, tzinfo=timezone.utc),
        )
        for i in range(count)
    ]


def test_window_filling_keyword_is_recorded_as_truncated(caplog):
    """Exactly max_results items with no item older than since_date means newer
    matching papers were cut off by the window, not that the window held all of
    them — the run has to say so."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with caplog.at_level(logging.WARNING):
        with patch.object(src._client, "results", return_value=iter(_results_newest_first(3))):
            papers = src.fetch(
                keywords=["llm"],
                categories=[],
                since_date=date(2026, 4, 1),
                max_results=3,
            )

    assert len(papers) == 3
    assert src.truncated_keywords == ["llm"]
    assert "truncated" in caplog.text or "window" in caplog.text
    assert "llm" in caplog.text


def test_keyword_that_reached_the_date_boundary_is_not_truncated():
    """The last item being older than since_date proves the scan got all the way
    to the boundary, so a full-looking window is genuinely complete."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})
    results = [
        *_results_newest_first(2),
        _fake_arxiv_result(
            title="Old paper",
            entry_id="http://arxiv.org/abs/2601.00001",
            short_id="2601.00001v1",
            published=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
    ]

    with patch.object(src._client, "results", return_value=iter(results)):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=date(2026, 4, 1), max_results=3
        )

    assert len(papers) == 2
    assert src.truncated_keywords == []


def test_short_window_is_not_truncated():
    """Fewer items than requested means the window held everything (pagination
    stops at total_results), which is a complete answer."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with patch.object(src._client, "results", return_value=iter(_results_newest_first(2))):
        papers = src.fetch(
            keywords=["llm"], categories=[], since_date=date(2026, 4, 1), max_results=5
        )

    assert len(papers) == 2
    assert src.truncated_keywords == []


def test_truncated_keywords_reset_between_fetches():
    """A stale report would make the next run claim a window it never filled."""
    src = ArxivSource({"enabled": True, "delay_seconds": 0})

    with patch.object(src._client, "results", return_value=iter(_results_newest_first(2))):
        src.fetch(keywords=["llm"], categories=[], since_date=date(2026, 4, 1), max_results=2)
    assert src.truncated_keywords == ["llm"]

    with patch.object(src._client, "results", return_value=iter([])):
        src.fetch(keywords=["llm"], categories=[], since_date=date(2026, 4, 1), max_results=2)
    assert src.truncated_keywords == []
