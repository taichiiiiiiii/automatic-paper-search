"""Detecting an arXiv response that returns quietly instead of raising.

The installed ``arxiv`` client retries an HTTP error and an empty non-first page
and then RAISES (``HTTPError`` / ``UnexpectedEmptyPageError``), and it stops
paginating only at ``total_results`` — so those paths cannot be mistaken for "the
window held everything". Three things return quietly with entries missing
instead:

1. A malformed feed the library's OWN parser notices at the DOCUMENT level: it
   runs lxml with ``recover=True``, and when it reports the document malformed
   the client logs ``Malformed feed; consider handling: ...`` on the ``"arxiv"``
   logger and HANDS BACK the page it could read, for any page including the
   first. Watched by :class:`MalformedFeedWatch` via the ``MALFORMED_FEED_PREFIX``
   log message.
2. A well-formed document that is missing individual ENTRIES instead: arxiv
   4.0.1's ``arxiv._feed._build_result`` (a child of the same ``"arxiv"`` logger
   hierarchy, so its records propagate to the handler watching ``"arxiv"``) logs
   ``Skipping entry without <id>`` or ``Skipping entry %s missing <%s>`` and
   DROPS that one entry while the rest of the page is handed back — no exception,
   and the document-level malformed warning above never fires because the
   document itself parsed fine. Watched by the same handler via
   ``SKIPPING_ENTRY_PREFIX``.
3. A 200 body the library's lenient parser does NOT consider malformed at all.
   Verified against arxiv 4.0.1: an HTML throttle page
   (``<html><body>rate limited</body></html>``), an XML ``<error>`` document, and a
   body with a truncated start tag (``<not xml``) all parse to a non-``None`` root
   with ``malformed=False`` and zero entries under ``recover=True`` — the client
   logs nothing and returns an empty page exactly like a genuine 0-result day. This
   case has NO observable sign in the installed library at all, so it cannot be
   caught by watching the log; it is instead caught by a ``requests`` response hook
   (see :func:`detect_malformed_feed`) that parses every 200 body itself, strictly
   (``recover=False``), and requires an Atom ``feed`` root with an
   ``opensearch:totalResults`` element. The same hook also flags a well-formed
   feed that claims a nonzero ``totalResults`` but hands back zero ``<entry>``
   elements while ``startIndex`` is still inside that count — a page that is
   genuinely past the end of the result set (``startIndex >= totalResults``) is
   NOT flagged, because that is a correct empty page, not a lost one.

All three signals land on the same :class:`MalformedFeedWatch.malformed` list
(a property combining the log-based flags with the body hook's CURRENT per-URL
flags — see :class:`MalformedFeedWatch` for why the two halves behave
differently), so a caller only has to check one thing. This lives in one place
on purpose: ``paperpilot/scripts/collect_conference.py`` judges a catalog fetch
and ``paperpilot/sources/arxiv_source.py`` judges a keyword fetch, and reading
only one of them is how a silent partial page survives.

:func:`detect_malformed_feed` is the mechanism;
``paperpilot/tests/test_arxiv_feed.py`` pins it against the installed library.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from lxml import etree

# The message prefix the installed client logs when its parser reports the feed
# malformed at the document level. Matching is prefix-based because the library
# appends the parser's own reason after "Malformed feed; consider handling: ".
MALFORMED_FEED_PREFIX = "Malformed feed"

# The message prefix `arxiv._feed._build_result` logs when it drops a single
# <entry> for lacking a required child element (<id>, <updated>, or <published>).
# Matching is prefix-based because the library interpolates the entry id and/or
# the missing tag name after it (`"Skipping entry without <id>"` /
# `"Skipping entry %s missing <%s>"`). This is logged on the "arxiv._feed" child
# logger, which propagates up to the "arxiv" logger this module watches (M-1).
SKIPPING_ENTRY_PREFIX = "Skipping entry"

# Atom / OpenSearch element identities a well-formed arXiv API response must have.
# Namespaces per https://info.arxiv.org/help/api/user-manual.html#_details_of_atom_results_returned.
_ATOM_FEED_TAG = "{http://www.w3.org/2005/Atom}feed"
_ATOM_ENTRY_TAG = "{http://www.w3.org/2005/Atom}entry"
_OPENSEARCH_TOTAL_RESULTS_TAG = "{http://a9.com/-/spec/opensearch/1.1/}totalResults"
_OPENSEARCH_START_INDEX_TAG = "{http://a9.com/-/spec/opensearch/1.1/}startIndex"

# How much of an unreadable body to keep in a reason string. Just enough to tell a
# throttle page from an error document at a glance; never the whole body, which may
# be large and is not ours to retain or log in full.
_SNIPPET_LIMIT = 80


class MalformedFeedWatch(logging.Handler):
    """The watcher and the report in one object: a handler that keeps only the
    malformed-feed warnings it sees, plus whatever the response-body hook (if
    installed) currently flags.

    ``malformed`` is empty for a well-formed fetch, including one that legitimately
    returned zero results — so ``not watch.malformed`` means "the pages parsed",
    not "papers were found".

    The two halves behind ``malformed`` are kept separately and combine only when
    read, because they behave differently on a retry (L-1):

    - Log-based flags (``MALFORMED_FEED_PREFIX`` / ``SKIPPING_ENTRY_PREFIX``) are
      append-only. A log record carries no response URL, so there is nothing to
      key a later-good-retry clear on; once logged, a log-based flag stays for the
      life of this watch.
    - The body hook's flags are keyed by the response's URL
      (``response.url`` / ``response.request.url``) and overwrite that URL's
      entry every time a 200 for it is inspected. A later GOOD 200 for the same
      URL therefore clears that URL's earlier bad flag, because the caller only
      ever consumes the LAST response for a given request — a transient bad page
      followed by a successful retry at the same URL must not leave the keyword
      permanently flagged for a page nothing downstream ever saw.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self._log_flags: list[str] = []
        # response URL -> current reason. A URL maps to at most one entry at a
        # time; the latest 200 for that URL replaces (or clears) it.
        self._body_flags_by_url: dict[str, str] = {}

    @property
    def malformed(self) -> list[str]:
        return [*self._log_flags, *self._body_flags_by_url.values()]

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if message.startswith(MALFORMED_FEED_PREFIX) or message.startswith(
            SKIPPING_ENTRY_PREFIX
        ):
            self._log_flags.append(message)


def _snippet(content: bytes) -> str:
    """A short, safe-to-log excerpt of a response body. Never the whole thing."""
    return content[:_SNIPPET_LIMIT].decode("utf-8", errors="replace")


def _opensearch_int(root: Any, tag: str, default: int = 0) -> int:
    """Read an ``<opensearch:*>`` integer element, defaulting leniently.

    Mirrors the installed client's own ``_feed._int`` helper: a missing element
    or unparseable text is not itself what this check is judging, so it falls
    back to ``default`` rather than raising.
    """
    elem = root.find(tag)
    if elem is None or elem.text is None:
        return default
    try:
        return int(elem.text.strip())
    except ValueError:
        return default


def _non_feed_body_reason(content: bytes) -> str | None:
    """``None`` iff ``content`` is a well-formed, complete arXiv Atom feed page.

    Deliberately stricter than the installed client's own parser
    (``arxiv._feed.parse``, which runs lxml with ``recover=True``): an HTML
    throttle page, an XML ``<error>`` document, and a body with a truncated start
    tag all parse to a non-``None`` root with the library's ``malformed=False``
    (see the module docstring), so none of them trips the log-based detection this
    module also runs. This check parses with ``recover=False`` and additionally
    requires the Atom ``feed`` root and an ``opensearch:totalResults`` element, so
    it catches exactly the bodies the lenient parser reads as "zero results". A
    well-formed feed with zero entries (a genuine empty day) still returns ``None``
    here — only the document shape is checked, never the entry count, UNLESS the
    feed's own ``opensearch:totalResults`` says there should be entries on this
    page and ``opensearch:startIndex`` says this page has not already scrolled
    past all of them — that combination (nonzero total, zero entries, not yet
    past the end) is a lost page, not a genuinely-empty one past the result set.
    """
    try:
        parser = etree.XMLParser(
            resolve_entities=False, no_network=True, huge_tree=False, recover=False
        )
        root = etree.fromstring(content, parser=parser)
    except etree.XMLSyntaxError as exc:
        return f"not valid XML ({exc}): {_snippet(content)!r}"
    if root is None:
        return f"empty document: {_snippet(content)!r}"
    if root.tag != _ATOM_FEED_TAG:
        return f"unexpected root element {root.tag!r} (not an Atom feed): {_snippet(content)!r}"
    if root.find(_OPENSEARCH_TOTAL_RESULTS_TAG) is None:
        return f"Atom feed missing opensearch:totalResults: {_snippet(content)!r}"

    total_results = _opensearch_int(root, _OPENSEARCH_TOTAL_RESULTS_TAG)
    entry_count = len(root.findall(_ATOM_ENTRY_TAG))
    if total_results > 0 and entry_count == 0:
        start_index = _opensearch_int(root, _OPENSEARCH_START_INDEX_TAG)
        if start_index < total_results:
            return (
                f"Atom feed claims totalResults={total_results} but this page has "
                f"zero <entry> elements (startIndex={start_index}): "
                f"{_snippet(content)!r}"
            )
    return None


def _response_url(response: Any) -> str | None:
    """The URL a response is attributed to, for the per-URL body-hook flag.

    Prefers ``response.url`` (what ``requests`` sets after following redirects);
    falls back to ``response.request.url`` for a stand-in that only sets the
    latter. ``None`` when neither is available.
    """
    url = getattr(response, "url", None)
    if url:
        return url
    request = getattr(response, "request", None)
    return getattr(request, "url", None) if request is not None else None


def _install_body_check(session: Any, watch: MalformedFeedWatch) -> Any:
    """Install a ``requests`` response hook on ``session`` that checks every 200
    response body and flags it on ``watch`` when it is not a well-formed, complete
    arXiv Atom feed page.

    Uses the public ``requests`` response-hook API (``session.hooks["response"]``)
    rather than any arXiv-library internal, so it survives library upgrades.
    Returns the installed hook function itself, so the caller can remove exactly
    that one on exit without disturbing any other hook already on the session.
    """

    def _hook(response: Any, **_kwargs: Any) -> None:
        if getattr(response, "status_code", None) != 200:
            return None  # a non-200 already raises HTTPError in the client
        # Deliberately NOT wrapped in try/except (L-2): a body this hook cannot
        # even read as bytes must propagate exactly as it would without the hook
        # installed, not vanish into a silent None return.
        content = response.content
        reason = _non_feed_body_reason(content)
        url = _response_url(response)
        if url is None:
            # No URL to key a flag on (and nothing to clear later either); this
            # should not happen with a real `requests` response, but a flagged
            # body still has to be visible even without per-URL clearing.
            if reason:
                watch._log_flags.append(f"non-feed 200 response body: {reason}")
            return None
        if reason:
            watch._body_flags_by_url[url] = f"non-feed 200 response body: {reason}"
        else:
            # A later good 200 for this exact URL clears its earlier flag (L-1):
            # the caller only ever consumes the LAST response for a given
            # request, so a flag for a page nothing downstream saw must not
            # outlive a successful retry at the same URL.
            watch._body_flags_by_url.pop(url, None)
        return None

    hooks = session.hooks.setdefault("response", [])
    if isinstance(hooks, list):
        hooks.append(_hook)
    else:
        # A session whose "response" hook was set as a single callable rather than
        # a list (unusual, but the requests API allows it); normalize to a list so
        # ours coexists with it instead of overwriting it.
        session.hooks["response"] = [hooks, _hook]
    return _hook


def _remove_body_check(session: Any, hook: Any) -> None:
    hooks = session.hooks.get("response")
    if isinstance(hooks, list):
        if hook in hooks:
            hooks.remove(hook)
    elif hooks is hook:
        session.hooks["response"] = []


@contextmanager
def detect_malformed_feed(client: Any = None) -> Iterator[MalformedFeedWatch]:
    """Watch for an incomplete arXiv fetch around a ``client.results()`` call.

    Usage::

        with detect_malformed_feed(client) as feed:
            results = list(client.results(search))
            # ...or loop over it here; the consuming must happen INSIDE the block

        if feed.malformed:
            ...  # the fetch is incomplete, whatever `results` looks like

    Two independent signals feed the same ``feed.malformed`` property (see the
    module docstring for why both are needed, and :class:`MalformedFeedWatch` for
    why they are combined rather than sharing one list):

    1. The ``"arxiv"`` logger (and its ``"arxiv._feed"`` child, which propagates
       to it) is watched for the installed client's own malformed-feed and
       skipped-entry warnings.
    2. If ``client`` is given (an ``arxiv.Client``, or any object exposing a
       ``requests.Session`` as ``_session``, or a bare ``requests.Session``), a
       response hook is installed on its session for the duration that inspects
       every 200 body itself and catches the bodies the client's own lenient
       parser reads as a clean empty page. ``client=None`` keeps only signal 1 —
       supported for callers with no session to attach to, but then this watch
       cannot see a non-conforming 200 body.

    ``client.results()`` returns a generator that fetches each page as it is
    consumed, so a call bound inside the block and iterated after it closes warns
    when nobody is listening — the watch sees nothing and a partial page reads as a
    clean fetch. Both real callers consume inside the block
    (``ArxivSource.fetch`` loops there, ``collect_conference.fetch_results_checked``
    calls a list-returning helper there), and both now also pass their client
    through so neither detection signal is missing.

    The logger's own level is lifted to WARNING only for the duration, because an
    ambient ERROR level would swallow the warning and read as a clean fetch. The
    "arxiv._feed" child logger is lifted THE SAME WAY, explicitly, rather than
    relying on it inheriting the "arxiv" level: `Logger.warning()` on a child
    checks the CHILD's own `getEffectiveLevel()` before a record is even built,
    and that walk up the hierarchy stops at the first ancestor with a level of
    its own — so it only reaches our lifted "arxiv" level while "arxiv._feed"
    itself stays at the default ``NOTSET``. Anything that ever gives
    "arxiv._feed" its own explicit level (this project's own code never does —
    ``paperpilot/utils/logger.py`` only configures the root logger — but a
    third party or a future test might) would otherwise silence the skipped-
    entry warning no matter how high "arxiv" is lifted. Both loggers' previous
    levels are restored in ``finally``.

    Installing the handler, the lifted levels, and the response hook all happen
    INSIDE the ``try`` (L-3): if attaching the hook fails partway (e.g. ``client``
    exposes something without a ``.hooks`` attribute at all), the handler already
    added and the levels already lifted are still restored in ``finally`` rather
    than leaking past this call — only the hook step itself, which never
    completed, is skipped on the way out.
    """
    watch = MalformedFeedWatch()
    logger = logging.getLogger("arxiv")
    feed_logger = logging.getLogger("arxiv._feed")
    previous_level = logger.level
    previous_feed_level = feed_logger.level
    session: Any = None
    hook: Any = None

    try:
        if previous_level == logging.NOTSET or previous_level > logging.WARNING:
            logger.setLevel(logging.WARNING)
        if previous_feed_level == logging.NOTSET or previous_feed_level > logging.WARNING:
            feed_logger.setLevel(logging.WARNING)
        logger.addHandler(watch)

        if client is not None:
            candidate_session = getattr(client, "_session", client)
            hook = _install_body_check(candidate_session, watch)
            session = candidate_session

        yield watch
    finally:
        logger.removeHandler(watch)
        logger.setLevel(previous_level)
        feed_logger.setLevel(previous_feed_level)
        if session is not None:
            _remove_body_check(session, hook)
