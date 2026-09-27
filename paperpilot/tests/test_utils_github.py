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


def test_search_repo_by_title_raises_when_github_is_unavailable() -> None:
    """A throttled or erroring Search API is not evidence that the paper
    has no repository. Returning None made the theme builder cache
    "0 stars, no repo" with a fresh timestamp, suppressing the retry for
    the whole TTL window."""
    import pytest

    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = None
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Some Reasonable Paper")

        for status in (403, 429, 503):
            resp = MagicMock()
            resp.status_code = status
            resp.json.return_value = {}
            mock_req.return_value = resp
            with pytest.raises(gh.GitHubUnavailableError):
                gh.search_repo_by_title("Some Reasonable Paper")


def test_search_repo_by_title_returns_none_only_for_a_200_with_no_candidate() -> None:
    """The Search API expresses "nothing matched" as 200 with an empty
    `items` array. That is the only answer about the paper."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": []}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.search_repo_by_title("Some Reasonable Paper") is None


@pytest.mark.parametrize("status", [400, 401, 404, 422, 451])
def test_search_repo_by_title_raises_for_any_other_status(status) -> None:
    """A 401 is a bad credential and a 422 is a rejected query; neither
    says the paper has no repository. The old code returned None and
    the caller cached that for the whole TTL window. This test
    previously pinned 422 -> None, which was the bug."""
    rejected = MagicMock()
    rejected.status_code = status
    with patch("paperpilot.utils.github.request_with_retry", return_value=rejected):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Some Reasonable Paper")


def test_fetch_repo_stars_returns_none_only_for_a_404() -> None:
    resp = MagicMock()
    resp.status_code = 404
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.fetch_repo_stars("owner/repo") is None


@pytest.mark.parametrize("status", [400, 401, 422, 451])
def test_fetch_repo_stars_raises_for_a_status_about_our_request(status) -> None:
    resp = MagicMock()
    resp.status_code = status
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.fetch_repo_stars("owner/repo")


def test_search_repo_by_title_refuses_a_response_carrying_an_invalid_slug() -> None:
    """A malformed ``full_name`` must never reach the consumer — that
    part is unchanged and is the SSRF / path-traversal boundary.

    What changed is what it *means*. GitHub does not emit a name the
    slug regex rejects, so such an item is a broken (or tampered)
    payload, not a repository we merely declined. Skipping it and
    returning the next match let a page of them return None, which the
    caller stores as "this paper has no repository" for a full TTL
    window. It is now surfaced as unavailable, so the lookup is retried
    instead of being frozen into the cache.
    """
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([
            {"full_name": "owner/with spaces", "name": "matching title", "description": ""},
            {"full_name": "owner/$evil", "name": "matching title", "description": ""},
            {"full_name": "owner/legit-matching-title",
             "name": "matching title", "description": ""},
        ])
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Matching Title Of Paper")


def test_search_repo_by_title_returns_a_valid_slug_from_a_clean_page() -> None:
    with patch("paperpilot.utils.github.request_with_retry") as mock_req:
        mock_req.return_value = _mock_search_response([
            {"full_name": "owner/unrelated", "name": "something else", "description": ""},
            {"full_name": "owner/legit-matching-title",
             "name": "matching title", "description": ""},
        ])
        assert gh.search_repo_by_title("Matching Title Of Paper") == "owner/legit-matching-title"


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


def test_fetch_repo_stars_raises_when_github_is_unavailable() -> None:
    import pytest

    with patch("paperpilot.utils.github.request_with_retry", return_value=None):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.fetch_repo_stars("owner/repo")

    for status in (403, 429, 502):
        resp = MagicMock()
        resp.status_code = status
        with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
            with pytest.raises(gh.GitHubUnavailableError):
                gh.fetch_repo_stars("owner/repo")


def test_fetch_repo_stars_rejects_a_non_int_stargazer_payload() -> None:
    """A repo object always carries an integer `stargazers_count`.
    Rounding anything else down to 0 wrote "this repo has no stars"
    into a fresh TTL entry, which is the outage-as-fact bug wearing a
    200 status code."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"stargazers_count": "not-a-number"}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.fetch_repo_stars("owner/repo")


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


# ---- 200 envelopes that carry no answer ----


@pytest.mark.parametrize(
    "body",
    [{}, {"message": "API rate limit exceeded"}, {"items": None}, {"items": "x"}, ["a"]],
    ids=["empty-object", "error-envelope", "null-items", "items-not-a-list", "top-level-list"],
)
def test_search_repo_rejects_a_200_without_an_items_array(body) -> None:
    """A 200 from the Search API always carries an `items` array, empty
    when nothing matched. `(r.json() or {}).get("items") or []` turned
    every other shape into "this paper has no repository", which the
    caller then cached for the whole TTL window."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = body
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Some Paper Title")


def test_search_repo_rejects_a_malformed_body() -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.side_effect = ValueError("not json")
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Some Paper Title")


def test_search_repo_accepts_a_200_with_an_empty_items_array() -> None:
    """The other half: an empty `items` really does mean "no repo"."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": []}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.search_repo_by_title("Some Paper Title") is None


@pytest.mark.parametrize(
    "body",
    [{}, {"message": "Not Found"}, {"stargazers_count": None}, {"stargazers_count": True}, []],
    ids=["empty-object", "error-envelope", "null-count", "bool-count", "top-level-list"],
)
def test_fetch_repo_stars_rejects_a_200_without_a_star_count(body) -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = body
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.fetch_repo_stars("owner/repo")


def test_fetch_repo_stars_accepts_a_genuine_zero() -> None:
    """A repo that really has no stars is an answer and must stay
    cacheable — the point of the change is to separate it from the
    envelopes above, not to stop recording it."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"stargazers_count": 0}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.fetch_repo_stars("owner/repo") == 0


@pytest.mark.parametrize(
    "item",
    [
        None,
        "a-string",
        {},
        {"message": "rate limit"},
        {"full_name": 7},
        {"full_name": "owner/repo", "description": None},
        {"full_name": "owner/repo", "name": 123, "description": None},
        {"full_name": "owner/repo", "name": None, "description": "d"},
        {"full_name": "owner/repo", "name": "repo", "description": {"message": "x"}},
        {"full_name": "owner/repo", "name": "repo", "description": ["d"]},
        {"full_name": "owner/repo", "name": "repo", "description": 5},
    ],
    ids=[
        "null",
        "string",
        "empty-dict",
        "error-item",
        "non-string-full-name",
        "missing-name",
        "numeric-name",
        "null-name",
        "dict-description",
        "list-description",
        "numeric-description",
    ],
)
def test_search_repo_rejects_a_malformed_item(item) -> None:
    """The elements carry the answer. An item-shaped error envelope
    used to fall through the loop and return None, which the caller
    stores as "this paper has no repository" for the whole TTL."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"items": [item]}
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        with pytest.raises(gh.GitHubUnavailableError):
            gh.search_repo_by_title("Some Paper Title")


def test_search_repo_still_returns_none_when_nothing_is_similar_enough() -> None:
    """The other half: a well-formed item that simply does not match
    the title is a real answer, not a broken page."""
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "items": [{"full_name": "someone/unrelated", "name": "unrelated", "description": ""}]
    }
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.search_repo_by_title("Segment Anything") is None


@pytest.mark.parametrize("description", [None, "", "A repo"], ids=["null", "empty", "text"])
def test_search_repo_accepts_a_string_or_null_description(description) -> None:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "items": [{"full_name": "someone/unrelated", "name": "unrelated", "description": description}]
    }
    with patch("paperpilot.utils.github.request_with_retry", return_value=resp):
        assert gh.search_repo_by_title("Segment Anything") is None
