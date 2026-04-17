"""GitHub Stars signal via Papers with Code lookup.

Flow per paper:
  arxiv_id -> Papers with Code API -> github URL -> GitHub API -> stars

Star score (design doc §4.3, Table 12):
  score = log(stars + 1) / log(MAX_STARS + 1) * 100
  with MAX_STARS = 10000

Both APIs are rate limited; we stop after `max_lookups` to keep runs
fast. Failures degrade silently (score stays 0).
"""

from __future__ import annotations

import math

from ..models import Paper
from ..utils.http import request_with_retry
from ..utils.logger import get_logger
from .base import AbstractSignal

logger = get_logger(__name__)

PWC_BASE = "https://paperswithcode.com/api/v1"
GH_API = "https://api.github.com"
TIMEOUT = 10
MAX_STARS = 10_000
_LOG_DENOM = math.log(MAX_STARS + 1)


def _stars_to_score(stars: int) -> float:
    """Logarithmic normalization to [0, 100]. Stars > MAX_STARS cap at 100."""
    if stars <= 0:
        return 0.0
    s = min(stars, MAX_STARS)
    return math.log(s + 1) / _LOG_DENOM * 100.0


class GitHubSignal(AbstractSignal):
    name = "github"

    def __init__(self, config: dict, github_token: str | None = None) -> None:
        super().__init__(config)
        self.max_lookups = int(self.config.get("max_lookups", 50))
        self._gh_headers = {"Accept": "application/vnd.github+json"}
        if github_token:
            self._gh_headers["Authorization"] = f"Bearer {github_token}"

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        # Rank-order matters: high-score-so-far papers get the lookup budget first.
        ordered = sorted(
            papers,
            key=lambda p: p.venue_score + p.keyword_score,
            reverse=True,
        )
        budget = self.max_lookups
        for p in ordered:
            if budget <= 0:
                break
            if not p.arxiv_id:
                continue
            self.enrich_one(p)
            budget -= 1
        return papers

    def enrich_one(self, paper: Paper) -> Paper:
        if not paper.arxiv_id:
            return paper
        try:
            result = self._lookup(paper.arxiv_id)
        except Exception as e:
            logger.debug("github lookup failed for %s: %s", paper.arxiv_id, e)
            return paper

        if result is None:
            return paper
        gh_url, stars, is_official = result
        if gh_url:
            paper.github_url = gh_url
            paper.github_stars = stars
            paper.github_score = _stars_to_score(stars)
            paper.has_code = True
            paper.is_official_repo = is_official
        return paper

    # ---- helpers ----

    def _lookup(self, arxiv_id: str) -> tuple[str | None, int, bool] | None:
        """Resolve arxiv_id -> (github_url, stars, is_official) via Papers with Code."""
        # Step 1: PwC paper lookup
        r = request_with_retry(
            "GET", f"{PWC_BASE}/papers/", params={"arxiv_id": arxiv_id}, timeout=TIMEOUT
        )
        if r is None or r.status_code != 200:
            return None
        results = (r.json() or {}).get("results") or []
        if not results:
            return None
        pwc_id = results[0].get("id")
        if not pwc_id:
            return None

        # Step 2: PwC repositories
        r = request_with_retry(
            "GET", f"{PWC_BASE}/papers/{pwc_id}/repositories/", timeout=TIMEOUT
        )
        if r is None or r.status_code != 200:
            return None
        repos = (r.json() or {}).get("results") or []
        if not repos:
            return None

        # Prefer the official repo, fall back to highest-starred.
        repos.sort(
            key=lambda r: (bool(r.get("is_official")), int(r.get("stars") or 0)),
            reverse=True,
        )
        best = repos[0]
        gh_url = best.get("url")
        stars = int(best.get("stars") or 0)
        is_official = bool(best.get("is_official"))

        # Step 3: refresh stars from GitHub directly (PwC stars can be stale).
        fresh = self._fetch_github_stars(gh_url)
        if fresh is not None:
            stars = fresh
        return gh_url, stars, is_official

    def _fetch_github_stars(self, repo_url: str | None) -> int | None:
        if not repo_url or "github.com" not in repo_url:
            return None
        parts = repo_url.rstrip("/").split("github.com/", 1)[-1].split("/")
        if len(parts) < 2:
            return None
        owner, repo = parts[0], parts[1].replace(".git", "")
        r = request_with_retry(
            "GET",
            f"{GH_API}/repos/{owner}/{repo}",
            headers=self._gh_headers,
            timeout=TIMEOUT,
        )
        if r is None or r.status_code != 200:
            return None
        return int((r.json() or {}).get("stargazers_count") or 0)
