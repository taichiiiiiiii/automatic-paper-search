"""dedup / seen-ids utilities tests."""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest

from paperpilot.utils.dedup import (
    dedup_papers,
    filter_unseen,
    load_seen_ids,
    mark_seen,
    purge_seen_ids,
    save_seen_ids,
)


def test_dedup_preserves_first(papers_batch):
    doubled = papers_batch + papers_batch
    result = dedup_papers(doubled)
    assert len(result) == len(papers_batch)
    assert [p.uid for p in result] == [p.uid for p in papers_batch]


def _paper(**overrides):
    from datetime import date

    from paperpilot.models import Paper

    defaults = dict(
        title="T",
        authors=["A"],
        abstract="",
        url="http://x/1",
        published_date=date.today(),
        source="arxiv",
    )
    defaults.update(overrides)
    return Paper(**defaults)


def test_dedup_merges_arxiv_plus_doi_record_with_doi_only_record():
    """Regression test (closes #392): an arXiv+DOI record (uid picks
    arxiv_id) and a DOI-only record for the SAME paper (different uid,
    since it has no arxiv_id) must be merged into one, not survive as two
    separate "papers" — this is the exact scenario named in the issue."""
    rich = _paper(arxiv_id="2604.00001", doi="10.1/abc", abstract="Full abstract")
    thin = _paper(doi="10.1/abc", abstract="")  # same DOI, no arxiv_id -> different uid
    assert rich.uid != thin.uid  # confirms these are a real uid mismatch, not a no-op

    result = dedup_papers([rich, thin])
    assert len(result) == 1
    assert result[0].uid == rich.uid  # first-seen representative kept as-is


def test_dedup_alias_merge_backfills_missing_metadata_from_thinner_record():
    """The kept representative must gain the OTHER record's non-identity
    fields when its own are empty (the "losing complementary metadata"
    problem named in the issue), without ever touching arxiv_id/doi/url."""
    thin_first = _paper(
        arxiv_id="2604.00002", doi="10.1/xyz", abstract="", pdf_url="", authors=[]
    )
    rich_second = _paper(
        doi="10.1/xyz",  # same DOI links it to thin_first; no arxiv_id of its own
        abstract="Rich abstract from the other source",
        pdf_url="http://pdf/2",
        authors=["Real Author"],
    )
    result = dedup_papers([thin_first, rich_second])
    assert len(result) == 1
    kept = result[0]
    assert kept.uid == thin_first.uid  # identity fields untouched
    assert kept.arxiv_id == "2604.00002"
    assert kept.doi == "10.1/xyz"  # was already thin_first's own value, unchanged
    assert kept.abstract == "Rich abstract from the other source"
    assert kept.pdf_url == "http://pdf/2"
    assert kept.authors == ["Real Author"]


def test_dedup_alias_merge_never_links_papers_with_no_shared_identifier():
    """Regression test (closes #392): the merge pass links records ONLY
    through a shared arxiv_id or doi. A paper with neither (uid falls back
    to url:...) contributes no key to either alias map, so it can never be
    pulled into a group — even alongside an unrelated paper that happens
    to have a doi. This is what guarantees uid/seen_ids.json keys can
    never change as a side effect: there is no path for an identity field
    to be backfilled onto a paper that wasn't already alias-linked."""
    url_only = _paper(url="http://example.com/paper-x", abstract="")
    unrelated_with_doi = _paper(
        url="http://example.com/paper-y",
        doi="10.1/unrelated",
        abstract="",
    )
    result = dedup_papers([url_only, unrelated_with_doi])
    assert len(result) == 2


def test_dedup_alias_merge_does_not_falsely_link_whitespace_only_identifiers():
    """Regression test (closes #392 follow-up): a whitespace-only doi (" ",
    "   ") normalizes via .strip().lower() to the SAME empty string "" —
    without a guard, two otherwise-UNRELATED papers that each happen to
    have a blank/whitespace doi would falsely collide on that shared empty
    key and get merged. Their real (non-normalized) uids are distinct, so
    this would be a genuine false merge, not a real alias."""
    unrelated_a = _paper(url="http://example.com/a", doi=" ", abstract="A's abstract")
    unrelated_b = _paper(url="http://example.com/b", doi="   ", abstract="B's abstract")
    assert unrelated_a.uid != unrelated_b.uid  # confirms these are genuinely distinct
    result = dedup_papers([unrelated_a, unrelated_b])
    assert len(result) == 2


def test_dedup_alias_merge_normalizes_arxiv_id_case_and_whitespace():
    """Regression test (closes #392 follow-up): Paper.uid compares
    arxiv_id RAW (no normalization), but this merge pass normalizes via
    .strip().lower() — so two papers whose arxiv_id differs only in case/
    whitespace get DIFFERENT uids (both survive the primary pass) but the
    SAME normalized alias key, and must merge here. This is the arxiv_id
    union branch's real, reachable behavior (it is NOT dead code)."""
    a = _paper(arxiv_id="2604.00010", abstract="")
    b = _paper(arxiv_id=" 2604.00010 ", abstract="from B")  # same id, padded
    assert a.uid != b.uid  # different raw arxiv_id strings -> different uids
    result = dedup_papers([a, b])
    assert len(result) == 1
    assert result[0].uid == a.uid  # first-seen kept
    assert result[0].abstract == "from B"  # backfilled from the second record


def test_dedup_alias_merge_groups_more_than_two_records_sharing_one_doi():
    """Three records sharing one DOI, each with a distinct (or absent)
    arxiv_id so none collapse via the primary exact-uid pass, must all
    merge into a single group — not just the first pair encountered.
    (Note: two records can never share the same arxiv_id and reach this
    pass at all, since matching arxiv_id always means matching uid, which
    the PRIMARY pass already collapses — so DOI is the only alias that can
    ever link records still distinct after phase one.)"""
    a = _paper(arxiv_id="2604.00003", doi="10.1/shared")
    b = _paper(arxiv_id="2604.00004", doi="10.1/shared", abstract="from B")
    c = _paper(doi="10.1/shared", pdf_url="http://pdf/c")  # no arxiv_id of its own
    result = dedup_papers([a, b, c])
    assert len(result) == 1
    kept = result[0]
    assert kept.uid == a.uid
    assert kept.abstract == "from B"
    assert kept.pdf_url == "http://pdf/c"


def test_dedup_alias_merge_does_not_merge_unrelated_papers():
    """Papers with no shared arxiv_id/doi must never be merged, regardless
    of how similar their other fields look."""
    p1 = _paper(arxiv_id="2604.00004", title="Same Title")
    p2 = _paper(arxiv_id="2604.00005", title="Same Title")
    result = dedup_papers([p1, p2])
    assert len(result) == 2


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


def test_save_seen_ids_round_trips(tmp_path):
    path = tmp_path / "seen_ids.json"
    seen = {"arxiv:1": datetime.now().isoformat()}
    save_seen_ids(path, seen)
    assert load_seen_ids(path) == seen


def test_save_seen_ids_leaves_no_tmp_file_behind(tmp_path):
    """Regression test (closes #396): the tmp file used for the atomic
    write must be renamed away, never left dangling next to the real one."""
    path = tmp_path / "seen_ids.json"
    save_seen_ids(path, {"arxiv:1": datetime.now().isoformat()})
    leftover = [p for p in tmp_path.iterdir() if p.name != "seen_ids.json"]
    assert leftover == []


def test_save_seen_ids_temp_name_is_not_pid_based(tmp_path, monkeypatch):
    """Regression test (closes #396 follow-up): a PID-suffixed temp name is
    not a reliable uniqueness key across concurrent collector containers —
    each container's own PID namespace numbers processes independently, so
    two unrelated containers can easily end up with the same numeric PID.
    Prove two calls under the SAME mocked pid still get distinct underlying
    temp filenames (via tempfile's O_EXCL-guaranteed uniqueness), so two
    same-pid writers can never clobber each other's in-flight temp file."""
    monkeypatch.setattr(os, "getpid", lambda: 12345)
    path = tmp_path / "seen_ids.json"

    recorded_tmp_names: list[str] = []
    real_replace = os.replace

    def _spy_replace(src, dst):
        recorded_tmp_names.append(str(src))
        real_replace(src, dst)

    monkeypatch.setattr(
        "paperpilot.utils.dedup.os.replace", _spy_replace
    )

    save_seen_ids(path, {"arxiv:1": "2026-01-01T00:00:00"})
    save_seen_ids(path, {"arxiv:2": "2026-01-01T00:00:00"})

    assert len(recorded_tmp_names) == 2
    assert recorded_tmp_names[0] != recorded_tmp_names[1]
    assert load_seen_ids(path) == {"arxiv:2": "2026-01-01T00:00:00"}


def test_save_seen_ids_does_not_truncate_existing_file_if_write_fails(
    tmp_path, monkeypatch
):
    """Regression test (closes #396): if the write step fails partway
    through, the ORIGINAL file must be byte-for-byte untouched (old
    atomic-write bug: opening the destination with "w" truncates it before
    json.dump can raise, leaving a corrupt/empty file that makes every
    paper look unseen and causes mass re-alerts on the next run)."""
    path = tmp_path / "seen_ids.json"
    original = {"arxiv:1": datetime.now().isoformat()}
    save_seen_ids(path, original)
    original_bytes = path.read_bytes()

    import paperpilot.utils.dedup as dedup_mod

    real_json_dump = dedup_mod.json.dump

    def _boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(dedup_mod.json, "dump", _boom)
    try:
        with pytest.raises(OSError, match="disk full"):
            save_seen_ids(path, {"arxiv:2": datetime.now().isoformat()})
    finally:
        monkeypatch.setattr(dedup_mod.json, "dump", real_json_dump)

    # The original file must survive byte-for-byte untouched.
    assert path.read_bytes() == original_bytes
    # The failed attempt's tmp file must not linger either — save_seen_ids
    # cleans it up on any failure between creation and os.replace.
    leftover = [p for p in tmp_path.iterdir() if p.name != "seen_ids.json"]
    assert leftover == []


def test_save_seen_ids_survives_os_replace_failure(tmp_path, monkeypatch):
    """Regression test (closes #396 follow-up): if os.replace() itself
    fails (write succeeded, but the atomic rename didn't), the original
    file must still be untouched and the orphaned tmp file cleaned up —
    not just the earlier-in-the-sequence json.dump() failure case."""
    path = tmp_path / "seen_ids.json"
    original = {"arxiv:1": datetime.now().isoformat()}
    save_seen_ids(path, original)
    original_bytes = path.read_bytes()

    import paperpilot.utils.dedup as dedup_mod

    real_replace = dedup_mod.os.replace

    def _boom(*args, **kwargs):
        raise OSError("rename failed")

    monkeypatch.setattr(dedup_mod.os, "replace", _boom)
    try:
        with pytest.raises(OSError, match="rename failed"):
            save_seen_ids(path, {"arxiv:2": datetime.now().isoformat()})
    finally:
        monkeypatch.setattr(dedup_mod.os, "replace", real_replace)

    assert path.read_bytes() == original_bytes
    leftover = [p for p in tmp_path.iterdir() if p.name != "seen_ids.json"]
    assert leftover == []
