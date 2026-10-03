"""Tests for paperpilot/utils/arxiv_feed — the shared malformed-feed detector.

Network is never hit: the unit tests log into the "arxiv" logger the way the
installed client does, and the contract tests drive the real client with only its
HTTP session's ``get`` replaced. The response-hook tests go one layer deeper and
mount a canned transport adapter instead, because the hook `detect_malformed_feed`
installs is dispatched by `requests.Session.send()` itself — monkeypatching
`session.get` (as the other contract tests do) bypasses that machinery entirely and
would make the hook look untested even when it is wired correctly.
"""

from __future__ import annotations

import contextlib
import logging
from types import SimpleNamespace

import arxiv
import pytest
import requests
from requests.models import Response

from paperpilot.utils.arxiv_feed import (
    MALFORMED_FEED_PREFIX,
    SKIPPING_ENTRY_PREFIX,
    MalformedFeedWatch,
    _install_body_check,
    detect_malformed_feed,
)


def test_collects_only_malformed_feed_warnings() -> None:
    """The watch collects the client's malformed-feed warning and nothing else.

    An unrelated arXiv warning must not be read as a partial return, or every run
    that logged anything at all would look incomplete. The prefix constant is
    asserted here too because both callers match on it literally.
    """
    logger = logging.getLogger("arxiv")

    with detect_malformed_feed() as feed:
        logger.warning("some other arxiv notice")
        logger.warning("Malformed feed; consider handling: %s", "not well-formed (invalid token)")
        logger.info("Malformed feed mentioned below the handler's level")

    assert feed.malformed == [
        "Malformed feed; consider handling: not well-formed (invalid token)"
    ]
    assert MALFORMED_FEED_PREFIX == "Malformed feed"


def test_well_formed_empty_fetch_is_not_malformed() -> None:
    """Zero results with no warning is a clean fetch.

    The caller has to be able to tell "the window held nothing" from "a page could
    not be parsed" — collapsing the two is what let a broken 200 be recorded as a
    successful 0-paper keyword.
    """
    with detect_malformed_feed() as feed:
        pass

    assert feed.malformed == []


def test_detaches_even_when_the_fetch_raises(monkeypatch) -> None:
    """The outage path raises out of the client; the watch must still detach.

    A handler left on the shared "arxiv" logger would keep appending to a dead
    watch object and leak into every later fetch in the same process, and the
    lifted level would stay behind too.
    """
    logger = logging.getLogger("arxiv")
    monkeypatch.setattr(logger, "level", logging.ERROR)
    before_handlers = list(logger.handlers)

    class _BoomError(RuntimeError):
        pass

    collected: list[list[str]] = []
    try:
        with detect_malformed_feed() as feed:
            collected.append(feed.malformed)
            raise _BoomError
    except _BoomError:
        pass

    assert collected == [[]]
    assert list(logger.handlers) == before_handlers
    assert logger.level == logging.ERROR


def test_reads_a_warning_emitted_under_an_ambient_error_level(monkeypatch) -> None:
    """An ``ERROR`` level on the arxiv logger would hide the warning.

    The watch lifts the level for its own duration so a malformed page is still
    observed, and puts the previous level back afterwards.
    """
    logger = logging.getLogger("arxiv")
    monkeypatch.setattr(logger, "level", logging.ERROR)

    with detect_malformed_feed() as feed:
        logger.warning("%s; consider handling: %s", "Malformed feed", "no element found")

    assert logger.level == logging.ERROR
    assert len(feed.malformed) == 1


# Canned response bodies for the two installed-library tests below. Each one is
# malformed at the DOCUMENT level — no element a parser could build a root from —
# so the client has exactly two ways to report it: warn (malformed feed, hand back
# the page it could read) or raise. Every body in this corpus has to do one of them,
# because a body that does neither reaches a completeness gate with no signal at all.
_MALFORMED_BODIES: tuple[bytes, ...] = (
    b"",
    b"not xml at all",
    b'<?xml version="1.0"?>',
)

# Response bodies the installed library's OWN lxml parser does NOT consider
# malformed at all: with `recover=True`, each of these parses to a non-`None` root,
# `_feed.parse` reports `malformed=False`, and the client logs nothing — a genuinely
# broken 200 reads exactly like a clean empty first page. An HTML throttle page and
# an XML `<error>` document both parse with a root tag that simply isn't `atom:feed`;
# a body with a truncated start tag (`<not xml`, one character short of a tag name)
# closes into a well-formed, entry-less document under `recover=True`. None of them
# is in `_MALFORMED_BODIES` above because the log-based watch cannot see any of
# them — `detect_malformed_feed()` with no `client` argument is blind here, which
# `test_installed_arxiv_client_does_not_warn_on_a_silently_empty_page` pins. Only
# the response-hook body check (`detect_malformed_feed(client)`) catches these, by
# parsing the body itself, strictly (`recover=False`), and requiring the Atom feed
# root plus `opensearch:totalResults` — see
# `test_detect_malformed_feed_catches_a_silently_empty_page_via_the_body_hook`.
_SILENTLY_EMPTY_BODIES: tuple[bytes, ...] = (
    b"<html><body>rate limited</body></html>",
    b"<error>rate limit exceeded</error>",
    b"<not xml",
)

_VALID_EMPTY_FEED = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom" '
    b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
    b"<opensearch:totalResults>0</opensearch:totalResults>"
    b"<opensearch:itemsPerPage>0</opensearch:itemsPerPage>"
    b"<opensearch:startIndex>0</opensearch:startIndex>"
    b"</feed>"
)

_VALID_FEED_WITH_ENTRY = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom" '
    b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" '
    b'xmlns:arxiv="http://arxiv.org/schemas/atom">'
    b"<opensearch:totalResults>1</opensearch:totalResults>"
    b"<opensearch:itemsPerPage>1</opensearch:itemsPerPage>"
    b"<opensearch:startIndex>0</opensearch:startIndex>"
    b"<entry>"
    b"<id>http://arxiv.org/abs/2604.00002v1</id>"
    b"<updated>2026-04-02T00:00:00Z</updated>"
    b"<published>2026-04-02T00:00:00Z</published>"
    b"<title>Good Paper</title>"
    b"<summary>an abstract</summary>"
    b"<author><name>Alice</name></author>"
    b"</entry>"
    b"</feed>"
)


# Probe B (M-1): a well-formed document (no document-level "Malformed feed"
# warning) whose single <entry> is itself missing <published> — arxiv 4.0.1's
# `_build_result` drops it with `Skipping entry %s missing <published>` and
# hands back a page with zero results, no exception. Verified against the
# installed library: totalResults=1 with the one entry missing <published>
# yields [] silently (see the module docstring this pins).
_FEED_ONE_ENTRY_MISSING_PUBLISHED = (
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

# Probe C (M-1): three entries on one page, the middle one missing <published>.
# Verified against the installed library: this is the shape that makes
# `client.results()` silently return ['P1', 'P3', 'P3'] when paginated one entry
# at a time (P2 lost, P3 duplicated via offset drift) — the specific duplication
# is a pagination side effect this module does not fix, but the underlying
# per-entry skip has to be visible on `feed.malformed` regardless of how many
# entries survive, which is what this probe pins.
_FEED_MIDDLE_ENTRY_MISSING_PUBLISHED = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom" '
    b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
    b"<opensearch:totalResults>3</opensearch:totalResults>"
    b"<opensearch:itemsPerPage>3</opensearch:itemsPerPage>"
    b"<opensearch:startIndex>0</opensearch:startIndex>"
    b"<entry>"
    b"<id>http://arxiv.org/abs/2604.00001v1</id>"
    b"<updated>2026-04-01T00:00:00Z</updated>"
    b"<published>2026-04-01T00:00:00Z</published>"
    b"<title>P1</title><summary>abs</summary>"
    b"<author><name>Alice</name></author>"
    b"</entry>"
    b"<entry>"
    b"<id>http://arxiv.org/abs/2604.00002v1</id>"
    b"<updated>2026-04-02T00:00:00Z</updated>"
    b"<title>P2 (missing published)</title><summary>abs</summary>"
    b"<author><name>Alice</name></author>"
    b"</entry>"
    b"<entry>"
    b"<id>http://arxiv.org/abs/2604.00003v1</id>"
    b"<updated>2026-04-03T00:00:00Z</updated>"
    b"<published>2026-04-03T00:00:00Z</published>"
    b"<title>P3</title><summary>abs</summary>"
    b"<author><name>Alice</name></author>"
    b"</entry>"
    b"</feed>"
)

# A well-formed feed whose totalResults claims entries exist on this page but
# the page carries zero <entry> elements at all, with startIndex still inside
# the claimed count — the body-hook addition to M-1: the per-entry log signal
# above cannot catch this because there is no <entry> element to log a skip
# about in the first place.
_FEED_NONZERO_TOTAL_ZERO_ENTRIES = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom" '
    b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
    b"<opensearch:totalResults>5</opensearch:totalResults>"
    b"<opensearch:itemsPerPage>5</opensearch:itemsPerPage>"
    b"<opensearch:startIndex>0</opensearch:startIndex>"
    b"</feed>"
)

# The legitimate counterpart: startIndex has already scrolled past totalResults,
# so zero entries on this page is a correct "past the end" page, not a lost one.
_FEED_PAST_THE_END_IS_LEGITIMATELY_EMPTY = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom" '
    b'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">'
    b"<opensearch:totalResults>5</opensearch:totalResults>"
    b"<opensearch:itemsPerPage>5</opensearch:itemsPerPage>"
    b"<opensearch:startIndex>5</opensearch:startIndex>"
    b"</feed>"
)


def _canned_client(monkeypatch, body: bytes) -> arxiv.Client:
    """A real client whose every HTTP GET returns ``body`` — no network, no retry sleep."""
    client = arxiv.Client(page_size=1, delay_seconds=0, num_retries=0)
    response = SimpleNamespace(status_code=200, content=body)
    monkeypatch.setattr(client._session, "get", lambda url, **_kwargs: response)
    return client


class _CannedAdapter(requests.adapters.BaseAdapter):
    """A transport adapter that answers every request with one canned response,
    through the REAL ``requests.Session.send()`` machinery.

    Monkeypatching ``session.get`` (as ``_canned_client`` does) replaces the method
    that calls ``Session.request()`` -> ``Session.send()`` in the first place, so it
    skips the code that dispatches ``session.hooks["response"]`` entirely — fine for
    the log-watcher tests, which don't involve hooks, but it would make the
    response-hook body check look untested even when wired correctly. Mounting this
    on the session instead replaces only the transport, so ``Session.send()`` still
    runs for real and still dispatches hooks.
    """

    def __init__(self, status_code: int, content: bytes) -> None:
        super().__init__()
        self._status_code = status_code
        self._content = content

    def send(self, request, **_kwargs):  # type: ignore[override]
        resp = Response()
        resp.status_code = self._status_code
        resp._content = self._content
        resp._content_consumed = True
        resp.request = request
        resp.url = request.url
        return resp

    def close(self) -> None:  # pragma: no cover - nothing to release
        pass


def _client_with_canned_response(status_code: int, content: bytes) -> arxiv.Client:
    """A real client whose every HTTP request is answered by a canned response
    through the real session pipeline — so a response hook installed on the
    session (as ``detect_malformed_feed(client)`` does) actually fires."""
    client = arxiv.Client(page_size=1, delay_seconds=0, num_retries=0)
    adapter = _CannedAdapter(status_code, content)
    client._session.mount("http://", adapter)
    client._session.mount("https://", adapter)
    return client


def _installed_client_outcome(monkeypatch, caplog, body: bytes) -> SimpleNamespace:
    """Run the real ``arxiv.Client`` over one canned response body, offline.

    Only the session's ``get`` is replaced, so the library's own Atom parser, its
    malformed-feed branch and its pagination all run unchanged.
    """
    requested: list[str] = []
    response = SimpleNamespace(status_code=200, content=body)

    def _get(url: str, **_kwargs: object) -> SimpleNamespace:
        requested.append(url)
        return response

    client = arxiv.Client(page_size=1, delay_seconds=0, num_retries=0)
    monkeypatch.setattr(client._session, "get", _get)
    caplog.clear()
    raised: Exception | None = None
    # Same reason detect_malformed_feed lifts the level itself: an ambient ERROR
    # level on the arxiv logger would hide the warning and read as a clean fetch.
    with caplog.at_level(logging.WARNING, logger="arxiv"):
        try:
            results = list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5)))
        except Exception as exc:  # the outage path is the other half of what is pinned
            results, raised = [], exc

    return SimpleNamespace(
        body=body,
        results=results,
        raised=raised,
        requests=len(requested),
        malformed_records=[
            record
            for record in caplog.records
            if record.name == "arxiv"
            and record.getMessage().startswith(MALFORMED_FEED_PREFIX)
        ],
    )


def test_installed_arxiv_client_warns_on_a_malformed_page(caplog, monkeypatch) -> None:
    """Pin the third-party contract ``detect_malformed_feed`` rests on, offline.

    arxiv 4.0.1 (the version uv.lock pins, and what both ``fetch_results`` and
    ArxivSource talk to) hands every page to its own lxml parser and, when that
    parser reports the document malformed, logs ``Malformed feed; consider
    handling: ...`` on the "arxiv" logger and HANDS BACK the page it could read —
    no exception. That warning is one of the two observable signs a silent partial
    return can give (the other is the response-hook body check pinned below, for
    bodies this lenient parser does NOT consider malformed at all), so
    ``MALFORMED_FEED_PREFIX`` has to keep matching the installed library and not
    just this suite's stand-ins. If a bump makes a malformed page raise instead of
    warn, or warn with different words, this test fails and the completeness gates
    in ``collect_conference.fetch_results_checked`` and ``ArxivSource.fetch`` have
    to be re-read rather than trusted.

    EVERY canned body has to produce one of the two signals, not just one of the
    bodies: a body that neither warns nor raises is a partial page the gates cannot
    detect at all, and an existentially-quantified assertion would let that pass as
    long as some other body warned.
    """
    outcomes = [
        _installed_client_outcome(monkeypatch, caplog, body) for body in _MALFORMED_BODIES
    ]

    for outcome in outcomes:
        assert outcome.malformed_records or outcome.raised is not None, (
            "a non-document response reached the installed client with neither a "
            f"warning starting {MALFORMED_FEED_PREFIX!r} nor an exception: "
            f"{outcome.body!r} yielded {len(outcome.results)} result(s) in "
            f"{outcome.requests} request(s). Both completeness gates judge a fetch "
            "by those two signals, so for this body they would record an unreadable "
            "page as a clean answer."
        )
        if not outcome.malformed_records:
            continue
        assert all(r.levelno >= logging.WARNING for r in outcome.malformed_records)
        # The malformed page is returned as a finished fetch: the caller has to judge it
        # from the log line, and the empty first page stops pagination after one request.
        assert outcome.raised is None, outcome.body
        assert outcome.results == [], outcome.body
        assert outcome.requests == 1, outcome.body

    warned = [outcome for outcome in outcomes if outcome.malformed_records]
    assert warned, (
        "no malformed response body made the installed arxiv client log a warning starting "
        f"with {MALFORMED_FEED_PREFIX!r}: the malformed-feed detection has "
        "no signal left for a partial return and both completeness gates are now blind"
    )


def test_watch_catches_the_installed_client_live(monkeypatch) -> None:
    """End-to-end, offline: a real malformed page is visible through the watch.

    The contract test above proves the library warns; this proves the watch is
    actually attached on the path the library takes, so neither caller can pass its
    completeness gate by accident. Every body in the corpus is checked, for the same
    reason as above: one warned body is not enough to show the gate holds.
    """
    outcomes: list[tuple[bytes, list[object], str | None, list[str]]] = []
    for body in _MALFORMED_BODIES:
        client = _canned_client(monkeypatch, body)
        raised: str | None = None
        with detect_malformed_feed() as feed:
            try:
                results: list[object] = list(
                    client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3))
                )
            except Exception as exc:  # the outage path is the other half of what is pinned
                results, raised = [], type(exc).__name__
        outcomes.append((body, results, raised, list(feed.malformed)))

    for body, _results, raised, malformed in outcomes:
        assert malformed or raised is not None, (
            "a malformed response body reached the real client through the watch with "
            f"neither a malformed note nor an exception: {body!r}. The watch is the "
            "signal both completeness gates read, so this body would pass a gate in "
            "silence."
        )
        if not malformed:
            continue
        assert raised is None, "the malformed page raised instead of warning"
        assert _results == []
        assert malformed[0].startswith(MALFORMED_FEED_PREFIX)

    caught = [outcome for outcome in outcomes if outcome[3]]
    assert caught, (
        "no malformed response body reached the watch, so neither completeness gate has "
        f"a signal left for a partial return: {outcomes}"
    )


def test_installed_arxiv_client_does_not_warn_on_a_silently_empty_page(caplog, monkeypatch) -> None:
    """Pin the gap the response hook exists to close.

    A 200 whose body is an HTML throttle page, an XML ``<error>`` document, or a
    truncated start tag is NOT malformed to the installed library's own lenient
    parser (``recover=True``): each parses to a non-``None`` root with
    ``malformed=False`` and zero entries, so the client logs nothing at all and
    returns an empty first page exactly like a genuine 0-result day (HIGH-1). If a
    library bump makes any of these warn or raise instead, this test fails and
    the gap the body-check hook was added for may have closed on its own.
    """
    outcomes = [
        _installed_client_outcome(monkeypatch, caplog, body) for body in _SILENTLY_EMPTY_BODIES
    ]
    for outcome in outcomes:
        assert outcome.malformed_records == [], outcome.body
        assert outcome.raised is None, outcome.body
        assert outcome.results == [], outcome.body
        assert outcome.requests == 1, outcome.body


def test_detect_malformed_feed_catches_a_silently_empty_page_via_the_body_hook() -> None:
    """End-to-end, offline: the response hook is what sees a silently-empty page.

    The test above proves the library's log watcher cannot; this proves
    ``detect_malformed_feed(client)`` still does, through the real client's real
    HTTP session (a canned transport adapter replaces only the network, so
    ``Session.send()`` still dispatches the hook for real), for every body in the
    corpus.
    """
    for body in _SILENTLY_EMPTY_BODIES:
        client = _client_with_canned_response(200, body)
        with detect_malformed_feed(client) as feed:
            results = list(
                client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3))
            )
        assert results == [], body
        assert feed.malformed, (
            f"a silently-empty 200 body reached detect_malformed_feed(client) with no "
            f"signal at all: {body!r}. Both completeness gates would read this as a "
            "clean, genuinely-empty fetch."
        )
        assert "non-feed 200 response body" in feed.malformed[0], body


def test_detect_malformed_feed_with_no_client_is_blind_to_a_silently_empty_page(
    monkeypatch,
) -> None:
    """The documented limitation of ``client=None``: without a session to attach
    the hook to, only the log watcher runs, and it has nothing to see for these
    bodies (confirmed above) — so the watch reports a clean fetch."""
    client = _canned_client(monkeypatch, _SILENTLY_EMPTY_BODIES[0])
    with detect_malformed_feed() as feed:  # no client passed
        list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3)))
    assert feed.malformed == []


def test_hook_does_not_flag_a_well_formed_empty_feed() -> None:
    """A genuinely empty day must stay clean: the hook checks document shape only,
    never the entry count."""
    client = _client_with_canned_response(200, _VALID_EMPTY_FEED)
    with detect_malformed_feed(client) as feed:
        results = list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3)))
    assert results == []
    assert feed.malformed == []


def test_hook_does_not_flag_a_well_formed_feed_with_entries() -> None:
    """A real page of results must not be flagged just because it was inspected."""
    client = _client_with_canned_response(200, _VALID_FEED_WITH_ENTRY)
    with detect_malformed_feed(client) as feed:
        results = list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3)))
    assert [r.title for r in results] == ["Good Paper"]
    assert feed.malformed == []


def test_body_hook_is_removed_after_the_context_manager_exits() -> None:
    """The hook must not outlive the call that installed it, same as the log
    handler and level — a leaked hook would keep inspecting every later request
    this session makes, including ones no caller asked to watch."""
    client = arxiv.Client(page_size=1, delay_seconds=0, num_retries=0)
    with detect_malformed_feed(client):
        installed = list(client._session.hooks.get("response") or [])
        assert installed, "the hook was never installed"
    assert list(client._session.hooks.get("response") or []) == []


def test_body_hook_ignores_non_200_responses() -> None:
    """A non-200 status is the client's own ``HTTPError`` territory; the hook must
    not also classify its body, or a routine 429 would get a second, misleading
    reason appended."""
    client = _client_with_canned_response(503, b"<html>down for maintenance</html>")

    with detect_malformed_feed(client) as feed:
        # the HTTPError path is not what this test is about
        with contextlib.suppress(Exception):
            list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3)))
    assert feed.malformed == []


# ---- M-1: individual entries skipped within an otherwise well-formed feed ----


def test_probe_b_single_entry_missing_published_is_caught_through_the_real_session() -> None:
    """Probe B, through the real-session canned adapter (not a hand-logged
    warning): a well-formed document whose one <entry> is missing <published>
    produces no document-level "Malformed feed" warning at all — only
    `arxiv._feed._build_result`'s `Skipping entry ... missing <published>`,
    logged on the "arxiv._feed" child logger. Before M-1 this is invisible to
    `MalformedFeedWatch`, which only matched `MALFORMED_FEED_PREFIX`, so the
    fetch reads as a clean 0-paper day."""
    client = _client_with_canned_response(200, _FEED_ONE_ENTRY_MISSING_PUBLISHED)
    with detect_malformed_feed(client) as feed:
        results = list(
            client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5))
        )
    assert results == []
    assert feed.malformed, (
        "a well-formed feed whose only entry was dropped for missing <published> "
        "must still flag — otherwise it reads exactly like a genuine 0-paper day"
    )
    assert any(m.startswith(SKIPPING_ENTRY_PREFIX) for m in feed.malformed)


def test_probe_c_one_bad_entry_among_good_ones_is_caught_through_the_real_session() -> None:
    """Probe C, through the real-session canned adapter: three entries on one
    page, the middle one missing <published>. The page still hands back two
    results (P1 and P3), which without M-1 would read as a complete, clean
    page — the dropped entry has to be visible on `feed.malformed` regardless
    of how many entries survived."""
    client = _client_with_canned_response(200, _FEED_MIDDLE_ENTRY_MISSING_PUBLISHED)
    with detect_malformed_feed(client) as feed:
        results = list(
            client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5))
        )
    # P2 never survives; exactly how many times P1/P3 are seen depends on the
    # installed client's own offset bookkeeping after a short page (the
    # pagination duplication this probe's docstring describes) — not something
    # this module fixes or needs to pin. What this test pins is that the drop
    # is VISIBLE on feed.malformed regardless of what the duplicated remainder
    # looks like.
    assert "P2 (missing published)" not in [r.title for r in results]
    assert feed.malformed, (
        "a page with a dropped middle entry must flag even though it still "
        "returned other, valid entries"
    )
    assert any(m.startswith(SKIPPING_ENTRY_PREFIX) for m in feed.malformed)


def test_probe_b_is_caught_even_when_arxiv_feed_has_its_own_ambient_level(
    monkeypatch,
) -> None:
    """M-1's level-lift has to cover "arxiv._feed" EXPLICITLY, not merely rely on
    it inheriting "arxiv"'s lifted level: `Logger.warning()` on a child checks
    the child's OWN effective level first, and that walk up the hierarchy stops
    at the first ancestor that has a level of its own — lifting only "arxiv"
    would do nothing if "arxiv._feed" already has an explicit level above
    WARNING from somewhere else. Nothing in this project sets that today, but
    this pins the lift against ever silently regressing if something did."""
    feed_logger = logging.getLogger("arxiv._feed")
    monkeypatch.setattr(feed_logger, "level", logging.ERROR)

    client = _client_with_canned_response(200, _FEED_ONE_ENTRY_MISSING_PUBLISHED)
    with detect_malformed_feed(client) as feed:
        results = list(
            client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5))
        )
    assert results == []
    assert feed.malformed, (
        "an ambient ERROR level set directly on 'arxiv._feed' must not silence "
        "the skipped-entry warning — the lift has to reach that logger itself, "
        "not just its 'arxiv' parent"
    )
    assert any(m.startswith(SKIPPING_ENTRY_PREFIX) for m in feed.malformed)
    # Restored afterwards, same contract as the "arxiv" logger's own level.
    assert feed_logger.level == logging.ERROR


def test_body_hook_flags_nonzero_total_results_with_zero_entries() -> None:
    """M-1's body-hook addition: a feed claiming totalResults=5 but carrying zero
    <entry> elements on a page that has not yet scrolled past that count (
    startIndex=0 < totalResults=5) is a lost page — there is no <entry> element
    at all for the log-based per-entry check to catch, so this has to be the body
    hook's job."""
    client = _client_with_canned_response(200, _FEED_NONZERO_TOTAL_ZERO_ENTRIES)
    with detect_malformed_feed(client) as feed:
        results = list(
            client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5))
        )
    assert results == []
    assert feed.malformed
    assert "non-feed 200 response body" in feed.malformed[0]


def test_body_hook_does_not_flag_a_page_genuinely_past_the_end() -> None:
    """The counterpart: startIndex >= totalResults means this page is correctly
    empty because the result set has already been exhausted, not lost. Must stay
    clean or every collector's last, empty page would be misreported."""
    client = _client_with_canned_response(200, _FEED_PAST_THE_END_IS_LEGITIMATELY_EMPTY)
    with detect_malformed_feed(client) as feed:
        results = list(
            client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5))
        )
    assert results == []
    assert feed.malformed == []


# ---- L-1: body-hook flags are keyed by URL, so a good retry clears them ----


def test_body_check_clears_a_url_flag_once_a_retry_at_the_same_url_is_good() -> None:
    """A transient bad page followed by a successful retry at the SAME URL must
    not leave the keyword permanently flagged for a response nothing downstream
    ever consumed — the caller only ever sees the LAST response for a URL."""
    session = requests.Session()
    calls = {"n": 0}

    class _FlakyAdapter(requests.adapters.BaseAdapter):
        def send(self, request, **_kwargs):  # type: ignore[override]
            calls["n"] += 1
            resp = Response()
            resp.status_code = 200
            resp._content = (
                b"<html><body>rate limited</body></html>"
                if calls["n"] == 1
                else _VALID_FEED_WITH_ENTRY
            )
            resp._content_consumed = True
            resp.request = request
            resp.url = request.url
            return resp

        def close(self) -> None:  # pragma: no cover - nothing to release
            pass

    adapter = _FlakyAdapter()
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    url = "http://export.arxiv.org/api/query?search_query=x"
    with detect_malformed_feed(session) as feed:
        session.get(url)
        assert feed.malformed, "the first (bad) response at this URL must flag"
        session.get(url)
        assert feed.malformed == [], (
            "a later good 200 for the same URL must clear that URL's earlier flag"
        )


def test_body_check_clearing_is_scoped_to_its_own_url() -> None:
    """(L-1) The per-URL clear in `_install_body_check` must only clear the
    URL that actually got a good retry. A bad 200 at URL A followed by a
    good 200 at a DIFFERENT URL B must leave A's flag on `feed.malformed` —
    the body hook keys its dict by `response.url`, so a success at B has no
    business touching A's entry at all."""
    session = requests.Session()

    class _TwoUrlAdapter(requests.adapters.BaseAdapter):
        def send(self, request, **_kwargs):  # type: ignore[override]
            resp = Response()
            resp.status_code = 200
            if request.url == url_a:
                resp._content = b"<html><body>rate limited</body></html>"
            else:
                resp._content = _VALID_FEED_WITH_ENTRY
            resp._content_consumed = True
            resp.request = request
            resp.url = request.url
            return resp

        def close(self) -> None:  # pragma: no cover - nothing to release
            pass

    adapter = _TwoUrlAdapter()
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    url_a = "http://export.arxiv.org/api/query?search_query=a"
    url_b = "http://export.arxiv.org/api/query?search_query=b"
    with detect_malformed_feed(session) as feed:
        session.get(url_a)
        assert feed.malformed, "the bad 200 at URL A must flag"
        session.get(url_b)
        # URL B's good response must not clear URL A's unrelated flag.
        assert len(feed.malformed) == 1, (
            "a good 200 at a DIFFERENT url must not clear another url's "
            "earlier flag — clearing is per-url, not global"
        )


def test_log_based_flags_do_not_clear_on_a_later_good_body() -> None:
    """The log-based half has no URL to key a clear on, so (unlike the body
    hook) it stays for the life of the watch even after a later good body."""
    client = _client_with_canned_response(200, _VALID_FEED_WITH_ENTRY)
    with detect_malformed_feed(client) as feed:
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "boom"
        )
        list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=3)))
    assert any(m.startswith(MALFORMED_FEED_PREFIX) for m in feed.malformed)


# ---- L-2: a body-read error must propagate, not vanish ----


def test_body_check_lets_a_body_read_error_propagate() -> None:
    """The hook must not swallow an error reading the response body; it has to
    propagate exactly as it would without the hook installed."""
    watch = MalformedFeedWatch()
    session = SimpleNamespace(hooks={})
    hook = _install_body_check(session, watch)

    class _BoomResponse:
        status_code = 200
        url = "http://x"

        @property
        def content(self) -> bytes:
            raise OSError("body truncated mid-read")

    with pytest.raises(OSError, match="body truncated mid-read"):
        hook(_BoomResponse())


# ---- L-3: installation lives inside the try, so a partial install still cleans up ----


def test_cleanup_happens_even_when_the_hook_install_raises() -> None:
    """A client whose session has no `.hooks` attribute at all makes
    `_install_body_check` raise ``AttributeError`` partway through
    `detect_malformed_feed`'s setup. The handler already added and the level
    already lifted must still be removed/restored — a client that does not
    support the hook must not leak a handler onto the shared "arxiv" logger."""
    logger = logging.getLogger("arxiv")
    before_handlers = list(logger.handlers)
    before_level = logger.level

    class _NoHooksSession:
        pass  # no `.hooks` attribute at all

    with pytest.raises(AttributeError):
        with detect_malformed_feed(_NoHooksSession()):
            pass  # pragma: no cover - never reached, the setup itself raises

    assert list(logger.handlers) == before_handlers
    assert logger.level == before_level
