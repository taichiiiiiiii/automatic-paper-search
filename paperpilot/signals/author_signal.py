"""Author signal via Semantic Scholar /author/batch (design doc §4.3).

Reads `paper.first_author_id` (populated by CitationSignal or by
S2Source) and fetches h-index in a single batch call per 1000 IDs.

Normalization (design doc Table 12):
  author_score = min(h_index / 50, 1) * 100
"""

from __future__ import annotations

from typing import Any

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from .base import AbstractSignal

logger = get_logger(__name__)

S2_AUTHOR_BATCH_URL = "https://api.semanticscholar.org/graph/v1/author/batch"
BATCH_SIZE = 1000
FIELDS = "name,hIndex,citationCount"
H_INDEX_SATURATION = 50.0


class AuthorSignal(AbstractSignal):
    name = "author"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        # Collect unique author IDs we can query.
        to_fetch: list[tuple[Paper, str]] = []
        unique_ids: list[str] = []
        seen: set[str] = set()
        for p in papers:
            if not p.first_author_id:
                continue
            to_fetch.append((p, p.first_author_id))
            if p.first_author_id not in seen:
                seen.add(p.first_author_id)
                unique_ids.append(p.first_author_id)
        if not unique_ids:
            return papers

        h_by_id: dict[str, int] = {}
        for chunk_start in range(0, len(unique_ids), BATCH_SIZE):
            chunk = unique_ids[chunk_start : chunk_start + BATCH_SIZE]
            data = self._post_batch(chunk)
            if data is None:
                continue
            for payload in data:
                if not payload:
                    continue
                aid = payload.get("authorId")
                if aid:
                    h_by_id[aid] = int(payload.get("hIndex") or 0)

        for paper, aid in to_fetch:
            h = h_by_id.get(aid)
            if h is None:
                continue
            paper.author_h_index = h
            paper.author_score = float(min(h / H_INDEX_SATURATION, 1.0) * 100.0)
        return papers

    def enrich_one(self, paper: Paper) -> Paper:
        return self.enrich_batch([paper])[0] if paper else paper

    # ---- helpers ----

    def _post_batch(self, ids: list[str]) -> list[dict[str, Any] | None] | None:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        resp = request_with_retry(
            "POST",
            S2_AUTHOR_BATCH_URL,
            params={"fields": FIELDS},
            headers=headers,
            json_body={"ids": ids},
            timeout=15.0,
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "author: batch failed (status=%s, n=%d)",
                getattr(resp, "status_code", None),
                len(ids),
            )
            return None
        body = resp.json()
        if not isinstance(body, list):
            logger.warning("author: unexpected response shape: %r", type(body))
            return None
        return body
