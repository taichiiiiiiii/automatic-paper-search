"""Semantic Scholar source.

Uses the /paper/search endpoint per keyword, bounded server-side by
`publicationDateOrYear=<since_date>:` and filtered again client-side, so
the relevance-ranked pool the endpoint returns is drawn from the window
instead of from every paper S2 has ever indexed.

Auth: optional x-api-key header (higher rate limits).
API: https://api.semanticscholar.org/graph/v1
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from ..utils.rate_limiter import RateLimiter
from .base import AbstractSource

logger = get_logger(__name__)

S2_BASE = "https://api.semanticscholar.org/graph/v1"
SEARCH_FIELDS = (
    "paperId,title,abstract,authors.name,authors.authorId,"
    "year,publicationDate,externalIds,openAccessPdf,venue,url"
)


class _UnusableRecordError(ValueError):
    """A paper item that is well-formed JSON but carries no usable content — a
    blank/missing title or no parseable publication date (D-1).

    This is an upstream DATA-QUALITY artifact, not a shape error: a single such
    record among otherwise-good ones must not turn the run red on its own.
    `_search` catches this separately from the generic `except Exception` shape
    guard (non-dict item, AttributeError from an unexpected field type, ...) so
    it can count it as `skipped` rather than `dropped`, log a WARNING, and only
    degrade the keyword when NO paper survived the page at all (zero papers AND
    at least one item skipped/dropped) or when a genuine shape error
    (`dropped > 0`) also occurred. A page that was all legitimate date-window
    exclusions (no skips, no drops, just nothing recent enough) stays clean even
    though it also produced zero papers (MEDIUM-1: counting a date-filtered item
    toward "every item" let a page with nothing recent and one unusable record
    read as clean). Subclasses `ValueError` so it stays a `ValueError` for anyone
    matching that (e.g. `_to_paper`'s direct callers/tests), while still being
    distinguishable via its own `except` clause in `_search`.
    """


class S2Source(AbstractSource):
    name = "s2"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        # Without key: polite ~1req/sec. With key: up to 10 req/sec.
        delay = float(self.config.get("delay_seconds", 1.0))
        self._limiter = RateLimiter(delay)
        # Keywords whose last fetch filled the whole requested page, so matching
        # papers beyond it were never fetched. Reset by every fetch(); gathered by
        # PipelineRunner into the run result, which the CLI prints and run_history
        # records (same channel as ArxivSource.truncated_keywords).
        self.truncated_keywords: list[str] = []
        # Keywords whose last fetch is known INCOMPLETE: the request failed or the
        # body could not be read. Their papers are absent while the surviving
        # keywords still ship, so Stage 0 honestly records ok=True and the loss is
        # invisible unless the source names it — `(keyword, reason)` per keyword,
        # the same channel as ArxivSource.degraded_keywords, which PipelineRunner
        # turns into `source:s2: incomplete keyword ...`. Reset by every fetch().
        self.degraded_keywords: list[tuple[str, str]] = []

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        return headers

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        # S2 ignores arXiv-style categories; we keep the param for interface
        # symmetry. Category filtering happens in Stage 1.
        papers: list[Paper] = []
        failures: list[str] = []
        truncated: list[str] = []
        degraded: list[tuple[str, str]] = []
        self.truncated_keywords = []
        self.degraded_keywords = []
        for kw in keywords:
            self._limiter.wait()
            try:
                batch, page_is_full, unreadable = self._search(kw, since_date, max_results)
            except Exception as e:
                # Fail-safe: one keyword failing (S2's free tier throttles
                # aggressively, so a single 429 is routine) must not discard
                # the papers other keywords already returned. The keyword that
                # did fail is named with its reason so a partial answer cannot be
                # read as a complete one (HIGH-1, same channel as ArxivSource).
                logger.warning("s2: keyword '%s' failed: %s", kw, e)
                failures.append(kw)
                degraded.append((kw, f"{type(e).__name__}: {e}"))
                continue
            logger.info("s2: keyword '%s' returned %d papers", kw, len(batch))
            if unreadable:
                # The readable papers of this keyword still ship — the loss is
                # item-level, not page-level — but the papers that could not be
                # read are gone from this keyword's answer, so it is incomplete
                # the same way a failed request is, and named the same way
                # (same channel as OpenAlexSource.degraded_keywords).
                degraded.append((kw, unreadable))
            if page_is_full:
                truncated.append(kw)
                logger.warning(
                    "s2: keyword '%s' filled the whole %d-result page, so the "
                    "matching papers the endpoint had beyond it were never "
                    "fetched",
                    kw,
                    min(max_results, 100),
                )
            papers.extend(batch)

        # Recorded before the all-keywords-failed raise below so an attribute
        # read after a failed fetch still describes this run, never the last
        # successful one.
        self.truncated_keywords = truncated
        self.degraded_keywords = degraded

        if keywords and len(failures) == len(keywords):
            # Every keyword failed: this is an outage, not "genuinely 0 new
            # papers today". Raise so Stage 0's existing per-source failure
            # path (stage_collect.py) records sources_status["s2"]["ok"] =
            # False. Matches the arxiv/openalex contract exactly.
            raise RuntimeError(f"s2 fetch failed for all {len(keywords)} keyword(s)")

        logger.info("s2: collected %d papers (pre-dedup)", len(papers))
        return papers

    # ---- helpers ----

    def _search(
        self, keyword: str, since_date: date, max_results: int
    ) -> tuple[list[Paper], bool, str | None]:
        """Returns `(papers, page_is_full, unreadable)`.

        `page_is_full` is True when the endpoint handed back as many items as
        the requested limit — it had at least one more match inside the date
        bound that this single page never fetched, so the keyword's answer is
        known-partial rather than complete. It is only that when the page could
        be read at all; see `unreadable`.

        `unreadable` is None unless the page is degraded: either a genuine shape
        error dropped at least one item (`dropped > 0`, same as before — a
        `"<N> of <M> papers unreadable"` note), or NO paper survived the page at
        all while at least one item was skipped/dropped (MEDIUM-1: a page can
        have zero papers purely because every item was outside the date window,
        which is a correct filter, not an unreadable page — so the degrade check
        is `not papers and unusable > 0`, not "every item was unusable", which
        wrongly counted legitimate date exclusions toward "every item" and let a
        page with one unusable record beside them read as clean). A blank title
        or unparseable date among otherwise-good items (i.e. at least one paper
        did survive) is upstream noise — it is logged and counted as `skipped`,
        not `dropped`, and does NOT degrade the keyword by itself (same contract
        as OpenAlexSource._search).
        """
        limit = min(max_results, 100)
        params = {
            "query": keyword,
            "limit": limit,
            "fields": SEARCH_FIELDS,
            # Open-ended range (`<since>:`) so the relevance-ranked pool is
            # restricted to the window in the first place. Without a date bound
            # /paper/search ranks every matching paper ever indexed, so an old
            # high-relevance hit takes the slot a paper published yesterday
            # would have had, the client-side `since_date` filter below drops
            # what came back, and the source returns 0 papers every run.
            "publicationDateOrYear": f"{since_date.isoformat()}:",
        }
        resp = request_with_retry(
            "GET", f"{S2_BASE}/paper/search", params=params, headers=self._headers()
        )
        if resp is None or resp.status_code != 200:
            status = getattr(resp, "status_code", None)
            logger.warning("s2: search failed for '%s' (status=%s)", keyword, status)
            # Raise (rather than return []) so this reaches Stage 0's
            # existing per-source failure path (stage_collect.py's
            # asyncio.gather(..., return_exceptions=True)) and is recorded
            # as sources_status[name]["ok"] = False. Returning [] here would
            # make an S2 outage indistinguishable from "genuinely 0 new
            # papers this run" in run_history.jsonl.
            raise RuntimeError(f"s2 search failed for '{keyword}' (status={status})")
        data = resp.json() or {}
        if not isinstance(data, dict):
            # Same reasoning as the status gate: a body this code cannot read is
            # an answer the run does not have, not an empty one. `data.get` on a
            # list/str would raise AttributeError further down and be logged as
            # an "unexpected" keyword failure, hiding that the endpoint changed
            # its response shape.
            raise RuntimeError(
                f"s2 search for '{keyword}' returned {type(data).__name__} "
                "instead of an object"
            )
        results: list[dict[str, Any]] = data.get("data")
        if not isinstance(results, list):
            # `or []` here used to turn a 200 whose body lost the `data` list
            # into a successful 0-paper keyword.
            raise RuntimeError(
                f"s2 search for '{keyword}' has no 'data' list "
                f"(got {type(results).__name__})"
            )

        papers: list[Paper] = []
        dropped = 0
        skipped = 0
        for item in results:
            try:
                paper = self._to_paper(item, keyword, since_date)
            except _UnusableRecordError as e:
                # D-1: a blank title or unparseable date is an upstream
                # data-quality artifact, not a fetch failure — counted
                # separately from `dropped` so it does not, by itself, turn
                # this keyword's whole page red.
                skipped += 1
                logger.warning(
                    "s2: skipping unusable paper item for '%s': %s", keyword, e
                )
                continue
            except Exception as e:
                # Fail-safe: a genuine SHAPE error in a single item (non-dict
                # item, unexpected field type, ...) must not abort the rest of
                # the batch — same policy as OpenAlexSource._search.
                dropped += 1
                logger.warning(
                    "s2: skipping malformed paper item for '%s': %s", keyword, e
                )
                continue
            if paper is not None:
                papers.append(paper)

        # Skipping is not answering. Without this count a page whose items were
        # all unreadable returned [] and raised nothing, so the keyword read as
        # a clean 0 while the papers the endpoint actually had stayed uncollected.
        # `dropped > 0` always degrades (a genuine shape error, same as before);
        # a `skipped`-only page degrades only when NO paper survived the page at
        # all (MEDIUM-1) — comparing `unusable` to `total` instead wrongly folded
        # legitimate date-window exclusions (neither `dropped` nor `skipped`)
        # into "every item", so a page with e.g. one date-filtered item plus one
        # blank-title item never matched `unusable == total` and read as clean
        # even though zero papers came out of it. A few skipped items beside
        # papers that DID survive is routine upstream noise (D-1) and stays
        # clean either way.
        total = len(results)
        unusable = dropped + skipped
        if dropped:
            unreadable = f"{dropped} of {total} papers unreadable"
            if skipped:
                unreadable += f" ({skipped} further skipped: blank title/unparseable date)"
        elif not papers and unusable > 0:
            unreadable = (
                f"{skipped} of {total} papers skipped (blank title or "
                "unparseable date); no paper survived this page"
            )
        else:
            unreadable = None
        # A full page is evidence of a cut window only while it could be read: a
        # page whose whole content was dropped is an incomplete keyword
        # (`unreadable`), not a search that filled out and stopped. Skipped-only
        # items do not affect this — a full raw page still means more results
        # exist, even if some items on it were upstream noise (D-1).
        page_is_full = dropped == 0 and max_results > 0 and len(results) >= limit
        return papers, page_is_full, unreadable

    def _to_paper(
        self, item: dict[str, Any], matched_kw: str, since_date: date
    ) -> Paper | None:
        """Returns ``None`` for a legitimate date-window exclusion; RAISES
        ``_UnusableRecordError`` for an unreadable record (no parseable publication
        date, or no title) — an upstream data-quality artifact (D-1), not a
        shape error. See OpenAlexSource._to_paper for why the two must not share
        a bare ``None``, and for why this is a narrower exception than the
        generic shape errors `_search`'s broad ``except Exception`` still
        counts as `dropped`.
        """
        pub = self._parse_pub_date(item)
        if pub is None:
            raise _UnusableRecordError("s2 item has no parseable publication date")
        if pub < since_date:
            return None  # legitimate filter: outside the requested window

        title = (item.get("title") or "").strip()
        if not title:
            raise _UnusableRecordError("s2 item has no title")

        external = item.get("externalIds") or {}
        arxiv_id = external.get("ArXiv")
        doi = external.get("DOI")

        open_access = item.get("openAccessPdf") or {}
        pdf_url = open_access.get("url") if isinstance(open_access, dict) else None

        authors_raw = item.get("authors") or []
        authors = [a.get("name") for a in authors_raw if a and a.get("name")]
        # Match CitationSignal's semantics (authors[0], not "any author with
        # an id") so both paths agree on what "first author" means.
        first_author_id = (authors_raw[0] or {}).get("authorId") if authors_raw else None

        url = item.get("url") or f"https://www.semanticscholar.org/paper/{item.get('paperId')}"

        return Paper(
            title=title,
            authors=authors,
            abstract=(item.get("abstract") or "").strip(),
            url=url,
            published_date=pub,
            source=self.name,
            arxiv_id=arxiv_id,
            doi=doi,
            pdf_url=pdf_url,
            categories=[],  # S2 does not expose arXiv categories
            comment=None,
            venue=item.get("venue") or None,
            matched_keywords=[matched_kw],
            first_author_id=first_author_id,
        )

    @staticmethod
    def _parse_pub_date(item: dict[str, Any]) -> date | None:
        pub_str = item.get("publicationDate")
        if pub_str:
            try:
                return datetime.strptime(pub_str, "%Y-%m-%d").date()
            except ValueError:
                pass
        year = item.get("year")
        if year:
            try:
                return date(int(year), 1, 1)
            except (TypeError, ValueError):
                return None
        return None
