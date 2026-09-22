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


class OpenAlexSource(AbstractSource):
    name = "openalex"

    def __init__(self, config: dict, email: str | None = None) -> None:
        super().__init__(config)
        delay = float(self.config.get("delay_seconds", 1.0))
        self._limiter = RateLimiter(delay)
        self._email = email

    def fetch(
        self,
        keywords: list[str],
        categories: list[str],
        since_date: date,
        max_results: int,
    ) -> list[Paper]:
        papers: list[Paper] = []
        failures: list[str] = []
        for kw in keywords:
            self._limiter.wait()
            try:
                batch = self._search(kw, since_date, max_results)
            except Exception as e:
                # Fail-safe: one keyword's response containing unexpected
                # data (beyond what per-work-item handling in _search
                # already tolerates) must not abort the other keywords.
                logger.warning("openalex: keyword '%s' failed unexpectedly: %s", kw, e)
                failures.append(kw)
                continue
            logger.info("openalex: keyword '%s' returned %d papers", kw, len(batch))
            papers.extend(batch)

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
    ) -> list[Paper]:
        params: dict[str, Any] = {
            "search": keyword,
            "per-page": min(max_results, 200),
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
        results = data.get("results") or []

        papers: list[Paper] = []
        for work in results:
            try:
                paper = self._to_paper(work, keyword, since_date)
            except Exception as e:
                # Fail-safe: an unexpected shape anywhere in a single work
                # item (bad title/date/authorships/ids/etc., not just the
                # abstract index) must not abort the rest of the batch.
                logger.warning(
                    "openalex: skipping malformed work item for '%s': %s", keyword, e
                )
                continue
            if paper is not None:
                papers.append(paper)
        return papers

    def _to_paper(
        self, work: dict[str, Any], matched_kw: str, since_date: date
    ) -> Paper | None:
        pub = self._parse_pub_date(work)
        if pub is None or pub < since_date:
            return None

        title = (work.get("title") or work.get("display_name") or "").strip()
        if not title:
            return None

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
