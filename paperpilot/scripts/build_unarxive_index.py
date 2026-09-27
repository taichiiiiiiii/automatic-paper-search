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
import os
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from paperpilot.identity.source_ids import ARXIV_MODERN_PATTERN
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


# The shared grammar (identity.source_ids) as DuckDB regexes. Versions are
# tolerated on input and stripped on the way in.
_MODERN_ID_SQL = rf"{ARXIV_MODERN_PATTERN}(v[0-9]+)?"
_LEGACY_ID_SQL = r"[A-Za-z][A-Za-z0-9.-]*/[0-9]{7}(v[0-9]+)?"
# What paperpilot.utils.unarxive queries the `label` column with.
_OPENALEX_LABEL_SQL = r"https://openalex\.org/W[0-9]+"


class UnarxiveBuildError(RuntimeError):
    """The inputs did not reconcile; the published index was left untouched."""


def _count(conn: Any, sql: str, params: list[Any] | None = None) -> int:
    row = conn.execute(sql, params or []).fetchone()
    return int(row[0]) if row else 0


def build_index(
    out_path: Path, *, sample: int | None = None, max_unmatched: int = 0
) -> int:
    """Download saier/unarXive_citrec and write a DuckDB index.

    ``sample``: if set, only the first N rows are ingested
    (development / smoke tests). Production builds use the full
    dataset (``sample=None``).

    ``max_unmatched``: how many citrec rows may lack a license_info
    row (and so a citing arXiv id). Such rows are never published —
    an empty ``paper_arxiv_id`` matches no lookup and only hides how
    much of the corpus was lost. The default of 0 fails closed; an
    operator who has confirmed upstream orphans raises it explicitly.

    Returns the number of rows written. Raises ``UnarxiveBuildError``
    — leaving any existing index in place — when an input line is
    malformed, the join loses or duplicates rows beyond the allowance,
    or nothing would be written.
    """
    duckdb, hf_hub_download = _import_or_die()
    if sample is not None and not isinstance(sample, int):
        raise TypeError(f"sample must be int or None, got {type(sample)!r}")

    out_path.parent.mkdir(parents=True, exist_ok=True)

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

    # One private scratch directory per run, next to the output (same
    # volume, so the final os.replace is a rename). It holds the
    # database under construction and DuckDB's spill partitions. Fixed
    # names (`<out>.building`, `<out>.spill`) let a second concurrent
    # run delete the first one's live database and spill files.
    with tempfile.TemporaryDirectory(
        dir=out_path.parent, prefix=f".{out_path.name}.build-"
    ) as work_dir:
        work = Path(work_dir)
        build_path = work / out_path.name
        spill_dir = work / "spill"
        spill_dir.mkdir()

        logger.info("opening DuckDB at %s", build_path)
        conn: Any | None = duckdb.connect(str(build_path))
        try:
            # Constrain DuckDB's working memory and route spills to a known
            # location on the same volume as ``out_path``. Without these,
            # the initial ``read_json_auto`` over the ~18 GB citrec JSONL
            # can OOM on memory-constrained machines (observed: silent kill
            # on a host with 3.8 GB RAM / 2 GB swap). The PRAGMA values use
            # parameterised binding so a path containing a quote can't
            # break out of the statement.
            conn.execute("PRAGMA memory_limit='2GB'")
            conn.execute("SET temp_directory = ?", [str(spill_dir)])
            conn.execute("PRAGMA threads=2")
            logger.info(
                "duckdb tuned: memory_limit=2GB, temp_directory=%s, threads=2",
                spill_dir,
            )

            # ignore_errors=false: a malformed line aborts the build. With
            # `true` DuckDB dropped such lines without a count, so a
            # transfer-corrupted download published as a smaller index
            # that looked complete.
            logger.info("staging license_info (DuckDB native JSON ingest)...")
            conn.execute(
                "CREATE TABLE license_raw AS "
                "SELECT paper_arxiv_id, license, sample_ids FROM read_json_auto("
                "  ?, format='newline_delimited', ignore_errors=false)",
                [str(license_path)],
            )
            # A present arXiv id must be a real one, exactly: the runtime
            # looks rows up by the bare modern form, so a padded or garbage
            # id would join, count and publish as a key nothing can match.
            malformed_ids = _count(
                conn,
                "SELECT COUNT(*) FROM license_raw "
                "WHERE paper_arxiv_id IS NOT NULL AND paper_arxiv_id <> '' "
                "AND NOT regexp_full_match(paper_arxiv_id, ?) "
                "AND NOT regexp_full_match(paper_arxiv_id, ?)",
                [_MODERN_ID_SQL, _LEGACY_ID_SQL],
            )
            if malformed_ids:
                raise UnarxiveBuildError(
                    f"{malformed_ids} license_info rows carry a malformed arXiv id"
                )
            # Explode `sample_ids` array → one row per (sample_id, paper),
            # storing the versionless modern id the runtime queries. A row
            # without an arXiv id contributes no sample ids; the citrec rows
            # that needed it are counted as unmatched below instead of being
            # published under ''. Legacy ids are well-formed but outside the
            # runtime's modern-only lookup, so they are flagged and dropped
            # with a count rather than failing the build.
            conn.execute(
                "CREATE TABLE license_tmp AS "
                "SELECT unnest(sample_ids) AS sample_id, "
                "       regexp_replace(paper_arxiv_id, 'v[0-9]+$', '') AS paper_arxiv_id, "
                "       regexp_full_match(paper_arxiv_id, ?) AS is_modern "
                "FROM license_raw "
                "WHERE paper_arxiv_id IS NOT NULL AND paper_arxiv_id <> ''",
                [_MODERN_ID_SQL],
            )
            conn.execute("DROP TABLE license_raw")
            lic_count = _count(conn, "SELECT COUNT(*) FROM license_tmp")
            logger.info("license_info staged: %d rows", lic_count)
            duplicate_ids = _count(
                conn,
                "SELECT COUNT(*) FROM (SELECT sample_id FROM license_tmp "
                "GROUP BY sample_id HAVING COUNT(DISTINCT paper_arxiv_id) > 1)",
            )
            if duplicate_ids:
                # One citation paragraph cannot belong to two citing papers;
                # joining would duplicate it under both.
                raise UnarxiveBuildError(
                    f"{duplicate_ids} sample_ids map to more than one arXiv id"
                )

            logger.info("staging citrec (DuckDB native JSON ingest)...")
            # `sample` is type-checked above, so the f-string cannot
            # smuggle SQL.
            sample_clause = f" LIMIT {sample}" if sample is not None else ""
            conn.execute(
                f"CREATE TABLE citrec_tmp AS "
                f"SELECT _id AS sample_id, text, label "
                f"FROM read_json_auto("
                f"  ?, format='newline_delimited', ignore_errors=false)"
                f"{sample_clause}",
                [str(citrec_path)],
            )
            cit_count = _count(conn, "SELECT COUNT(*) FROM citrec_tmp")
            logger.info("citrec staged: %d rows", cit_count)
            # `label` is half of the runtime lookup key and `text` is the
            # payload. Coalescing a missing one to '' used to publish rows
            # that count toward every reconciliation yet can never be found
            # (label) or say nothing (text).
            malformed_rows = _count(
                conn,
                "SELECT COUNT(*) FROM citrec_tmp WHERE "
                "sample_id IS NULL OR TRIM(CAST(sample_id AS VARCHAR)) = '' "
                "OR text IS NULL OR TRIM(CAST(text AS VARCHAR)) = '' "
                "OR label IS NULL OR NOT regexp_full_match(CAST(label AS VARCHAR), ?)",
                [_OPENALEX_LABEL_SQL],
            )
            if malformed_rows:
                raise UnarxiveBuildError(
                    f"{malformed_rows} citrec rows lack a sample id, a text, "
                    "or an OpenAlex work label"
                )
            unmatched = _count(
                conn,
                "SELECT COUNT(*) FROM citrec_tmp c WHERE NOT EXISTS "
                "(SELECT 1 FROM license_tmp l WHERE l.sample_id = c.sample_id)",
            )
            if unmatched > max_unmatched:
                raise UnarxiveBuildError(
                    f"{unmatched} of {cit_count} citrec rows have no license_info "
                    f"arXiv id (allowed: {max_unmatched})"
                )
            if unmatched:
                logger.warning(
                    "dropping %d citrec rows with no license_info arXiv id "
                    "(allowed by --allow-unmatched)",
                    unmatched,
                )
            legacy = _count(
                conn,
                "SELECT COUNT(DISTINCT c.sample_id) FROM citrec_tmp c "
                "JOIN license_tmp l ON c.sample_id = l.sample_id WHERE NOT l.is_modern",
            )
            if legacy:
                logger.info(
                    "dropping %d citrec rows cited by pre-2007 arXiv ids "
                    "(the runtime looks up modern ids only)",
                    legacy,
                )

            logger.info("joining citrec_tmp with license_tmp (DuckDB-side)...")
            # Final schema is intentionally narrow:
            #   * paper_arxiv_id : citing arXiv id (the WHERE-clause key)
            #   * label          : cited OpenAlex W-URL (the other WHERE key)
            #   * text           : citation paragraph truncated to 600 chars
            #
            # sample_id (a UUID never queried), marker (implied by `text`)
            # and paper_license (audit-only; attribution lives in the viewer
            # footer, ~120 MB) are dropped.
            #
            # 600-char text cap matches the LLM-prompt budget the upstream
            # heuristic uses and keeps the published artifact under the
            # 2 GB GitHub Release cap (a few-row sample puts uncapped text
            # at ~2.6 KB avg → ~24 GB total; 4.3x truncation + 50% column
            # drop brings the projected gzipped size to ~1.5 GB).
            conn.execute(
                "CREATE TABLE citrec AS "
                "SELECT DISTINCT ON (c.sample_id) "
                "       l.paper_arxiv_id, c.label, SUBSTR(c.text, 1, 600) AS text "
                "FROM citrec_tmp c "
                "JOIN license_tmp l ON c.sample_id = l.sample_id "
                "WHERE l.is_modern"
            )
            inserted = _count(conn, "SELECT COUNT(*) FROM citrec")
            expected = cit_count - unmatched - legacy
            if inserted != expected:
                # Duplicate citrec sample_ids, or a join that did not
                # behave as reconciled above.
                raise UnarxiveBuildError(
                    f"joined {inserted} rows, expected {expected} "
                    f"({cit_count} staged - {unmatched} unmatched - {legacy} legacy)"
                )
            if inserted == 0:
                raise UnarxiveBuildError("0 rows would be written")
            conn.execute("DROP TABLE citrec_tmp")
            conn.execute("DROP TABLE license_tmp")

            logger.info("building composite index on (paper_arxiv_id, label)...")
            conn.execute(
                "CREATE INDEX idx_citing_cited ON citrec(paper_arxiv_id, label)"
            )
            conn.execute("ANALYZE")
            conn.close()
            conn = None
            # Only now is there something worth publishing. os.replace is
            # atomic on POSIX, so a reader either sees the old index or the
            # new one, never a partial file.
            os.replace(build_path, out_path)
            logger.info("done. %d rows written to %s", inserted, out_path)
            return inserted
        finally:
            if conn is not None:
                conn.close()
            # Leaving the `with` removes the scratch directory — the
            # half-built database and multi-GB spill partitions — on
            # success and failure alike.


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
    # Same reasoning as build_index: compress to a sibling and swap, so
    # an interrupted run leaves the previous .gz intact instead of
    # nothing (or a truncated archive that gunzips to garbage). The
    # sibling name is unique per run: a fixed `.partial` let a second
    # run truncate the first one's in-progress archive.
    logger.info("gzipping %s -> %s", path, gz_path)
    partial: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=gz_path.parent, prefix=f".{gz_path.name}.", suffix=".partial", delete=False
        ) as handle:
            partial = Path(handle.name)
            with open(path, "rb") as src, gzip.GzipFile(
                filename=gz_path.name, mode="wb", fileobj=handle, compresslevel=6
            ) as dst:
                shutil.copyfileobj(src, dst, length=8 * 1024 * 1024)
        os.chmod(partial, 0o644)
        os.replace(partial, gz_path)
        partial = None
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)
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
    ap.add_argument(
        "--allow-unmatched",
        type=int,
        default=0,
        metavar="N",
        help=(
            "Tolerate up to N citrec rows with no license_info arXiv id "
            "(they are dropped, not published). Default 0 fails closed."
        ),
    )
    args = ap.parse_args(argv)
    try:
        rows = build_index(args.out, sample=args.sample, max_unmatched=args.allow_unmatched)
    except UnarxiveBuildError as exc:
        print(f"error: {exc}; existing index left untouched", file=sys.stderr)
        return 1
    if rows == 0:
        print("error: 0 rows written", file=sys.stderr)
        return 1
    if not args.no_gzip:
        gzip_artifact(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
