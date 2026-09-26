"""Deduplication and incremental "seen IDs" tracking.

seen_ids.json format (v2.0):
    { "<paper.uid>": "<ISO-8601 timestamp>", ... }

Old IDs are purged after `max_age_days` to prevent unbounded growth.
"""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from ..models import Paper


def dedup_papers(papers: list[Paper]) -> list[Paper]:
    """Remove duplicates by uid, preserving first occurrence.

    A secondary, additive pass then merges records that share a strong
    arXiv-id/DOI alias even though their primary `uid` differs — e.g. one
    source's record has both `arxiv_id` and `doi` (uid picks arxiv_id
    first), another source's record for the SAME paper has only `doi`
    (different uid string). Without this pass both survive as separate
    "papers", and whichever one is thinner loses its complementary
    metadata (abstract, pdf_url, authors) silently.

    This pass never touches `arxiv_id` / `doi` / `url` on the kept
    representative, and never changes how `uid` is derived or how
    `seen_ids.json` keys are shaped (closes #392) — merging only backfills
    non-identity fields, so `Paper.uid` is provably unaffected as a side
    effect of this pass.
    """
    seen: set[str] = set()
    unique: list[Paper] = []
    for p in papers:
        if p.uid in seen:
            continue
        seen.add(p.uid)
        unique.append(p)
    return _merge_alias_duplicates(unique)


def _merge_alias_duplicates(papers: list[Paper]) -> list[Paper]:
    """Union-find over (arxiv_id, doi) aliases; keep the first-seen paper
    per group, backfilling only abstract/pdf_url/authors from later
    group members when the kept paper's own value is empty.

    Note: the arxiv_id-based union branch below is NOT dead code, even
    though `papers` has already been through dedup_papers()'s exact `uid`
    pass. `Paper.uid` compares `arxiv_id` RAW (no normalization), while
    this pass compares it `.strip().lower()`-normalized — so two papers
    whose `arxiv_id` differs only in case/whitespace (e.g. "ABC.123" vs
    " abc.123 ") get DIFFERENT uids (surviving the primary pass as two
    entries) but the SAME normalized alias key, and correctly merge here.
    A shared `doi` between a doi-bearing-uid paper and an arxiv_id-bearing
    paper is the other, more common case this pass exists for.
    """
    parent = list(range(len(papers)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    by_arxiv: dict[str, int] = {}
    by_doi: dict[str, int] = {}
    for i, p in enumerate(papers):
        if p.arxiv_id:
            key = p.arxiv_id.strip().lower()
            if not key:
                # Whitespace-only "arxiv_id" (e.g. " "): the normalized
                # key would be "", and two UNRELATED papers that both
                # happen to have a blank/whitespace-only value would
                # falsely collide on that shared empty key. Never index
                # an empty normalized key.
                pass
            elif key in by_arxiv:
                union(i, by_arxiv[key])
            else:
                by_arxiv[key] = i
        if p.doi:
            key = p.doi.strip().lower()
            if not key:
                pass  # see the arxiv_id branch above for why
            elif key in by_doi:
                union(i, by_doi[key])
            else:
                by_doi[key] = i

    groups: dict[int, list[int]] = {}
    for i in range(len(papers)):
        groups.setdefault(find(i), []).append(i)

    result: list[Paper] = []
    for indices in groups.values():
        rep = papers[indices[0]]  # smallest index in the group (see union())
        for idx in indices[1:]:
            dup = papers[idx]
            if not rep.abstract and dup.abstract:
                rep.abstract = dup.abstract
            if not rep.pdf_url and dup.pdf_url:
                rep.pdf_url = dup.pdf_url
            if not rep.authors and dup.authors:
                rep.authors = dup.authors
        result.append(rep)
    return result


def load_seen_ids(path: str | Path) -> dict[str, str]:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}
    # Support legacy list format gracefully.
    if isinstance(data, list):
        now = datetime.now().isoformat()
        return {str(uid): now for uid in data}
    if not isinstance(data, dict):
        # Malformed file (e.g. a string or null) — treat as empty.
        return {}
    # Defensive: coerce any non-string values to iso-now to keep purge working.
    return {str(k): str(v) for k, v in data.items() if k}


def save_seen_ids(path: str | Path, seen: dict[str, str]) -> None:
    """Atomically overwrite seen_ids.json (write to a sibling tmp file, then
    `os.replace`), mirroring the tmp+rename pattern used for
    build_pages.py's paper-links output. A Python exception or process
    crash mid-write leaves the original file untouched rather than
    truncated/corrupt (which would make every paper look "unseen" on the
    next run and cause mass re-alerts). No fsync: this guards against
    write failures, not power-loss/kernel-crash durability of the rename
    itself — acceptable for this low-frequency, recoverable pipeline state.

    Note: `os.replace` here is a rename, not a merge — this function
    last-writer-wins by design and is only safe for a caller that owns the
    whole file. A pipeline run must use `merge_seen_ids` instead, which
    does the read-merge-write under an exclusive lock.

    Uses `tempfile.NamedTemporaryFile(delete=False)` (which internally opens
    with O_EXCL, guaranteeing a unique name) rather than a `.tmp.<pid>`
    suffix: a bare PID is not a reliable uniqueness key across the
    concurrent collector containers this pipeline runs in — each
    container's own PID namespace numbers processes independently, so two
    unrelated containers can easily end up with the same numeric PID and
    pick the exact same temp filename, corrupting each other's in-flight
    write.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=p.parent,
            prefix=f".{p.name}.",
            suffix=".tmp",
            delete=False,
        ) as f:
            tmp_path = Path(f.name)
            json.dump(seen, f, ensure_ascii=False, indent=2)
        # Deliberately NOT chmod'd to "match open('w')": NamedTemporaryFile's
        # 0o600 default is intentionally more restrictive, and forcing 0o644
        # would (a) widen an existing destination file's permissions on
        # every overwrite and (b) leave a brief pre-replace window where the
        # completed temp file is world-readable. 0o600 is fine for this
        # pipeline-internal state file.
        os.replace(tmp_path, p)
        tmp_path = None
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def merge_seen_ids(
    path: str | Path, papers: list[Paper], *, max_age_days: int
) -> dict[str, str]:
    """Mark `papers` seen in the on-disk file and return the merged mapping.

    The whole read-merge-write runs while holding an exclusive ``flock`` on
    a sibling ``.lock`` file, for the same reason ``persist_classifications``
    does (#402). ``save_seen_ids`` alone is atomic but not serialized: two
    runs that each loaded the same snapshot, marked disjoint papers and
    saved would leave only the later writer's IDs on disk, and the earlier
    run's papers would be re-delivered as if never sent.

    Merge order matters. The disk copy is re-read INSIDE the lock (it may
    have advanced since the caller's ``load_seen_ids``), the new IDs are
    stamped on top, and the purge is re-applied to the merged result — so
    entries that aged out are not resurrected by a stale in-memory copy,
    while the just-marked IDs always carry a fresh timestamp and survive.

    Format is unchanged: ``{uid: ISO-8601 timestamp}``.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    lock_path = p.with_suffix(p.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            merged = load_seen_ids(p)
            merged = mark_seen(papers, merged)
            merged = purge_seen_ids(merged, max_age_days)
            save_seen_ids(p, merged)
            return merged
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def purge_seen_ids(seen: dict[str, str], max_age_days: int) -> dict[str, str]:
    cutoff = datetime.now() - timedelta(days=max_age_days)
    kept: dict[str, str] = {}
    for uid, ts in seen.items():
        try:
            if datetime.fromisoformat(ts) > cutoff:
                kept[uid] = ts
        except ValueError:
            # Drop unparseable entries.
            continue
    return kept


def filter_unseen(papers: list[Paper], seen: dict[str, str]) -> list[Paper]:
    return [p for p in papers if p.uid not in seen]


def mark_seen(papers: list[Paper], seen: dict[str, str]) -> dict[str, str]:
    now = datetime.now().isoformat()
    for p in papers:
        seen[p.uid] = now
    return seen
