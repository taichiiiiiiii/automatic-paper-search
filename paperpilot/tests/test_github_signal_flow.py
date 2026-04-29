"""GitHubSignal — full lookup flow tests for the curated + search path.

Issue #92: this signal used to chain Papers with Code → GitHub stars,
but PwC was shut down in 2026. The new flow is curated map →
GitHub Search by title (fallback) → GitHub stars, with the resolvers
shared via ``paperpilot/utils/github``. Tests below mock the shared
resolvers so we can exercise the orchestration logic without touching
the network.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.github_signal import GitHubSignal


def _mk_paper(
    arxiv_id: str | None = "2604.001",
    *,
    title: str = "Some Title",
    uid_suffix: str = "1",
) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url=f"http://x/{uid_suffix}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=arxiv_id,
    )


# ---------- enrich_one ----------


def test_enrich_one_no_arxiv_id_noop():
    paper = _mk_paper(arxiv_id=None)
    with patch.object(GitHubSignal, "_lookup") as mock_lookup:
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
        mock_lookup.assert_not_called()
    assert paper.github_url is None
    assert paper.has_code is False


def test_enrich_one_curated_hit_marks_official():
    """A paper whose arxiv_id is in paper_repos.json gets is_official=True."""
    paper = _mk_paper(arxiv_id="1706.03762", title="Attention Is All You Need")
    sig = GitHubSignal({"enabled": True})
    sig._curated = {"1706.03762": "tensorflow/tensor2tensor"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        return_value=42_000,
    ) as mock_fetch, patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
    ) as mock_search:
        sig.enrich_one(paper)
        # Search must NOT be invoked when curated hits.
        mock_search.assert_not_called()
        mock_fetch.assert_called_once_with(
            "tensorflow/tensor2tensor", github_token=None
        )
    assert paper.github_url == "https://github.com/tensorflow/tensor2tensor"
    assert paper.github_stars == 42_000
    assert paper.has_code is True
    assert paper.is_official_repo is True
    assert paper.github_score > 0


def test_enrich_one_search_fallback_marks_non_official():
    """When the curated map misses, search-resolved repos are best-effort."""
    paper = _mk_paper(arxiv_id="9999.99", title="A Paper Not In The Curated Map")
    sig = GitHubSignal({"enabled": True})
    sig._curated = {}  # explicit empty so the search path runs

    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        return_value="someone/their-repo",
    ), patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        return_value=123,
    ):
        sig.enrich_one(paper)

    assert paper.github_url == "https://github.com/someone/their-repo"
    assert paper.github_stars == 123
    assert paper.is_official_repo is False  # search hits are non-official
    assert paper.has_code is True


def test_enrich_one_search_miss_keeps_unenriched():
    """No curated hit and no search hit must leave the paper untouched."""
    paper = _mk_paper(arxiv_id="9999.99", title="A Paper")
    sig = GitHubSignal({"enabled": True})
    sig._curated = {}
    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        return_value=None,
    ), patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
    ) as mock_fetch:
        sig.enrich_one(paper)
        mock_fetch.assert_not_called()
    assert paper.github_url is None
    assert paper.has_code is False


def test_enrich_one_zero_stars_keeps_unenriched():
    """A repo with 0 stars (private/deleted/new) must not pollute the
    paper with a fake github_url — leave it unenriched."""
    paper = _mk_paper(arxiv_id="9999.99", title="A Paper")
    sig = GitHubSignal({"enabled": True})
    sig._curated = {"9999.99": "owner/empty-repo"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        return_value=0,
    ):
        sig.enrich_one(paper)
    assert paper.github_url is None
    assert paper.has_code is False


def test_enrich_one_fetch_failure_keeps_unenriched():
    """fetch_repo_stars returning None (network error / 404) is handled."""
    paper = _mk_paper(arxiv_id="9999.99", title="A Paper")
    sig = GitHubSignal({"enabled": True})
    sig._curated = {"9999.99": "owner/repo"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        return_value=None,
    ):
        sig.enrich_one(paper)
    assert paper.github_url is None


def test_enrich_one_swallows_exceptions():
    """Any exception in the lookup chain must degrade silently — the
    pipeline must not crash because GitHub had a hiccup."""
    paper = _mk_paper()
    sig = GitHubSignal({"enabled": True})
    sig._curated = {"2604.001": "owner/repo"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        side_effect=RuntimeError("network down"),
    ):
        sig.enrich_one(paper)
    assert paper.github_url is None


# ---------- enrich_batch ----------


def test_enrich_batch_respects_max_lookups():
    """High-scoring papers must be prioritised when the budget is tight."""
    papers = [
        _mk_paper(
            arxiv_id=f"2604.00{i}",
            title=f"Paper {i}",
            uid_suffix=str(i),
        )
        for i in range(5)
    ]
    for i, p in enumerate(papers):
        p.keyword_score = float(i * 10)  # p4 highest, p0 lowest

    sig = GitHubSignal({"enabled": True, "max_lookups": 2})
    sig._curated = {}  # force the search path so we can count calls

    looked_up_titles: list[str] = []

    def _track_search(title, *, github_token=None):
        looked_up_titles.append(title)
        return None  # always miss → cheap path, doesn't call fetch

    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        side_effect=_track_search,
    ):
        sig.enrich_batch(papers)

    # Budget respected — exactly 2 papers attempted
    assert len(looked_up_titles) == 2
    # And the top-2 by venue_score + keyword_score are p4 and p3
    assert "Paper 4" in looked_up_titles
    assert "Paper 3" in looked_up_titles


def test_enrich_batch_skips_papers_without_arxiv_id_for_free():
    """Papers without arxiv_id must not consume the lookup budget so the
    top-scoring papers with arxiv_ids always get attempted."""
    papers = [
        _mk_paper(arxiv_id=None, uid_suffix="0"),
        _mk_paper(arxiv_id="2604.001", uid_suffix="1"),
        _mk_paper(arxiv_id="2604.002", uid_suffix="2"),
    ]
    sig = GitHubSignal({"enabled": True, "max_lookups": 2})
    sig._curated = {}

    looked_up: list[str] = []

    def _track(title, *, github_token=None):
        looked_up.append(title)
        return None

    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        side_effect=_track,
    ):
        sig.enrich_batch(papers)

    # Only the 2 papers with arxiv_id are looked up; the no-arxiv-id one
    # was skipped without charging the budget.
    assert len(looked_up) == 2


# ---------- token plumbing ----------


def test_github_token_passed_to_resolvers():
    """The PAPERPILOT_GITHUB_TOKEN must reach the underlying GitHub
    API calls so the rate limit jumps from 60/h to 5000/h."""
    paper = _mk_paper(arxiv_id="2604.001", title="A Paper Title")
    sig = GitHubSignal({"enabled": True}, github_token="ghp_xyz")
    sig._curated = {}
    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        return_value="owner/repo",
    ) as mock_search, patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        return_value=10,
    ) as mock_fetch:
        sig.enrich_one(paper)
        mock_search.assert_called_once_with("A Paper Title", github_token="ghp_xyz")
        mock_fetch.assert_called_once_with("owner/repo", github_token="ghp_xyz")


# ---------- module hygiene ----------


def test_module_has_no_pwc_references():
    """Issue #92 mandates removing all Papers with Code references from
    the GitHub stars resolution path. Pin the constraint at the module
    level so a copy-paste regression is caught immediately."""
    from pathlib import Path

    from paperpilot.signals import github_signal

    src = Path(github_signal.__file__).read_text()
    # The history mention in the docstring is the only allowed reference.
    body = src.split('"""', 2)[2] if src.count('"""') >= 2 else src
    assert "paperswithcode" not in body.lower()
    assert "PWC_BASE" not in body
