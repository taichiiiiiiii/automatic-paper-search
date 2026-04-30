"""GitHub Stars signal via curated map + GitHub Search.

Flow per paper (Stage 2 of the pipeline):

    arxiv_id -> curated map ('owner/repo')
                  ↓ miss
                title -> GitHub /search/repositories
                  ↓ no high-similarity hit
                None  ← skip, signal stays at 0

    repo_full   -> GitHub /repos/{owner}/{repo} -> stargazers_count
                -> log-scaled to [0, 100]

History: this signal used to call Papers with Code (`PWC_BASE`) for the
arxiv_id → owner/repo translation. PwC was permanently shut down in
2026 and now 302-redirects to huggingface.co/papers/trending. PR for
issue #92 replaces the PwC chain with the same curated + search
resolvers used by the theme family-tree builder, both consuming
``paperpilot/utils/github`` so the SSRF / path-traversal hardening
lives in one place.

Star score (design doc §4.3, Table 12):

    score = log(stars + 1) / log(MAX_STARS + 1) * 100
    with MAX_STARS = 10000

Budget semantics:
    ``max_lookups`` caps the number of *papers* attempted. Each
    resolved paper issues 1 GitHub API call when the curated map hits
    and 2 calls when the search fallback runs (search + repo fetch).
    Worst case: ``max_lookups * 2`` HTTP calls — still well inside the
    5000/h authenticated PAT limit. Papers missing arxiv_id are skipped
    without charging the budget so the top-scoring papers always get a
    lookup.

``is_official`` is set to True only for curated entries (the
``paperpilot/data/paper_repos.json`` map is hand-curated to point at
the canonical author-affiliated repository). Search-fallback hits are
treated as best-effort matches and stay non-official.

Failures degrade silently (score stays 0) — the pipeline continues so a
GitHub outage never blocks Stage 2.
"""

from __future__ import annotations

import math

from ..models import Paper
from ..utils.github import fetch_repo_stars, load_curated_map, search_repo_by_title
from ..utils.logger import get_logger
from .base import AbstractSignal

logger = get_logger(__name__)

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
        self._github_token = github_token
        # Loaded once per signal instance — paper_repos.json is small
        # (~30 entries today, dozens at most expected) so a per-call
        # read would be wasteful, but reloading per pipeline run is
        # important so curated map updates take effect on the next run.
        self._curated = load_curated_map()

    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        # Rank-order matters: high-score-so-far papers get the lookup
        # budget first. With curated + search the per-paper cost is
        # roughly even (1–2 HTTP calls), but the prioritisation still
        # protects coverage of the most promising papers under tight
        # budgets.
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
        # Fail-Safe (CLAUDE.md absolute rule §10): a single hiccup must
        # not break the rest of the batch. Network errors are already
        # absorbed inside the helpers (they return None), so an
        # exception here implies a logic bug worth a WARNING — louder
        # than the pre-#92 DEBUG level so regressions surface in CI logs.
        try:
            result = self._lookup(paper.arxiv_id, paper.title)
        except Exception as e:
            # exc_info=True emits the full traceback at WARNING level
            # so a logic bug (TypeError / AttributeError) is
            # distinguishable from a transient network blip when
            # grepping CI logs.
            logger.warning(
                "github lookup failed for %s: %s",
                paper.arxiv_id, e, exc_info=True,
            )
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

    def _lookup(
        self, arxiv_id: str, title: str | None
    ) -> tuple[str | None, int, bool] | None:
        """Resolve arxiv_id (+ title fallback) -> (github_url, stars, is_official).

        Curated entries are treated as ``is_official=True`` because the
        map is hand-maintained to point at the canonical author repo.
        Search-fallback hits are best-effort matches and stay non-official.
        """
        # 1. Curated map (authoritative).
        repo_full: str | None = self._curated.get(arxiv_id)
        is_official = bool(repo_full)

        # 2. GitHub Search fallback when the curated map misses.
        if not repo_full:
            repo_full = search_repo_by_title(
                title or "", github_token=self._github_token
            )
        if not repo_full:
            return None

        stars = fetch_repo_stars(repo_full, github_token=self._github_token)
        if stars is None or stars <= 0:
            return None
        return f"https://github.com/{repo_full}", stars, is_official
