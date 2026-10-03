"""OpenAlex source (third Source plugin).

Uses the OpenAlex `/works` endpoint. Abstracts arrive as an inverted
index (token -> [positions]); we rehydrate them back to plain text.

Auth: no API key needed. Supplying a contact email puts requests into
the "polite pool" which is more reliable under load.
API: https://api.openalex.org
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

OPENALEX_BASE = "https://api.openalex.org"
_DOI_PREFIX = "https://doi.org/"


class _UnusableRecordError(ValueError):
    """A work item that is well-formed JSON but carries no usable content — a
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


class OpenAlexSource(AbstractSource):
    name = "openalex"

    def __init__(self, config: dict, email: str | None = None) -> None:
        super().__init__(config)
        delay = float(self.config.get("delay_seconds", 1.0))
        self._limiter = RateLimiter(delay)
        self._email = email
        # Keywords whose last fetch filled the whole requested page, so matching
        # papers beyond it were never fetched. Reset by every fetch(); gathered by
        # PipelineRunner into the run result, which the CLI prints and run_history
        # records (same channel as ArxivSource.truncated_keywords).
        self.truncated_keywords: list[str] = []
        # Keywords whose last fetch is known INCOMPLETE: the request failed, the
        # body could not be read, or some of the works on it could not. Those
        # works are absent while the surviving keywords still ship, so Stage 0
        # honestly records ok=True and the loss is invisible unless the source
        # names it — `(keyword, reason)` per keyword, the same channel as
        # ArxivSource.degraded_keywords, which PipelineRunner turns into
        # `source:openalex: incomplete keyword ...`. Reset by every fetch().
        self.degraded_keywords: list[tuple[str, str]] = []

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        papers: list[Paper] = []
        failures: list[str] = []
        truncated: list[str] = []
        degraded: list[tuple[str, str]] = []
        self.truncated_keywords = []
        self.degraded_keywords = []
        for kw in keywords:
            self._limiter.wait()
            try:
                batch, page_is_full, unreadable = self._search(
                    kw, since_date, max_results
                )
            except Exception as e:
                # Fail-safe: one keyword's response containing unexpected
                # data (beyond what per-work-item handling in _search
                # already tolerates) must not abort the other keywords. The
                # keyword that did fail is named with its reason so a partial
                # answer cannot be read as a complete one (HIGH-1, same channel
                # as ArxivSource).
                logger.warning("openalex: keyword '%s' failed unexpectedly: %s", kw, e)
                failures.append(kw)
                degraded.append((kw, f"{type(e).__name__}: {e}"))
                continue
            logger.info("openalex: keyword '%s' returned %d papers", kw, len(batch))
            if unreadable:
                # The readable papers of this keyword still ship — the loss is
                # item-level, not page-level — but the works that could not be
                # read are gone from this keyword's answer, so it is incomplete
                # the same way a failed request is, and named the same way.
                degraded.append((kw, unreadable))
            if page_is_full:
                truncated.append(kw)
                logger.warning(
                    "openalex: keyword '%s' filled the whole %d-result page, so "
                    "the matching papers the endpoint had beyond it were never "
                    "fetched",
                    kw,
                    min(max_results, 200),
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
            # path (stage_collect.py) records sources_status["openalex"]
            # ["ok"] = False, rather than a misleadingly-successful empty
            # result (same masking pattern fixed for arxiv/S2 in #387).
            raise RuntimeError(
                f"openalex fetch failed for all {len(keywords)} keyword(s)"
            )

        logger.info("openalex: collected %d papers (pre-dedup)", len(papers))
        return papers

    # ---- helpers ----

    def _search(
        self, keyword: str, since_date: date, max_results: int
    ) -> tuple[list[Paper], bool, str | None]:
        """Returns `(papers, page_is_full, unreadable)`.

        `page_is_full` is True when the endpoint handed back as many works as
        the requested `per-page` — it had at least one more match inside the
        date filter that this single page never fetched, so the keyword's answer
        is known-partial rather than complete. It is only that when the page
        could be read at all; see `unreadable`.

        `unreadable` is None unless the page is degraded: either a genuine shape
        error dropped at least one item (`dropped > 0`, same as before — a
        `"<N> of <M> works unreadable"` note), or NO paper survived the page at
        all while at least one item was skipped/dropped (MEDIUM-1: a page can
        have zero papers purely because every item was outside the date window,
        which is a correct filter, not an unreadable page — so the degrade check
        is `not papers and unusable > 0`, not "every item was unusable", which
        wrongly counted legitimate date exclusions toward "every item" and let a
        page with one unusable record beside them read as clean). A blank title
        or unparseable date among otherwise-good items (i.e. at least one paper
        did survive) is upstream noise — it is logged and counted as `skipped`,
        not `dropped`, and does NOT degrade the keyword by itself.
        """
        per_page = min(max_results, 200)
        params: dict[str, Any] = {
            "search": keyword,
            "per-page": per_page,
            "filter": f"from_publication_date:{since_date.isoformat()}",
            "sort": "publication_date:desc",
        }
        if self._email:
            params["mailto"] = self._email

        resp = request_with_retry(
            "GET", f"{OPENALEX_BASE}/works", params=params
        )
        if resp is None or resp.status_code != 200:
            status = getattr(resp, "status_code", None)
            logger.warning("openalex: search failed for '%s' (status=%s)", keyword, status)
            raise RuntimeError(f"openalex search failed for '{keyword}' (status={status})")
        data = resp.json() or {}
        if not isinstance(data, dict):
            # A body this code cannot read is an answer the run does not have,
            # not an empty one. Without this check `data.get` raised
            # AttributeError and fetch()'s broad handler logged it as an
            # "unexpected" keyword failure instead of a changed response shape.
            raise RuntimeError(
                f"openalex search for '{keyword}' returned {type(data).__name__} "
                "instead of an object"
            )
        results = data.get("results")
        if not isinstance(results, list):
            # `or []` here used to turn a 200 whose body lost the `results` list
            # into a successful 0-paper keyword.
            raise RuntimeError(
                f"openalex search for '{keyword}' has no 'results' list "
                f"(got {type(results).__name__})"
            )

        papers: list[Paper] = []
        dropped = 0
        skipped = 0
        for work in results:
            try:
                paper = self._to_paper(work, keyword, since_date)
            except _UnusableRecordError as e:
                # D-1: a blank title or unparseable date is an upstream
                # data-quality artifact, not a fetch failure — counted
                # separately from `dropped` so it does not, by itself, turn
                # this keyword's whole page red.
                skipped += 1
                logger.warning(
                    "openalex: skipping unusable work item for '%s': %s", keyword, e
                )
                continue
            except Exception as e:
                # Fail-safe: a genuine SHAPE error anywhere in a single work
                # item (non-dict item, bad authorships/ids/etc., not just the
                # abstract index) must not abort the rest of the batch.
                dropped += 1
                logger.warning(
                    "openalex: skipping malformed work item for '%s': %s", keyword, e
                )
                continue
            if paper is not None:
                papers.append(paper)

        # Skipping is not answering. Without this count a page whose items were
        # all unreadable returned [] and raised nothing, so the keyword read as
        # a clean 0 while the works the endpoint actually had stayed uncollected.
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
            unreadable = f"{dropped} of {total} works unreadable"
            if skipped:
                unreadable += f" ({skipped} further skipped: blank title/unparseable date)"
        elif not papers and unusable > 0:
            unreadable = (
                f"{skipped} of {total} works skipped (blank title or "
                "unparseable date); no paper survived this page"
            )
        else:
            unreadable = None
        # A full page is evidence of a cut window only while it could be read: a
        # page whose whole content was dropped is an incomplete keyword
        # (`unreadable`), not a survey that filled out and stopped. Skipped-only
        # items do not affect this — a full raw page still means more results
        # exist, even if some items on it were upstream noise (D-1).
        page_is_full = (
            dropped == 0 and max_results > 0 and len(results) >= per_page
        )
        return papers, page_is_full, unreadable

    def _to_paper(
        self, work: dict[str, Any], matched_kw: str, since_date: date
    ) -> Paper | None:
        """Returns ``None`` for a legitimate date-window exclusion; RAISES
        ``_UnusableRecordError`` for an unreadable record (no parseable publication
        date, or no title) -- an upstream data-quality artifact (D-1), not a
        shape error.

        The two look identical as a bare ``None`` return, but they are not the same
        kind of absence: a work published before ``since_date`` is a correct filter
        decision and must not count against the keyword, while a work this code
        could not even date or title is a record the run lost. Raising
        ``_UnusableRecordError`` routes it through `_search`'s dedicated catch clause
        (counted as `skipped`, D-1) instead of a second, silent kind of "filtered
        out" that neither `dropped` nor `skipped` would ever see. This is
        deliberately NARROWER than the generic shape errors (non-dict item,
        AttributeError from an unexpected field type, ...) the broad ``except
        Exception`` in `_search`'s loop still counts as `dropped` -- those
        indicate a changed RESPONSE SHAPE the run needs to see, while a blank
        title or unparseable date on an otherwise well-formed item is routine
        upstream noise.
        """
        pub = self._parse_pub_date(work)
        if pub is None:
            raise _UnusableRecordError("openalex work item has no parseable publication date")
        if pub < since_date:
            return None  # legitimate filter: outside the requested window

        title = (work.get("title") or work.get("display_name") or "").strip()
        if not title:
            raise _UnusableRecordError("openalex work item has no title")

        abstract = self._rehydrate_abstract(work.get("abstract_inverted_index"))

        # DOI normalization: strip the `https://doi.org/` prefix.
        doi_raw = work.get("doi") or (work.get("ids") or {}).get("doi")
        doi = doi_raw[len(_DOI_PREFIX):] if isinstance(doi_raw, str) and doi_raw.startswith(_DOI_PREFIX) else doi_raw

        authorships = work.get("authorships") or []
        authors = [
            a.get("author", {}).get("display_name")
            for a in authorships
            if a.get("author", {}).get("display_name")
        ]
        # Affiliations: flatten institutions across all authorships, dedup.
        affiliations: list[str] = []
        seen_aff: set[str] = set()
        for auth in authorships:
            for inst in auth.get("institutions") or []:
                name = inst.get("display_name") if isinstance(inst, dict) else None
                if name and name not in seen_aff:
                    seen_aff.add(name)
                    affiliations.append(name)

        # OpenAlex deprecated `host_venue` in 2023 in favor of
        # `primary_location.source.display_name`. Try the new field first,
        # then fall back to the legacy one for older fixtures.
        primary = work.get("primary_location") or {}
        primary_source = primary.get("source") or {}
        venue = primary_source.get("display_name")
        if not venue:
            venue = (work.get("host_venue") or {}).get("display_name")

        open_access = work.get("open_access") or {}
        pdf_url = open_access.get("oa_url") if isinstance(open_access, dict) else None

        url = work.get("id") or ""

        return Paper(
            title=title,
            authors=authors,
            abstract=abstract,
            url=url,
            published_date=pub,
            source=self.name,
            doi=doi,
            pdf_url=pdf_url,
            categories=[],
            comment=None,
            affiliations=affiliations,
            venue=venue or None,
            matched_keywords=[matched_kw],
        )

    @staticmethod
    def _parse_pub_date(work: dict[str, Any]) -> date | None:
        pub_str = work.get("publication_date")
        if pub_str:
            try:
                return datetime.strptime(pub_str, "%Y-%m-%d").date()
            except ValueError:
                pass
        year = work.get("publication_year")
        if year:
            try:
                return date(int(year), 1, 1)
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _rehydrate_abstract(inverted: dict[str, list[int]] | None) -> str:
        """Rehydrate the inverted index to plain text.

        Malformed upstream data may assign the same position to multiple
        tokens; keep last-writer-wins so the abstract length stays bounded
        even in that degenerate case.

        Fail-safe, but conservative: if the abstract_inverted_index contains
        ANY malformed entry (non-string token, non-list positions, non-
        integer/negative/bool position), the entire abstract degrades to ""
        (an already-supported "no abstract" state used throughout the
        pipeline — see e.g. AbstractLLMProvider's `(abstract or "")`)
        rather than a silently partial abstract with tokens dropped. A
        silently incomplete abstract is more dangerous than an explicitly
        missing one: keyword scoring, exclusion filtering, embedding
        ranking, and LLM prompting all treat `paper.abstract` as
        authoritative text, and dropping the wrong token (e.g. "not") could
        invert the intended meaning without any signal that it happened.
        The paper itself is still kept — only the abstract is cleared —
        since title/authors/venue/etc. are unaffected by this field.
        """
        if not inverted or not isinstance(inverted, dict):
            return ""
        pos_to_token: dict[int, str] = {}
        for token, indices in inverted.items():
            if not isinstance(token, str):
                logger.warning(
                    "openalex: malformed abstract_inverted_index token key "
                    "%r (expected str); discarding whole abstract",
                    token,
                )
                return ""
            if not isinstance(indices, list):
                logger.warning(
                    "openalex: malformed abstract_inverted_index positions for "
                    "token %r (expected a list, got %s); discarding whole abstract",
                    token,
                    type(indices).__name__,
                )
                return ""
            for idx in indices:
                # bool is a subclass of int in Python; exclude it explicitly
                # since a boolean isn't a meaningful token position.
                if isinstance(idx, bool) or not isinstance(idx, int) or idx < 0:
                    logger.warning(
                        "openalex: malformed abstract_inverted_index position "
                        "%r for token %r; discarding whole abstract",
                        idx,
                        token,
                    )
                    return ""
                pos_to_token[idx] = token
        return " ".join(pos_to_token[i] for i in sorted(pos_to_token))
