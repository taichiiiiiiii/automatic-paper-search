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
# `authorId` is not decorative: enrich_batch keys its answer by payload["authorId"],
# so a field list without it returns entries that cannot be matched back to a paper.
# Those papers' author_score stays 0.0, but enrich_batch records the loss in
# run_failures (M-1) instead of letting it look like a quiet 200 OK run.
FIELDS = "authorId,name,hIndex,citationCount"
H_INDEX_SATURATION = 50.0


class AuthorSignal(AbstractSignal):
    name = "author"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._api_key = api_key

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        self.reset_run_failures()
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
                # Fail-safe: the chunk's h-indexes are gone and those papers
                # keep author_score 0.0. _post_batch recorded the loss.
                continue
            if len(data) < len(chunk):
                # The batch answers one entry per id (null for unknown ids), so a
                # short body means the tail ids were never answered and their
                # papers keep author_score 0.0 for a reason unrelated to the
                # author — the same loss CitationSignal records (H-2/M-4).
                self.run_failures.append(
                    f"batch answered {len(data)} of {len(chunk)} ids"
                )
            unmatched = 0
            missing_h_index = 0
            for payload in data:
                if not payload:
                    # A null entry is a definitive "author not found" answer for
                    # that id, not a failure — do not count it below.
                    continue
                aid = payload.get("authorId")
                if not (isinstance(aid, str) and aid.strip()):
                    # A non-null payload with no usable authorId (missing, blank,
                    # or not a string) can never be matched back to a paper, so
                    # that paper's author_score silently stays 0.0 unless this is
                    # recorded (M-1) — otherwise it reads identical to a clean,
                    # fully-answered batch.
                    unmatched += 1
                    continue
                if "hIndex" not in payload:
                    # L-3: a missing key is not an answer. An explicit
                    # `"hIndex": null` is a legitimate 0 (`payload.get("hIndex")
                    # or 0` below), but a key that was never returned must not
                    # read the same way — otherwise it silently looks like a
                    # confirmed h-index of 0 instead of a lost lookup.
                    missing_h_index += 1
                    continue
                h_by_id[aid] = int(payload.get("hIndex") or 0)
            if unmatched:
                self.run_failures.append(
                    f"batch returned {unmatched} of {len(chunk)} entries "
                    "without a usable authorId"
                )
            if missing_h_index:
                self.run_failures.append(
                    f"batch returned {missing_h_index} of {len(chunk)} entries "
                    "without a usable hIndex"
                )

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
            status = getattr(resp, "status_code", None)
            logger.warning(
                "author: batch failed (status=%s, n=%d)",
                status,
                len(ids),
            )
            self.run_failures.append(
                f"/author/batch failed (status={status}, n={len(ids)})"
            )
            return None
        body = resp.json()
        if not isinstance(body, list):
            logger.warning("author: unexpected response shape: %r", type(body))
            self.run_failures.append(
                f"/author/batch returned {type(body).__name__} instead of a list "
                f"(n={len(ids)})"
            )
            return None
        return body
