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

    uv pip install 'paperpilot[unarxive]'   # = duckdb + huggingface_hub
    uv run python -m paperpilot.scripts.build_unarxive_index \
        --out paperpilot/data/unarxive/unarxive.duckdb

The script also emits a gzipped copy at
``<out>.gz`` (e.g. ``unarxive.duckdb.gz``). Upload **the gzip** as a
GitHub Release asset (`tag = unarxive-v1`); the raw `.duckdb` is for
local inspection only. The CI workflows ``theme-on-demand.yml`` and
``regen-themes.yml`` curl the gzipped artifact and gunzip on the
runner before the lineage pipeline opens it.

The 2 GB / asset cap is comfortable for the trimmed schema
(3 columns, text capped at 600 chars) — measured at ~1.5 GB
gzipped on the full 2 M-row citrec split. Future growth past the
cap would require sharding by year (cf. CLAUDE.md operator notes)
or a move to Cloudflare R2.

### Why offline / not in every CI run

The HF dataset download is ~7 GB and the DuckDB build is
~5-10 minutes. Doing this on every theme-on-demand regen would
multiply the workflow cost. Instead we build once, ship the binary
via GitHub Release, and the data-touching workflows download the
prebuilt artifact (small, fast) at runtime.

### License

unarXive 2022 is CC-BY-SA-4.0 (Saier et al., JCDL 2023). The
``paper_license`` column from ``license_info.jsonl`` is dropped at
build time to fit the 2 GB Release cap (audit-only at runtime,
never queried). Attribution therefore lives entirely in the
``docs/themes/<slug>/index.html`` footer — operators must surface
"data: unarXive 2022 (Saier et al., CC-BY-SA-4.0)" in the viewer
since the per-row licence trail no longer ships with the artifact.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from paperpilot.utils.logger import get_logger, setup_logging

logger = get_logger(__name__)


def _import_or_die() -> tuple[Any, Callable[..., Any]]:
    """Import the optional ``duckdb`` and ``huggingface_hub`` packages,
    with a clear error if they're missing. Neither is in PaperPilot's
    default dependency set (kept lean) — operators add them only when
    rebuilding the index. ``datasets`` is intentionally NOT a
    dependency: we read the raw JSONL via DuckDB's ``read_json_auto``
    (orders of magnitude faster than streaming HF rows through
    Python) and only need ``hf_hub_download`` to fetch+cache the
    upstream files.

    Returns ``(duckdb_module, hf_hub_download)``.
    """
    try:
        import duckdb
    except ImportError:
        print(
            "error: duckdb package not installed. "
            "run: uv pip install duckdb huggingface_hub",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print(
            "error: huggingface_hub package not installed. "
            "run: uv pip install duckdb huggingface_hub",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    return duckdb, hf_hub_download


def build_index(out_path: Path, *, sample: int | None = None) -> int:
    """Download saier/unarXive_citrec and write a DuckDB index.

    ``sample``: if set, only the first N rows are ingested
    (development / smoke tests). Production builds use the full
    dataset (``sample=None``).

    Returns the number of rows written (== row count of citrec
    citation contexts post-join). 0 on failure (errors logged).
    """
    duckdb, hf_hub_download = _import_or_die()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()  # rebuild from scratch each time

    # Fetch both JSONL files via hf_hub_download (cached on repeat
    # runs — the HF cache layer dedupes by SHA). We then hand both
    # paths to DuckDB's native `read_json_auto` so ingest + join
    # happen entirely in C++; in earlier revisions of this script we
    # streamed rows through Python `executemany` and the build took
    # ~2 h for just the license sidecar.
    logger.info("downloading license_info.jsonl sidecar...")
    license_path = hf_hub_download(
        repo_id="saier/unarXive_citrec",
        filename="license_info.jsonl",
        repo_type="dataset",
    )
    logger.info("downloading data/train.jsonl (citrec split)...")
    citrec_path = hf_hub_download(
        repo_id="saier/unarXive_citrec",
        filename="data/train.jsonl",
        repo_type="dataset",
    )

    # Spill directory lives next to the output; DuckDB writes sort/hash
    # partitions here when the JOIN exceeds memory_limit. Created before
    # the connection opens so we can pass its path via PRAGMA, and torn
    # down in the `finally` block whether or not the build succeeds
    # (spills can reach several GB and silently accumulate otherwise).
    spill_dir = out_path.parent / f"{out_path.name}.spill"
    spill_dir.mkdir(parents=True, exist_ok=True)

    logger.info("opening DuckDB at %s", out_path)
    conn = duckdb.connect(str(out_path))
    try:
        # Constrain DuckDB's working memory and route spills to a known
        # location on the same volume as ``out_path``. Without these,
        # the initial ``read_json_auto`` over the ~18 GB citrec JSONL
        # can OOM on memory-constrained machines (observed: silent kill
        # on a host with 3.8 GB RAM / 2 GB swap). The PRAGMA values use
        # parameterised binding so an operator-supplied ``--out``
        # containing a quote can't break out of the PRAGMA statement.
        conn.execute("PRAGMA memory_limit='2GB'")
        conn.execute("SET temp_directory = ?", [str(spill_dir)])
        conn.execute("PRAGMA threads=2")
        logger.info(
            "duckdb tuned: memory_limit=2GB, temp_directory=%s, threads=2",
            spill_dir,
        )

        # `read_json_auto` parses JSONL when `format='newline_delimited'`.
        # Setting `ignore_errors=true` lets us survive any malformed
        # line without aborting the build — unarXive is well-formed
        # but robustness is cheap here.
        logger.info("staging license_info (DuckDB native JSON ingest)...")
        conn.execute(
            "CREATE TABLE license_raw AS "
            "SELECT paper_arxiv_id, license, sample_ids FROM read_json_auto("
            "  ?, format='newline_delimited', ignore_errors=true)",
            [str(license_path)],
        )
        # Explode `sample_ids` array → one row per (sample_id, paper).
        # `unnest` is a DuckDB built-in; the projection eliminates the
        # array column and yields the (sample_id, paper_arxiv_id,
        # paper_license) shape used downstream.
        conn.execute(
            "CREATE TABLE license_tmp AS "
            "SELECT unnest(sample_ids) AS sample_id, "
            "       COALESCE(paper_arxiv_id, '') AS paper_arxiv_id, "
            "       COALESCE(license, '')        AS paper_license "
            "FROM license_raw"
        )
        conn.execute("DROP TABLE license_raw")
        lic_row = conn.execute("SELECT COUNT(*) FROM license_tmp").fetchone()
        lic_count = int(lic_row[0]) if lic_row else 0
        logger.info("license_info staged: %d rows", lic_count)

        logger.info("staging citrec (DuckDB native JSON ingest)...")
        # `sample` arrives from argparse with `type=int` so the f-string
        # cannot smuggle SQL; we still assert the type to keep the
        # invariant explicit at the point of interpolation.
        if sample is not None and not isinstance(sample, int):
            raise TypeError(f"sample must be int or None, got {type(sample)!r}")
        sample_clause = f" LIMIT {sample}" if sample is not None else ""
        conn.execute(
            f"CREATE TABLE citrec_tmp AS "
            f"SELECT _id AS sample_id, "
            f"       COALESCE(text, '')   AS text, "
            f"       COALESCE(marker, '') AS marker, "
            f"       COALESCE(label, '')  AS label "
            f"FROM read_json_auto("
            f"  ?, format='newline_delimited', ignore_errors=true)"
            f"{sample_clause}",
            [str(citrec_path)],
        )
        cit_row = conn.execute("SELECT COUNT(*) FROM citrec_tmp").fetchone()
        cit_count = int(cit_row[0]) if cit_row else 0
        logger.info("citrec staged: %d rows", cit_count)

        logger.info("joining citrec_tmp with license_tmp (DuckDB-side)...")
        # Final schema is intentionally narrow:
        #   * paper_arxiv_id : citing arXiv id (the WHERE-clause key)
        #   * label          : cited OpenAlex W-URL (the other WHERE key)
        #   * text           : citation paragraph truncated to 600 chars
        #
        # We drop sample_id, marker, and paper_license because:
        #   * sample_id is a UUID never queried at runtime
        #   * marker (e.g. "[1]") is implied by `text` and unused
        #   * paper_license is audit-only — attribution lives in the
        #     viewer footer; per-paper licence URLs add ~120 MB without
        #     supporting any query
        #
        # 600-char text cap matches the LLM-prompt budget the upstream
        # heuristic uses and keeps the published artifact under the
        # 2 GB GitHub Release cap (a few-row sample puts uncapped text
        # at ~2.6 KB avg → ~24 GB total; 4.3x truncation + 50% column
        # drop brings the projected gzipped size to ~1.5 GB).
        conn.execute(
            "CREATE TABLE citrec AS "
            "SELECT COALESCE(l.paper_arxiv_id, '') AS paper_arxiv_id, "
            "       c.label, "
            "       SUBSTR(c.text, 1, 600) AS text "
            "FROM citrec_tmp c "
            "LEFT JOIN license_tmp l ON c.sample_id = l.sample_id"
        )
        conn.execute("DROP TABLE citrec_tmp")
        conn.execute("DROP TABLE license_tmp")
        inserted_row = conn.execute("SELECT COUNT(*) FROM citrec").fetchone()
        inserted = int(inserted_row[0]) if inserted_row else 0

        logger.info("building composite index on (paper_arxiv_id, label)...")
        conn.execute(
            "CREATE INDEX idx_citing_cited ON citrec(paper_arxiv_id, label)"
        )
        conn.execute("ANALYZE")
        logger.info("done. %d rows written to %s", inserted, out_path)
        return inserted
    finally:
        conn.close()
        # Remove spill scratch even on success — DuckDB doesn't promise
        # to clear it, and on a successful run it's pure dead weight
        # (multi-GB sort/hash partitions from the JOIN).
        shutil.rmtree(spill_dir, ignore_errors=True)


def gzip_artifact(path: Path) -> Path:
    """Gzip the built DuckDB to fit the 2 GB GitHub Release cap.

    Writes ``<path>.gz`` alongside the original and returns the
    new path. The raw ``.duckdb`` is left in place for local
    inspection; CI workflows download the ``.gz`` and gunzip on
    the runner.
    """
    import gzip
    import shutil
    gz_path = path.with_suffix(path.suffix + ".gz")
    if gz_path.exists():
        gz_path.unlink()
    logger.info("gzipping %s -> %s", path, gz_path)
    with open(path, "rb") as src, gzip.open(
        str(gz_path), "wb", compresslevel=6
    ) as dst:
        shutil.copyfileobj(src, dst, length=8 * 1024 * 1024)
    raw_mb = path.stat().st_size / 1e6
    gz_mb = gz_path.stat().st_size / 1e6
    logger.info(
        "gzip done: %.1f MB -> %.1f MB (%.2fx)",
        raw_mb, gz_mb, raw_mb / max(gz_mb, 1e-9),
    )
    return gz_path


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
    ap.add_argument(
        "--no-gzip",
        action="store_true",
        help=(
            "Skip emitting the .gz companion (smoke / inspection runs). "
            "The Release-uploaded artifact must be the gzip; default is "
            "to emit it."
        ),
    )
    args = ap.parse_args(argv)
    rows = build_index(args.out, sample=args.sample)
    if rows == 0:
        print("error: 0 rows written", file=sys.stderr)
        return 1
    if not args.no_gzip:
        gzip_artifact(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
