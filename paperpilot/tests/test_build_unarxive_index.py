"""Tests for paperpilot.scripts.build_unarxive_index — the offline
unarXive DuckDB builder.

These tests mock ``hf_hub_download`` so no network is hit, and feed
DuckDB a tiny synthetic JSONL fixture written to ``tmp_path``. They
pin the three non-obvious invariants of the build:

- the published schema is exactly ``(paper_arxiv_id, label, text)``,
- ``text`` is truncated to 600 chars (matches the Release 2 GB cap
  budget; the upstream rows are ~2.6 KB avg),
- the spill scratch dir is removed on both success and failure.

Plus the CLI surface (``--sample`` / ``--no-gzip``) and the gzip
companion roundtrip.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from paperpilot.scripts import build_unarxive_index as bi

# duckdb and huggingface_hub are operator-only deps for the offline
# build (CLAUDE.md "unarXive DuckDB アーティファクト" runbook); the
# project's default test environment does not install them. Skip the
# whole module cleanly when they're absent so the suite still runs for
# non-operator contributors. ``bi`` itself is fine to import without
# duckdb — it only imports the package inside ``_import_or_die()`` at
# call time.
duckdb = pytest.importorskip(
    "duckdb",
    reason="install with `uv pip install duckdb huggingface_hub` to "
    "exercise the unarXive build tests",
)


# --------------------------------------------------------------------------- #
# fixtures                                                                    #
# --------------------------------------------------------------------------- #

# Sample IDs used across fixtures. Two papers, three citrec rows, plus one
# orphan citrec row whose sample_id is unknown to license_info so it
# exercises the LEFT JOIN -> COALESCE-to-empty-string path.
_LICENSE_ROWS = [
    {
        "paper_arxiv_id": "2211.06247",
        "license": "arxiv-perpetual-license",
        "sample_ids": ["s-known-1", "s-known-2"],
    },
    {
        "paper_arxiv_id": "2103.09417",
        "license": "cc-by-4.0",
        "sample_ids": ["s-known-3"],
    },
]

_CITREC_ROWS = [
    {
        "_id": "s-known-1",
        "text": "Short citation paragraph.",
        "marker": "[1]",
        "label": "https://openalex.org/W111",
    },
    {
        "_id": "s-known-2",
        # 1500 chars — well over the 600-char SUBSTR cap, so we can pin
        # the truncation invariant.
        "text": "x" * 1500,
        "marker": "[2]",
        "label": "https://openalex.org/W222",
    },
    {
        "_id": "s-known-3",
        "text": "Another paragraph.",
        "marker": "[1]",
        "label": "https://openalex.org/W333",
    },
    {
        "_id": "s-orphan",  # no matching license row -> empty arxiv_id
        "text": "Orphan row.",
        "marker": "[42]",
        "label": "https://openalex.org/W444",
    },
]


@pytest.fixture
def jsonl_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Write the license_info + citrec JSONL fixtures to tmp_path."""
    license_path = tmp_path / "license_info.jsonl"
    citrec_path = tmp_path / "train.jsonl"
    license_path.write_text(
        "\n".join(json.dumps(r) for r in _LICENSE_ROWS) + "\n"
    )
    citrec_path.write_text(
        "\n".join(json.dumps(r) for r in _CITREC_ROWS) + "\n"
    )
    return license_path, citrec_path


@pytest.fixture
def patched_hf(
    monkeypatch: pytest.MonkeyPatch, jsonl_pair: tuple[Path, Path]
) -> tuple[Path, Path]:
    """Patch ``_import_or_die`` so build_index() picks up the local JSONL
    files instead of calling the real ``hf_hub_download``."""
    license_path, citrec_path = jsonl_pair

    def fake_hf(*, repo_id: str, filename: str, repo_type: str) -> str:
        # The build script asks for exactly these two filenames; map them
        # to the local fixtures. Any other filename is a test bug.
        if filename == "license_info.jsonl":
            return str(license_path)
        if filename == "data/train.jsonl":
            return str(citrec_path)
        raise AssertionError(f"unexpected hf_hub_download filename: {filename}")

    monkeypatch.setattr(
        bi,
        "_import_or_die",
        lambda: (duckdb, fake_hf),
    )
    return license_path, citrec_path


@pytest.fixture
def built_db(patched_hf, tmp_path: Path) -> Iterator[Path]:
    """Run a full build_index() and yield the output path."""
    out = tmp_path / "out" / "unarxive.duckdb"
    rows = bi.build_index(out)
    assert rows > 0, "build_index returned zero rows; fixture broken"
    yield out


# --------------------------------------------------------------------------- #
# build_index                                                                 #
# --------------------------------------------------------------------------- #


def test_build_index_writes_3col_schema(built_db: Path) -> None:
    con = duckdb.connect(str(built_db), read_only=True)
    try:
        cols = [r[0] for r in con.execute("DESCRIBE citrec").fetchall()]
    finally:
        con.close()
    # Order matters: the column tuple is the operator-visible contract.
    assert cols == ["paper_arxiv_id", "label", "text"]


def test_build_index_truncates_text_to_600_chars(built_db: Path) -> None:
    con = duckdb.connect(str(built_db), read_only=True)
    try:
        # The 1500-char fixture row maps to label W222.
        text = con.execute(
            "SELECT text FROM citrec WHERE label = 'https://openalex.org/W222'"
        ).fetchone()[0]
    finally:
        con.close()
    assert len(text) == 600
    assert text == "x" * 600


def test_build_index_creates_composite_index(built_db: Path) -> None:
    con = duckdb.connect(str(built_db), read_only=True)
    try:
        rows = con.execute(
            "SELECT index_name, sql FROM duckdb_indexes() "
            "WHERE table_name = 'citrec'"
        ).fetchall()
    finally:
        con.close()
    assert len(rows) == 1
    index_name, sql = rows[0]
    assert index_name == "idx_citing_cited"
    # The composite ordering (paper_arxiv_id, label) is the WHERE-clause
    # key shape — flipping the columns would silently de-optimise lookups.
    assert "paper_arxiv_id" in sql and "label" in sql
    assert sql.index("paper_arxiv_id") < sql.index("label")


def test_build_index_joins_via_sample_id(built_db: Path) -> None:
    con = duckdb.connect(str(built_db), read_only=True)
    try:
        rows = con.execute(
            "SELECT paper_arxiv_id, label FROM citrec ORDER BY label"
        ).fetchall()
    finally:
        con.close()
    # Three known rows resolve, the orphan picks up empty arxiv_id.
    assert rows == [
        ("2211.06247", "https://openalex.org/W111"),
        ("2211.06247", "https://openalex.org/W222"),
        ("2103.09417", "https://openalex.org/W333"),
        ("", "https://openalex.org/W444"),
    ]


def test_build_index_returns_row_count(patched_hf, tmp_path: Path) -> None:
    rows = bi.build_index(tmp_path / "out.duckdb")
    assert rows == len(_CITREC_ROWS)


def test_build_index_sample_limit_applies(patched_hf, tmp_path: Path) -> None:
    rows = bi.build_index(tmp_path / "out.duckdb", sample=2)
    # `LIMIT 2` is applied during citrec staging, so the post-JOIN count
    # is also 2 (license JOIN is many-to-one or no-match, never explodes).
    assert rows == 2


def test_build_index_rejects_non_int_sample(
    patched_hf, tmp_path: Path
) -> None:
    # The CLI guards `--sample` with `type=int`, but build_index() is also
    # importable from other Python code; the explicit TypeError protects
    # the f-string LIMIT interpolation from a wrong-type caller.
    with pytest.raises(TypeError, match="sample must be int or None"):
        bi.build_index(tmp_path / "out.duckdb", sample="5")  # type: ignore[arg-type]


def test_build_index_overwrites_existing_output(
    patched_hf, tmp_path: Path
) -> None:
    out = tmp_path / "out.duckdb"
    out.write_bytes(b"garbage-not-a-duckdb-file")
    rows = bi.build_index(out)
    # If the pre-existing file wasn't unlinked, duckdb.connect() would
    # raise on the corrupt header. Successful row count proves the
    # rebuild path.
    assert rows == len(_CITREC_ROWS)


def test_build_index_cleans_spill_dir_on_success(
    patched_hf, tmp_path: Path
) -> None:
    out = tmp_path / "out.duckdb"
    bi.build_index(out)
    spill = out.parent / f"{out.name}.spill"
    assert not spill.exists(), (
        "spill scratch dir survived a successful build — finally clause "
        "regressed; multi-GB JOIN partitions would accumulate on operator "
        "machines across repeated runs"
    )


def test_build_index_cleans_spill_dir_on_failure(
    patched_hf, tmp_path: Path
) -> None:
    out = tmp_path / "out.duckdb"
    spill = out.parent / f"{out.name}.spill"
    # The TypeError raises *after* the spill_dir was created and the
    # connection opened, so reaching the finally is the whole point of
    # this test.
    with pytest.raises(TypeError):
        bi.build_index(out, sample="bad")  # type: ignore[arg-type]
    assert not spill.exists()


# --------------------------------------------------------------------------- #
# gzip_artifact                                                               #
# --------------------------------------------------------------------------- #


def _make_dummy_duckdb(tmp_path: Path) -> Path:
    """gzip_artifact only cares that the source file exists and is
    readable — no DuckDB validation. A small deterministic payload is
    enough and keeps the test fast."""
    src = tmp_path / "fake.duckdb"
    src.write_bytes(b"payload-bytes-" * 1024)  # 14 KB
    return src


def test_gzip_artifact_emits_companion(tmp_path: Path) -> None:
    src = _make_dummy_duckdb(tmp_path)
    gz = bi.gzip_artifact(src)
    assert gz == src.with_suffix(".duckdb.gz")
    assert gz.exists()
    # Source is preserved for local inspection — the operator docs
    # explicitly call this out.
    assert src.exists()


def test_gzip_artifact_roundtrip_recovers_bytes(tmp_path: Path) -> None:
    src = _make_dummy_duckdb(tmp_path)
    gz = bi.gzip_artifact(src)
    with gzip.open(gz, "rb") as fp:
        recovered = fp.read()
    assert recovered == src.read_bytes()


def test_gzip_artifact_overwrites_existing_gz(tmp_path: Path) -> None:
    src = _make_dummy_duckdb(tmp_path)
    stale = src.with_suffix(".duckdb.gz")
    stale.write_bytes(b"stale-content-from-previous-run")
    gz = bi.gzip_artifact(src)
    with gzip.open(gz, "rb") as fp:
        assert fp.read() == src.read_bytes()


# --------------------------------------------------------------------------- #
# main / CLI                                                                  #
# --------------------------------------------------------------------------- #


def test_main_returns_zero_on_success(patched_hf, tmp_path: Path) -> None:
    out = tmp_path / "out.duckdb"
    rc = bi.main(["--out", str(out), "--no-gzip"])
    assert rc == 0
    assert out.exists()


def test_main_no_gzip_flag_skips_companion(
    patched_hf, tmp_path: Path
) -> None:
    out = tmp_path / "out.duckdb"
    bi.main(["--out", str(out), "--no-gzip"])
    assert not out.with_suffix(".duckdb.gz").exists()


def test_main_emits_gzip_by_default(patched_hf, tmp_path: Path) -> None:
    out = tmp_path / "out.duckdb"
    bi.main(["--out", str(out)])
    gz = out.with_suffix(".duckdb.gz")
    assert gz.exists()
    # Sanity: it's actually a valid gzip stream.
    with gzip.open(gz, "rb") as fp:
        head = fp.read(16)
    assert head, "gzip companion was emitted but empty"


def test_main_returns_one_when_no_rows_written(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    out = tmp_path / "out.duckdb"
    monkeypatch.setattr(bi, "build_index", lambda *a, **kw: 0)
    rc = bi.main(["--out", str(out)])
    assert rc == 1
