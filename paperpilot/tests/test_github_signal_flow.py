"""GitHubSignal — full lookup flow tests (mocked HTTP)."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.github_signal import GitHubSignal


def _resp(status, body=None):
    return SimpleNamespace(status_code=status, json=lambda: body or {})


def _mk_paper(arxiv_id: str | None = "2604.001", uid_suffix: str = "1") -> Paper:
    return Paper(
        title=f"Paper {uid_suffix}",
        authors=["A"],
        abstract="abs",
        url=f"http://x/{uid_suffix}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=arxiv_id,
    )


def test_enrich_one_no_arxiv_id_noop():
    paper = _mk_paper(arxiv_id=None)
    with patch("paperpilot.signals.github_signal.request_with_retry") as mock:
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
        mock.assert_not_called()
    assert paper.github_url is None
    assert paper.has_code is False


def test_enrich_one_happy_path():
    """PwC paper lookup → repositories → GitHub stars."""
    paper = _mk_paper()
    pwc_paper_resp = _resp(200, {"results": [{"id": "my-paper"}]})
    pwc_repos_resp = _resp(
        200,
        {
            "results": [
                {"url": "https://github.com/someone/repo", "stars": 50, "is_official": False},
                {"url": "https://github.com/official/repo", "stars": 200, "is_official": True},
            ]
        },
    )
    gh_stars_resp = _resp(200, {"stargazers_count": 1500})

    responses = [pwc_paper_resp, pwc_repos_resp, gh_stars_resp]

    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        side_effect=responses,
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)

    # Official repo wins despite lower PwC stars; GitHub API provides fresh count.
    assert paper.github_url == "https://github.com/official/repo"
    assert paper.github_stars == 1500
    assert paper.has_code is True
    assert paper.is_official_repo is True
    assert paper.github_score > 0


def test_enrich_one_pwc_returns_empty():
    paper = _mk_paper()
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        return_value=_resp(200, {"results": []}),
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
    assert paper.github_url is None
    assert paper.has_code is False


def test_enrich_one_pwc_404():
    paper = _mk_paper()
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        return_value=_resp(404),
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
    assert paper.github_url is None


def test_enrich_one_repos_empty_keeps_unenriched():
    paper = _mk_paper()
    responses = [
        _resp(200, {"results": [{"id": "pid"}]}),
        _resp(200, {"results": []}),
    ]
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        side_effect=responses,
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
    assert paper.github_url is None


def test_enrich_one_falls_back_to_pwc_stars_when_github_fails():
    paper = _mk_paper()
    responses = [
        _resp(200, {"results": [{"id": "pid"}]}),
        _resp(200, {"results": [{"url": "https://github.com/a/b", "stars": 30, "is_official": True}]}),
        _resp(500),  # GitHub API fails
    ]
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        side_effect=responses,
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
    assert paper.github_url == "https://github.com/a/b"
    assert paper.github_stars == 30  # PwC value retained


def test_enrich_one_swallows_exceptions():
    paper = _mk_paper()
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        side_effect=RuntimeError("network down"),
    ):
        sig = GitHubSignal({"enabled": True})
        sig.enrich_one(paper)
    assert paper.github_url is None


def test_enrich_batch_respects_max_lookups():
    """High-scoring papers must be prioritized when the budget is tight."""
    papers = [
        _mk_paper(arxiv_id=f"2604.00{i}", uid_suffix=str(i)) for i in range(5)
    ]
    # Populate keyword_score so ordering is deterministic.
    for i, p in enumerate(papers):
        p.keyword_score = float(i * 10)  # p4 highest, p0 lowest

    queried_ids: list[str] = []

    def _tracked(*args, **kwargs):
        params = kwargs.get("params") or {}
        aid = params.get("arxiv_id")
        if aid:
            queried_ids.append(aid)
        return _resp(200, {"results": []})  # PwC returns no match (fast fail)

    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        side_effect=_tracked,
    ):
        sig = GitHubSignal({"enabled": True, "max_lookups": 2})
        sig.enrich_batch(papers)

    # Budget respected — exactly 2 papers looked up
    assert len(queried_ids) == 2
    # Priority check: the 2 highest-scoring papers (p4, p3) got the lookups
    assert set(queried_ids) == {"2604.004", "2604.003"}


def test_fetch_github_stars_extracts_owner_repo():
    sig = GitHubSignal({"enabled": True})
    with patch(
        "paperpilot.signals.github_signal.request_with_retry",
        return_value=_resp(200, {"stargazers_count": 999}),
    ) as mock:
        result = sig._fetch_github_stars("https://github.com/owner/repo.git")
    assert result == 999
    assert "owner/repo" in mock.call_args.args[1]


def test_fetch_github_stars_rejects_non_github_url():
    sig = GitHubSignal({"enabled": True})
    assert sig._fetch_github_stars(None) is None
    assert sig._fetch_github_stars("") is None
    # Non-github hosts
    assert sig._fetch_github_stars("http://gitlab.com/a/b") is None
    # SSRF attempt via substring
    assert sig._fetch_github_stars("http://evil.com/?x=github.com/a/b") is None
    # Path traversal in owner/repo segments
    assert sig._fetch_github_stars("https://github.com/owner/../escape") is None
    assert sig._fetch_github_stars("https://github.com/owner/repo;rm -rf") is None
    # Too-short path
    assert sig._fetch_github_stars("https://github.com/") is None
    assert sig._fetch_github_stars("https://github.com/onlyowner") is None
    # Unsupported scheme
    assert sig._fetch_github_stars("file:///etc/passwd") is None
    assert sig._fetch_github_stars("javascript:alert(1)") is None


def test_github_token_added_to_headers():
    sig = GitHubSignal({"enabled": True}, github_token="ghp_xyz")
    assert sig._gh_headers.get("Authorization") == "Bearer ghp_xyz"
