"""FollowSignal tests — personal author / organization watchlist."""

from __future__ import annotations

from datetime import date

from paperpilot.models import Paper
from paperpilot.signals.follow_signal import FollowSignal


def _paper(
    authors: list[str] | None = None,
    affiliations: list[str] | None = None,
    suffix: str = "1",
) -> Paper:
    # Use explicit `is None` check so an intentional empty list stays empty.
    if authors is None:
        authors = ["Alice"]
    if affiliations is None:
        affiliations = []
    return Paper(
        title=f"Paper {suffix}",
        authors=authors,
        abstract="abs",
        url=f"http://x/{suffix}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=f"2604.{suffix}",
        affiliations=affiliations,
    )


# ---- happy paths ----


def test_author_match_scores_100():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Yann LeCun"],
        follow_orgs=[],
    )
    p = sig.enrich_one(_paper(authors=["Yann LeCun", "Alice"]))
    assert p.follow_score == 100.0
    assert p.follow_reason == "followed_author"


def test_org_match_scores_50():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=[],
        follow_orgs=["OpenAI"],
    )
    p = sig.enrich_one(_paper(authors=["Random"], affiliations=["OpenAI", "Stanford"]))
    assert p.follow_score == 50.0
    assert p.follow_reason == "followed_org"


def test_author_wins_over_org():
    """Both match: author (100) takes priority over org (50)."""
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Yann LeCun"],
        follow_orgs=["Meta"],
    )
    p = sig.enrich_one(
        _paper(authors=["Yann LeCun"], affiliations=["Meta"])
    )
    assert p.follow_score == 100.0
    assert p.follow_reason == "followed_author"


def test_no_match_is_zero():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Someone"],
        follow_orgs=["Somewhere"],
    )
    p = sig.enrich_one(_paper(authors=["Random"], affiliations=["Other U"]))
    assert p.follow_score == 0.0
    assert p.follow_reason is None


# ---- normalization ----


def test_case_insensitive_author_match():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["yann lecun"],
        follow_orgs=[],
    )
    p = sig.enrich_one(_paper(authors=["Yann LeCun"]))
    assert p.follow_score == 100.0


def test_whitespace_insensitive_author_match():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Yann  LeCun"],  # double space
        follow_orgs=[],
    )
    p = sig.enrich_one(_paper(authors=["Yann LeCun"]))
    assert p.follow_score == 100.0


def test_partial_org_substring_matches():
    """Affiliation often contains the org name with extras (e.g. 'Meta AI Research, NY').
    Allow substring match so 'Meta' matches 'Meta AI Research, NY'.
    """
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=[],
        follow_orgs=["Meta"],
    )
    p = sig.enrich_one(_paper(affiliations=["Meta AI Research, NY"]))
    assert p.follow_score == 50.0


# ---- defaults / edge cases ----


def test_empty_watchlists_signal_is_noop():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=[],
        follow_orgs=[],
    )
    p = sig.enrich_one(_paper(authors=["Yann LeCun"], affiliations=["Meta"]))
    assert p.follow_score == 0.0
    assert p.follow_reason is None


def test_empty_paper_authors():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Alice"],
        follow_orgs=[],
    )
    p = sig.enrich_one(_paper(authors=[]))
    assert p.follow_score == 0.0


def test_signal_name():
    sig = FollowSignal({"enabled": True}, follow_authors=[], follow_orgs=[])
    assert sig.name == "follow"


def test_enrich_batch_handles_multiple_papers():
    sig = FollowSignal(
        {"enabled": True},
        follow_authors=["Alice"],
        follow_orgs=[],
    )
    papers = [
        _paper(authors=["Alice"], suffix="1"),
        _paper(authors=["Bob"], suffix="2"),
        _paper(authors=["Carol", "Alice"], suffix="3"),
    ]
    out = sig.enrich_batch(papers)
    assert out[0].follow_score == 100.0
    assert out[1].follow_score == 0.0
    assert out[2].follow_score == 100.0
