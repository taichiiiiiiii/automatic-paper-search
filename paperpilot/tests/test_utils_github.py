"""Tests for paperpilot.utils.github — shared GitHub stars resolvers.

The module is imported by both ``paperpilot/scripts/build_theme_lineage.py``
and ``paperpilot/signals/github_signal.py``. Tests cover the primitive
public surface in isolation; integration with each consumer lives in
their respective test files.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from paperpilot.utils import github as gh

# ---------- load_curated_map ----------


def test_load_curated_map_filters_meta_key(tmp_path: Path) -> None:
    p = tmp_path / "paper_repos.json"
    p.write_text(json.dumps({
        "_meta": {"purpose": "doc"},
        "1706.03762": "tensorflow/tensor2tensor",
    }))
    out = gh.load_curated_map(p)
    assert out == {"1706.03762": "tensorflow/tensor2tensor"}


def test_load_curated_map_drops_invalid_slug(tmp_path: Path) -> None:
    p = tmp_path / "paper_repos.json"
    p.write_text(json.dumps({
        "1706.03762": "tensorflow/tensor2tensor",
        "0000.00001": "owner/repo with spaces",
        "0000.00002": "owner/$injection",
        "0000.00003": "owner/../../etc",
    }))
    out = gh.load_curated_map(p)
    # Only the well-formed slug survives the regex filter.
    assert out == {"1706.03762": "tensorflow/tensor2tensor"}


def test_load_curated_map_rejects_leading_dot_in_segment(tmp_path: Path) -> None:
    """Hardened slug regex rejects names starting with ``.`` to keep
    values like ``..`` or ``.git`` out of constructed URLs."""
    p = tmp_path / "paper_repos.json"
    p.write_text(json.dumps({
        "good": "owner/repo",
        "bad1": ".owner/repo",
        "bad2": "owner/.repo",
        "bad3": "owner/..",
    }))
    out = gh.load_curated_map(p)
    assert out == {"good": "owner/repo"}


def test_load_curated_map_handles_corrupt_json(tmp_path: Path) -> None:
    p = tmp_path / "paper_repos.json"
    p.write_text("{ not valid json")
    assert gh.load_curated_map(p) == {}


def test_load_curated_map_handles_missing_file(tmp_path: Path) -> None:
    p = tmp_path / "missing.json"
    assert gh.load_curated_map(p) == {}


def test_load_curated_map_default_path_resolves(tmp_path: Path) -> None:
    """Calling without an explicit path resolves to the bundled
    ``paperpilot/data/paper_repos.json``. This protects against
    accidental ``__file__``-arithmetic regressions when the module
    moves to a different package directory."""
    out = gh.load_curated_map()
    # The bundled file exists with at least a few canonical entries.
    assert isinstance(out, dict)
    assert "1706.03762" in out  # Attention is All You Need
    assert "/" in out["1706.03762"]


# ---------- title_similarity ----------


def test_title_similarity_token_overlap() -> None:
    sim = gh.title_similarity(
        "Attention Is All You Need",
        "Transformer attention mechanism",
    )
    # 1 shared token ("attention") of 5 unique tokens → 0.2
    assert 0.0 < sim < 0.5


def test_title_similarity_substring_shortcut() -> None:
    """Repo name fully contained in normalised title hits the 1.0 fast path
    (both sides ≥ 6 normalised chars)."""
    sim = gh.title_similarity("Segment Anything", "segment-anything")
    assert sim == 1.0


def test_title_similarity_short_string_no_substring_shortcut() -> None:
    """The substring shortcut requires both sides to have ≥ 6 normalised
    alnum chars so a short repo name doesn't match an unrelated long
    title (regression guard for the ``fcn`` ↔ ``fullyconvolutional...``
    false-positive)."""
    sim = gh.title_similarity("FCN", "fullyconvolutionalnetworks")
    # No substring path; fall back to token Jaccard with no shared tokens.
    assert sim < 0.55


def test_title_similarity_empty_inputs() -> None:
    assert gh.title_similarity("", "anything") == 0.0
    assert gh.title_similarity("anything", "") == 0.0


def test_title_similarity_identical() -> None:
    assert gh.title_similarity("Same Title", "Same Title") == 1.0


# ---------- search_repo_by_title ----------


def _mock_search_response(items: list[dict]) -> MagicMock:
    """Build a ``requests.Response``-shaped mock for the search endpoint."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": items}
    return resp


def test_search_repo_by_title_returns_first_high_similarity_hit() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([
            {"full_name": "owner1/some-noise", "name": "noise", "description": "x"},
            {"full_name": "facebookresearch/segment-anything",
             "name": "segment-anything", "description": ""},
        ])
        out = gh.search_repo_by_title("Segment Anything")
        assert out == "facebookresearch/segment-anything"


def test_search_repo_by_title_filters_low_similarity() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([
            {"full_name": "spam/random-repo", "name": "random",
             "description": "totally unrelated"},
        ])
        assert gh.search_repo_by_title("A Very Specific Paper Title") is None


def test_search_repo_by_title_skips_short_titles() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        assert gh.search_repo_by_title("BERT") is None
        # No HTTP call should be issued for a sub-8-char title.
        mock_req.assert_not_called()


def test_search_repo_by_title_returns_none_on_failure() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = None
        assert gh.search_repo_by_title("Some Reasonable Paper") is None

        resp = MagicMock()
        resp.status_code = 503
        resp.json.return_value = {}
        mock_req.return_value = resp
        assert gh.search_repo_by_title("Some Reasonable Paper") is None


def test_search_repo_by_title_skips_invalid_slug_in_response() -> None:
    """Even if the GitHub API somehow returns a malformed ``full_name``,
    the slug regex filters it out before it can reach the consumer."""
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([
            {"full_name": "owner/with spaces", "name": "matching title", "description": ""},
            {"full_name": "owner/$evil", "name": "matching title", "description": ""},
            {"full_name": "owner/legit-matching-title",
             "name": "matching title", "description": ""},
        ])
        out = gh.search_repo_by_title("Matching Title Of Paper")
        assert out == "owner/legit-matching-title"


def test_search_repo_by_title_passes_token_via_header() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([])
        gh.search_repo_by_title("Some Reasonable Paper", github_token="ghp_xxx")
        kwargs = mock_req.call_args.kwargs
        assert kwargs["headers"].get("Authorization") == "Bearer ghp_xxx"


# ---------- fetch_repo_stars ----------


def test_fetch_repo_stars_via_github_api() -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"stargazers_count": 1234}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.fetch_repo_stars("owner/repo") == 1234


def test_fetch_repo_stars_returns_none_on_404() -> None:
    resp = MagicMock()
    resp.status_code = 404
    resp.json.return_value = {}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.fetch_repo_stars("owner/missing-repo") is None


def test_fetch_repo_stars_returns_none_on_request_failure() -> None:
    with patch("paperpilot.utils.github.request_with_retry", return_value=None):
        assert gh.fetch_repo_stars("owner/repo") is None


def test_fetch_repo_stars_handles_non_int_stargazer_payload() -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"stargazers_count": "not-a-number"}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.fetch_repo_stars("owner/repo") is None


def test_fetch_repo_stars_revalidates_slug_even_when_called_directly() -> None:
    """Defence-in-depth: ``fetch_repo_stars`` must re-check its
    ``repo_full`` argument against the slug allowlist regardless of how
    it was obtained. A future refactor that drops this guard breaks
    SSRF / path-traversal protections, so this test pins the
    constraint."""
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        # Each of these fails the slug regex and must be rejected
        # *before* any HTTP call is issued.
        for bad in [
            "owner/with spaces",
            "owner/$evil",
            "owner/repo;rm",
            "owner/../etc",
            "/no-owner",
            "no-slash",
        ]:
            assert gh.fetch_repo_stars(bad) is None
        mock_req.assert_not_called()


def test_fetch_repo_stars_passes_token() -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"stargazers_count": 0}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp) as mock_req:
        gh.fetch_repo_stars("owner/repo", github_token="ghp_xxx")
        auth = mock_req.call_args.kwargs["headers"].get("Authorization")
        assert auth == "Bearer ghp_xxx"


# ---------- parse_github_repo_url ----------


@pytest.mark.parametrize("url,expected", [
    ("https://github.com/owner/repo", ("owner", "repo")),
    ("http://github.com/owner/repo", ("owner", "repo")),
    ("https://www.github.com/owner/repo", ("owner", "repo")),
    ("https://github.com/owner/repo.git", ("owner", "repo")),
    ("https://github.com/owner/repo/tree/main", ("owner", "repo")),
])
def test_parse_github_repo_url_accepts_canonical(url: str, expected: tuple[str, str]) -> None:
    assert gh.parse_github_repo_url(url) == expected


@pytest.mark.parametrize("url", [
    None,
    "",
    "not a url",
    "ftp://github.com/owner/repo",                # unsupported scheme
    "ssh://git@github.com:owner/repo",            # ssh URL
    "git@github.com:owner/repo",                  # ssh shorthand
    "https://example.com/owner/repo",             # non-github host
    "https://gitlab.com/owner/repo",              # different forge
    "https://github.com.evil.com/owner/repo",     # netloc spoof
    "https://github.com/owner",                   # only one path segment
    "https://github.com/owner/repo with spaces",  # invalid slug
    "https://github.com/$/repo",                  # invalid owner
    "https://github.com/owner/$",                 # invalid repo
])
def test_parse_github_repo_url_rejects_invalid(url: str | None) -> None:
    assert gh.parse_github_repo_url(url) is None


def test_parse_github_repo_url_strips_git_suffix() -> None:
    assert gh.parse_github_repo_url("https://github.com/o/r.git") == ("o", "r")


# ---------- module hygiene ----------


def test_module_has_no_pwc_references() -> None:
    """Issue #92 mandates removing all Papers with Code references from
    the GitHub stars resolution path. Pin that constraint at the module
    level so a copy-paste regression is caught immediately."""
    src = Path(gh.__file__).read_text()
    assert "paperswithcode" not in src.lower()
    assert "PWC_BASE" not in src
