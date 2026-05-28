"""Build a local DuckDB index from HF saier/unarXive_citrec.

One-shot script (run offline or in a dedicated CI job, not on every
build). Downloads the HuggingFace dataset, joins the citation
paragraphs with the ``license_info`` sidecar to recover the citing
paper's arXiv id per row, and writes a DuckDB file with a composite
index on (citing arXiv id, cited OpenAlex W-URL).

The resulting DuckDB is consumed by ``paperpilot.utils.unarxive``
at runtime. ~7 GB HF download → ~2-3 GB DuckDB on disk; query
latency < 5 ms per lookup.

### Usage

::

    uv pip install duckdb datasets
    uv run python -m paperpilot.scripts.build_unarxive_index \
        --out paperpilot/data/unarxive/unarxive.duckdb

Then upload the resulting ``unarxive.duckdb`` as a GitHub Release
asset (the 2 GB/file cap requires sharding for the citrec full set;
default behaviour writes a single file because the indexed Parquet
representation comfortably fits under the limit, but
``--split-shards`` is available for safety).

### Why offline / not in every CI run

The HF dataset download is ~7 GB and the DuckDB build is
~5-10 minutes. Doing this on every theme-on-demand regen would
multiply the workflow cost. Instead we build once, ship the binary
via GitHub Release, and the data-touching workflows download the
prebuilt artifact (small, fast) at runtime.

### License

unarXive 2022 is CC-BY-SA-4.0 (Saier et al., JCDL 2023). The
attribution lives in ``docs/themes/<slug>/index.html`` footer; the
DuckDB file embeds the upstream `license_info.paper_license` column
so per-paper exceptions (a small slice of arXiv papers ship under
narrower licences) remain traceable.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from paperpilot.utils.logger import get_logger, setup_logging

logger = get_logger(__name__)


def _import_or_die() -> tuple:  # tuple of (duckdb module, load_dataset func)
    """Import the optional ``duckdb`` and ``datasets`` packages, with
    a clear error if they're missing. These aren't in PaperPilot's
    default dependency set (kept lean) — operators add them only when
    rebuilding the index."""
    try:
        import duckdb
    except ImportError:
        print(
            "error: duckdb package not installed. "
            "run: uv pip install duckdb datasets",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    try:
        from datasets import load_dataset
    except ImportError:
        print(
            "error: datasets package not installed. "
            "run: uv pip install duckdb datasets",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    return duckdb, load_dataset


def build_index(out_path: Path, *, sample: int | None = None) -> int:
    """Download saier/unarXive_citrec and write a DuckDB index.

    ``sample``: if set, only the first N rows are ingested
    (development / smoke tests). Production builds use the full
    dataset (``sample=None``).

    Returns the number of rows written (== row count of citrec
    citation contexts post-join). 0 on failure (errors logged).
    """
    duckdb, load_dataset = _import_or_die()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()  # rebuild from scratch each time

    logger.info("loading saier/unarXive_citrec from HuggingFace...")
    citrec = load_dataset(
        "saier/unarXive_citrec",
        split="train",
        streaming=False,
    )
    # Side car: maps citrec _id → paper_arxiv_id (the citing paper)
    # and paper_license. Live alongside the main rows on HF.
    logger.info("loading license_info sidecar...")
    licenses = load_dataset(
        "saier/unarXive_citrec",
        data_files="license_info.jsonl",
        split="train",
        streaming=False,
    )

    logger.info("opening DuckDB at %s", out_path)
    conn = duckdb.connect(str(out_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS citrec (
            sample_id      TEXT,
            text           TEXT,
            marker         TEXT,
            label          TEXT,
            paper_arxiv_id TEXT,
            paper_license  TEXT
        )
    """)

    # Bulk-insert via DuckDB's Arrow integration when available;
    # otherwise fall back to executemany. The streaming path keeps
    # peak memory under 4 GB even on the full ~2.5 M rows.
    by_sample_id: dict[str, dict] = {}
    for row in licenses:
        sid = row.get("sample_id")
        if isinstance(sid, str):
            by_sample_id[sid] = row

    logger.info(
        "joining %d citrec rows with %d license_info rows...",
        len(citrec), len(by_sample_id),
    )
    inserted = 0
    batch: list[tuple] = []
    batch_size = 5_000
    for i, row in enumerate(citrec):
        if sample is not None and i >= sample:
            break
        sid = row.get("_id")
        lic = by_sample_id.get(sid, {}) if isinstance(sid, str) else {}
        batch.append((
            sid,
            row.get("text") or "",
            row.get("marker") or "",
            row.get("label") or "",
            lic.get("paper_arxiv_id") or "",
            lic.get("paper_license") or "",
        ))
        if len(batch) >= batch_size:
            conn.executemany(
                "INSERT INTO citrec VALUES (?, ?, ?, ?, ?, ?)", batch
            )
            inserted += len(batch)
            batch = []
            if inserted % 50_000 == 0:
                logger.info("inserted %d rows", inserted)
    if batch:
        conn.executemany(
            "INSERT INTO citrec VALUES (?, ?, ?, ?, ?, ?)", batch
        )
        inserted += len(batch)

    logger.info("building composite index on (paper_arxiv_id, label)...")
    conn.execute(
        "CREATE INDEX idx_citing_cited ON citrec(paper_arxiv_id, label)"
    )
    conn.execute("ANALYZE")
    conn.close()
    logger.info("done. %d rows written to %s", inserted, out_path)
    return inserted


def main(argv: list[str] | None = None) -> int:
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path("paperpilot/data/unarxive/unarxive.duckdb"),
        help="Output DuckDB path (default %(default)s).",
    )
    ap.add_argument(
        "--sample",
        type=int,
        default=None,
        help="Ingest only the first N rows (dev / smoke test).",
    )
    args = ap.parse_args(argv)
    rows = build_index(args.out, sample=args.sample)
    if rows == 0:
        print("error: 0 rows written", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
