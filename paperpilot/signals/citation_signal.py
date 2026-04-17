"""Citation signal via Semantic Scholar /paper/batch (design doc §4.3.1).

A single batch request can resolve up to 500 papers, so the whole run's
citation lookup typically needs 1 API call. We identify papers by
ARXIV:<id> or DOI:<doi>; papers without either are skipped.

Normalization (design doc §4.3 Table 12):
  citation_velocity = citations / days_since_publication
  citation_score    = min(velocity / SATURATION, 1) * 100
  SATURATION is configurable (default: top-5% cut-off ≈ 2 citations/day)
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from .base import AbstractSignal

logger = get_logger(__name__)

S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
BATCH_SIZE = 500
FIELDS = (
    "paperId,title,citationCount,influentialCitationCount,"
    "publicationDate,year,authors.authorId,authors.name,venue"
)


class CitationSignal(AbstractSignal):
    name = "citation"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key
        self.saturation = float(self.config.get("velocity_saturation", 2.0))

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        # Build index: (paper, request_id) pairs for those we can query.
        indexed: list[tuple[Paper, str]] = []
        for p in papers:
            req_id = self._request_id(p)
            if req_id:
                indexed.append((p, req_id))
        if not indexed:
            return papers

        today = date.today()
        for chunk_start in range(0, len(indexed), BATCH_SIZE):
            chunk = indexed[chunk_start : chunk_start + BATCH_SIZE]
            ids = [rid for _, rid in chunk]
            data = self._post_batch(ids)
            if data is None:
                continue
            # Response preserves order, nulls for missing IDs.
            for (paper, _rid), payload in zip(chunk, data, strict=False):
                if not payload:
                    continue
                self._apply(paper, payload, today)
        return papers

    def enrich_one(self, paper: Paper) -> Paper:
        # Fallback: single-element batch (rarely used).
        return self.enrich_batch([paper])[0] if paper else paper

    # ---- helpers ----

    @staticmethod
    def _request_id(p: Paper) -> str | None:
        if p.arxiv_id:
            return f"ARXIV:{p.arxiv_id}"
        if p.doi:
            return f"DOI:{p.doi}"
        return None

    def _post_batch(self, ids: list[str]) -> list[dict[str, Any] | None] | None:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        resp = request_with_retry(
            "POST",
            S2_BATCH_URL,
            params={"fields": FIELDS},
            headers=headers,
            json_body={"ids": ids},
            timeout=15.0,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "citation: batch failed (status=%s, n=%d)",
                getattr(resp, "status_code", None),
                len(ids),
            )
            return None
        body = resp.json()
        if not isinstance(body, list):
            logger.warning("citation: unexpected response shape: %r", type(body))
            return None
        return body

    def _apply(self, paper: Paper, payload: dict[str, Any], today: date) -> None:
        cites = int(payload.get("citationCount") or 0)
        infl = int(payload.get("influentialCitationCount") or 0)
        paper.citation_count = cites
        paper.influential_citations = infl

        paper.citation_velocity = self._velocity(cites, payload, paper, today)
        if self.saturation > 0:
            paper.citation_score = float(
                min(paper.citation_velocity / self.saturation, 1.0) * 100.0
            )

        if not paper.venue and payload.get("venue"):
            paper.venue = payload["venue"]

        authors = payload.get("authors") or []
        if authors and not paper.first_author_id:
            first = authors[0]
            if first and first.get("authorId"):
                paper.first_author_id = first["authorId"]

    @staticmethod
    def _velocity(cites: int, payload: dict[str, Any], paper: Paper, today: date) -> float:
        if cites <= 0:
            return 0.0
        pub_str = payload.get("publicationDate")
        pub: date | None = None
        if pub_str:
            try:
                from datetime import datetime as _dt

                pub = _dt.strptime(pub_str, "%Y-%m-%d").date()
            except ValueError:
                pub = None
        if pub is None:
            pub = paper.published_date
        # S2 occasionally returns a publicationDate in the future (embargo /
        # timezone glitch). Clamp so velocity never gets artificially inflated
        # by a negative elapsed-days fallthrough.
        if pub > today:
            pub = today
        days = max((today - pub).days, 1)
        return cites / days
