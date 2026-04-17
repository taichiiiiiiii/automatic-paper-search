"""Stage 1 rule_filter tests — category / date / exclude / seen_ids."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from paperpilot.models import Paper
from paperpilot.pipeline.stage_rule_filter import rule_filter


def _mk(
    title: str = "Title",
    categories: list[str] | None = None,
    pub: date | None = None,
    comment: str | None = None,
    uid_suffix: str = "1",
) -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url=f"http://x/{uid_suffix}",
        published_date=pub or date.today(),
        source="arxiv",
        arxiv_id=f"2604.000{uid_suffix}",
        categories=categories or ["cs.LG"],
        comment=comment,
    )


def test_category_filter_keeps_matching():
    papers = [_mk(categories=["cs.LG"], uid_suffix="1"), _mk(categories=["math.ST"], uid_suffix="2")]
    kept = rule_filter(papers, exclude_words=[], categories=["cs.LG"])
    assert len(kept) == 1
    assert kept[0].categories == ["cs.LG"]


def test_empty_categories_allows_all():
    papers = [_mk(categories=["cs.LG"], uid_suffix="1"), _mk(categories=["math.ST"], uid_suffix="2")]
    kept = rule_filter(papers, exclude_words=[], categories=[])
    assert len(kept) == 2


def test_date_filter():
    today = date.today()
    old = _mk(pub=today - timedelta(days=30), uid_suffix="1")
    fresh = _mk(pub=today - timedelta(days=3), uid_suffix="2")
    kept = rule_filter(
        [old, fresh],
        exclude_words=[],
        categories=[],
        since_date=today - timedelta(days=7),
    )
    assert kept == [fresh]


def test_exclude_words_scan_title_abstract_comment():
    p_survey = _mk(title="A Comprehensive Survey of LLMs", uid_suffix="1")
    p_ok = _mk(title="Novel Method", uid_suffix="2")
    p_ws = _mk(title="Good", comment="Workshop paper", uid_suffix="3")
    kept = rule_filter(
        [p_survey, p_ok, p_ws],
        exclude_words=["survey", "workshop"],
        categories=[],
    )
    assert kept == [p_ok]


def test_seen_ids_drops_known():
    papers = [_mk(uid_suffix="1"), _mk(uid_suffix="2")]
    seen = {papers[0].uid: datetime.now().isoformat()}
    kept = rule_filter(papers, exclude_words=[], categories=[], seen_ids=seen)
    assert kept == [papers[1]]
