"""GitHubSignal — log-scale star normalization tests."""

from __future__ import annotations

import logging
import math
from datetime import date
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.signals.github_signal import (
    MAX_STARS,
    GitHubSignal,
    _stars_to_score,
)
from paperpilot.utils.github import GitHubUnavailableError


def test_zero_stars():
    assert _stars_to_score(0) == 0.0


def test_negative_stars_is_zero():
    assert _stars_to_score(-1) == 0.0


def test_max_stars_is_100():
    assert _stars_to_score(MAX_STARS) == 100.0


def test_above_max_still_100():
    assert _stars_to_score(MAX_STARS * 10) == 100.0


def test_log_curve_monotonic():
    scores = [_stars_to_score(s) for s in (1, 10, 100, 1000, 5000, 10000)]
    assert scores == sorted(scores)
    assert len(set(scores)) == len(scores)  # all distinct


def test_1000_stars_matches_formula():
    expected = math.log(1001) / math.log(MAX_STARS + 1) * 100
    assert _stars_to_score(1000) == expected


# ---------- per-run failure channel (H-2) ----------

_SIGNAL_LOGGER = "paperpilot.signals.github_signal"


def _mk_paper(arxiv_id: str) -> Paper:
    return Paper(
        title=f"T {arxiv_id}",
        authors=["A"],
        abstract="abs",
        url=f"http://x/{arxiv_id}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=arxiv_id,
    )


def _warnings(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == _SIGNAL_LOGGER and r.levelno == logging.WARNING
    ]


def test_repeated_unavailable_lookups_record_one_warning_and_one_entry(caplog):
    """A throttled GitHub API fails every lookup in the same way, so N
    identical entries would bury the signal's channel and N identical WARNINGs
    would bury the log. The run reports one aggregated entry and — as CLAUDE.md
    error handling requires once retries are exhausted — one WARNING."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 3})
    sig._curated = {}  # force the search path
    papers = [_mk_paper(f"2604.000{i}") for i in (1, 2, 3)]

    with caplog.at_level(logging.DEBUG, logger=_SIGNAL_LOGGER):
        with patch(
            "paperpilot.signals.github_signal.search_repo_by_title",
            side_effect=GitHubUnavailableError(
                "github repo search failed (status=403)"
            ),
        ):
            out = sig.enrich_batch(papers)

    assert all(p.github_score == 0.0 for p in out)
    assert len(sig.run_failures) == 1
    assert "3 lookup(s) unavailable" in sig.run_failures[0]
    assert "status=403" in sig.run_failures[0]
    warnings = _warnings(caplog)
    assert len(warnings) == 1
    assert "3 lookup(s) degraded this run" in warnings[0]


def test_search_miss_is_not_recorded_as_a_failure(caplog):
    """"This paper has no repository" is a fact about the paper, not an outage.
    Only the unavailable/error paths may occupy the failure channel."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 2})
    sig._curated = {}
    with caplog.at_level(logging.DEBUG, logger=_SIGNAL_LOGGER):
        with patch(
            "paperpilot.signals.github_signal.search_repo_by_title",
            return_value=None,
        ):
            sig.enrich_batch([_mk_paper("2604.0001"), _mk_paper("2604.0002")])

    assert sig.run_failures == []
    assert _warnings(caplog) == []


def test_lookup_exception_is_counted_in_the_same_entry():
    """A logic bug in the lookup chain degrades the score too, so it belongs in
    the aggregated entry (its own per-lookup WARNING with traceback stays for
    debugging)."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 1})
    sig._curated = {"2604.0001": "owner/repo"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        side_effect=RuntimeError("boom"),
    ):
        sig.enrich_batch([_mk_paper("2604.0001")])

    assert len(sig.run_failures) == 1
    assert "1 lookup(s) raised" in sig.run_failures[0]


def test_clean_run_leaves_the_channel_empty_after_a_degraded_one():
    """The channel is per run: a recovered API must not inherit the previous
    run's summary."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 1})
    sig._curated = {"2604.0001": "owner/repo"}
    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars",
        side_effect=GitHubUnavailableError("down"),
    ):
        sig.enrich_batch([_mk_paper("2604.0001")])
    assert sig.run_failures

    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars", return_value=120
    ):
        out = sig.enrich_batch([_mk_paper("2604.0001")])
    assert sig.run_failures == []
    assert out[0].github_stars == 120


# ---------- lookup budget (M-3) ----------


def test_budget_exhaustion_is_recorded_as_one_aggregated_entry(caplog):
    """M-3: when `max_lookups` runs out the papers it never reached keep
    github_score 0.0 because nobody asked — in run_history that is
    indistinguishable from "looked, found no repository". One entry covers them,
    and the ranking itself is untouched."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 1})
    sig._curated = {f"2604.000{i}": f"owner/repo{i}" for i in (1, 2, 3)}
    papers = [_mk_paper(f"2604.000{i}") for i in (1, 2, 3)]

    with caplog.at_level(logging.WARNING, logger=_SIGNAL_LOGGER):
        with patch(
            "paperpilot.signals.github_signal.fetch_repo_stars", return_value=100
        ):
            out = sig.enrich_batch(papers)

    assert sig.run_failures == [
        "budget exhausted after 1 lookups, 2 papers unqueried"
    ]
    warnings = _warnings(caplog)
    assert len(warnings) == 1
    assert "budget exhausted" in warnings[0]
    # No score or ordering change: the budgeted lookup still earns its stars, the
    # papers behind the cut are exactly as they were.
    assert out[0].github_score > 0.0
    assert out[1].github_score == 0.0
    assert out[2].github_score == 0.0


def test_budget_entry_and_lookup_failures_are_reported_separately():
    """A throttled API and a budget that ran out are different losses, so the
    aggregated failure entry must not swallow the coverage cut (or vice versa)."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 1})
    sig._curated = {}
    papers = [_mk_paper(f"2604.000{i}") for i in (1, 2)]

    with patch(
        "paperpilot.signals.github_signal.search_repo_by_title",
        side_effect=GitHubUnavailableError("github repo search failed (status=403)"),
    ):
        sig.enrich_batch(papers)

    assert len(sig.run_failures) == 2
    assert "1 lookup(s) unavailable" in sig.run_failures[0]
    assert sig.run_failures[1] == "budget exhausted after 1 lookups, 1 papers unqueried"


def test_papers_without_an_arxiv_id_are_not_counted_as_unqueried():
    """Papers missing arxiv_id are skipped without charging the budget (documented
    budget rule), so they were never candidates for a lookup and must not appear in
    the coverage cut."""
    sig = GitHubSignal({"enabled": True, "max_lookups": 1})
    sig._curated = {"2604.0001": "owner/repo"}
    no_id = Paper(
        title="T no id",
        authors=["A"],
        abstract="abs",
        url="http://x/no-id",
        published_date=date.today(),
        source="openalex",
    )

    with patch(
        "paperpilot.signals.github_signal.fetch_repo_stars", return_value=100
    ):
        sig.enrich_batch([_mk_paper("2604.0001"), no_id])

    assert sig.run_failures == []
