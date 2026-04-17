"""dedup / seen-ids utilities tests."""

from __future__ import annotations

from datetime import datetime, timedelta

from paperpilot.utils.dedup import (
    dedup_papers,
    filter_unseen,
    mark_seen,
    purge_seen_ids,
)


def test_dedup_preserves_first(papers_batch):
    doubled = papers_batch + papers_batch
    result = dedup_papers(doubled)
    assert len(result) == len(papers_batch)
    assert [p.uid for p in result] == [p.uid for p in papers_batch]


def test_filter_unseen_drops_known(papers_batch):
    seen = {papers_batch[0].uid: datetime.now().isoformat()}
    result = filter_unseen(papers_batch, seen)
    assert len(result) == len(papers_batch) - 1
    assert papers_batch[0] not in result


def test_mark_seen_adds_all(papers_batch):
    seen: dict[str, str] = {}
    mark_seen(papers_batch, seen)
    for p in papers_batch:
        assert p.uid in seen


def test_purge_drops_old_entries():
    old_ts = (datetime.now() - timedelta(days=30)).isoformat()
    new_ts = datetime.now().isoformat()
    seen = {"arxiv:old": old_ts, "arxiv:new": new_ts}
    kept = purge_seen_ids(seen, max_age_days=14)
    assert "arxiv:old" not in kept
    assert "arxiv:new" in kept


def test_purge_handles_bad_timestamps():
    seen = {"arxiv:good": datetime.now().isoformat(), "arxiv:bad": "garbage"}
    kept = purge_seen_ids(seen, max_age_days=14)
    assert "arxiv:good" in kept
    assert "arxiv:bad" not in kept
