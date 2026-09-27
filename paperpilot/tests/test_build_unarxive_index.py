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

# Sample IDs used across fixtures. Two papers, three citrec rows that all
# reconcile with license_info.
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
]

# A citrec row whose sample_id is unknown to license_info. It has no citing
# arXiv id, so it can never be looked up; the build must refuse it by
# default rather than publish it under an empty key.
_ORPHAN_ROW = {
    "_id": "s-orphan",
    "text": "Orphan row.",
    "marker": "[42]",
    "label": "https://openalex.org/W444",
}


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
    assert rows == [
        ("2211.06247", "https://openalex.org/W111"),
        ("2211.06247", "https://openalex.org/W222"),
        ("2103.09417", "https://openalex.org/W333"),
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
    assert sorted(p.name for p in out.parent.iterdir()) == sorted(
        ["out.duckdb", "license_info.jsonl", "train.jsonl"]
    ), (
        "spill scratch dir survived a successful build — finally clause "
        "regressed; multi-GB JOIN partitions would accumulate on operator "
        "machines across repeated runs"
    )


def test_build_index_cleans_spill_dir_on_failure(
    patched_hf, tmp_path: Path
) -> None:
    out = tmp_path / "out" / "out.duckdb"
    # The join gate raises after the scratch directory was created and
    # the connection opened, so reaching the cleanup is the point.
    _write_jsonl(patched_hf[1], [*_CITREC_ROWS, _ORPHAN_ROW])
    with pytest.raises(bi.UnarxiveBuildError):
        bi.build_index(out)
    assert list(out.parent.iterdir()) == []


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


# --------------------------------------------------------------------------- #
# reconciliation gates (round-4 review)                                       #
# --------------------------------------------------------------------------- #


def _write_jsonl(path: Path, rows: list) -> None:
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


def _existing_index(tmp_path: Path) -> tuple[Path, bytes]:
    out = tmp_path / "out" / "unarxive.duckdb"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"previous-good-index")
    return out, out.read_bytes()


def test_build_refuses_an_orphan_row_and_keeps_the_old_index(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(patched_hf[1], [*_CITREC_ROWS, _ORPHAN_ROW])
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="1 of 4 citrec rows"):
        bi.build_index(out)
    assert out.read_bytes() == before
    assert [p.name for p in out.parent.iterdir()] == [out.name]


def test_allowed_orphans_are_dropped_not_published_under_an_empty_key(
    patched_hf, tmp_path: Path
) -> None:
    _write_jsonl(patched_hf[1], [*_CITREC_ROWS, _ORPHAN_ROW])
    out = tmp_path / "out" / "unarxive.duckdb"
    assert bi.build_index(out, max_unmatched=1) == len(_CITREC_ROWS)
    con = duckdb.connect(str(out), read_only=True)
    try:
        empty = con.execute("SELECT COUNT(*) FROM citrec WHERE paper_arxiv_id = ''").fetchone()
    finally:
        con.close()
    assert empty == (0,)


def test_build_refuses_a_malformed_jsonl_line(patched_hf, tmp_path: Path) -> None:
    """ignore_errors=true used to drop corrupt lines without a count."""
    citrec = patched_hf[1]
    citrec.write_text(citrec.read_text() + '{"_id": "s-broken", "text": \n')
    out, before = _existing_index(tmp_path)
    with pytest.raises(Exception):  # noqa: B017 - duckdb's parse error type varies by version
        bi.build_index(out)
    assert out.read_bytes() == before


def test_build_refuses_a_license_row_without_an_arxiv_id(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(
        patched_hf[0],
        [
            _LICENSE_ROWS[0],
            {"paper_arxiv_id": None, "license": "x", "sample_ids": ["s-known-3"]},
        ],
    )
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="no license_info arXiv id"):
        bi.build_index(out)
    assert out.read_bytes() == before


def test_build_refuses_a_sample_id_claimed_by_two_papers(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(
        patched_hf[0],
        [*_LICENSE_ROWS, {"paper_arxiv_id": "2001.00001", "license": "x", "sample_ids": ["s-known-1"]}],
    )
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="more than one arXiv id"):
        bi.build_index(out)
    assert out.read_bytes() == before


def test_build_refuses_duplicate_citrec_rows(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(patched_hf[1], [*_CITREC_ROWS, _CITREC_ROWS[0]])
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="expected 4"):
        bi.build_index(out)
    assert out.read_bytes() == before


def test_main_reports_a_reconciliation_failure(patched_hf, tmp_path: Path, capsys) -> None:
    _write_jsonl(patched_hf[1], [*_CITREC_ROWS, _ORPHAN_ROW])
    out = tmp_path / "out.duckdb"
    assert bi.main(["--out", str(out), "--no-gzip"]) == 1
    assert "existing index left untouched" in capsys.readouterr().err
    assert bi.main(["--out", str(out), "--no-gzip", "--allow-unmatched", "1"]) == 0


def test_two_builds_use_distinct_scratch_directories(patched_hf, tmp_path: Path, monkeypatch) -> None:
    """Fixed `<out>.building` / `<out>.spill` names let a concurrent run
    delete the other's live database; each run now gets its own."""
    seen: list[str] = []
    real = bi.tempfile.TemporaryDirectory

    def recording(*args, **kwargs):
        handle = real(*args, **kwargs)
        seen.append(handle.name)
        return handle

    monkeypatch.setattr(bi.tempfile, "TemporaryDirectory", recording)
    out = tmp_path / "out" / "unarxive.duckdb"
    bi.build_index(out)
    bi.build_index(out)
    assert len(seen) == 2 and seen[0] != seen[1]
    assert all(Path(name).parent == out.parent for name in seen)


def test_gzip_leaves_no_partial_and_keeps_the_old_archive_on_failure(
    tmp_path: Path, monkeypatch
) -> None:
    src = _make_dummy_duckdb(tmp_path)
    gz = src.with_suffix(".duckdb.gz")
    gz.write_bytes(b"previous-archive")

    def boom(*_a, **_kw):
        raise OSError("disk full")

    monkeypatch.setattr(bi.os, "replace", boom)
    with pytest.raises(OSError):
        bi.gzip_artifact(src)
    assert gz.read_bytes() == b"previous-archive"
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([src.name, gz.name])


@pytest.mark.parametrize(
    "bad_id",
    [" 2211.06247 ", "not-an-arxiv-id", "2211.062", "2211.06247\n"],
    ids=["padded", "garbage", "short-serial", "trailing-newline"],
)
def test_build_refuses_a_malformed_license_arxiv_id(patched_hf, tmp_path: Path, bad_id) -> None:
    """A padded or garbage id joins and counts like a good one but is a key
    no runtime lookup can match."""
    _write_jsonl(patched_hf[0], [{**_LICENSE_ROWS[0], "paper_arxiv_id": bad_id}, _LICENSE_ROWS[1]])
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="malformed arXiv id"):
        bi.build_index(out)
    assert out.read_bytes() == before


def test_build_stores_the_versionless_id_the_runtime_queries(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(patched_hf[0], [{**_LICENSE_ROWS[0], "paper_arxiv_id": "2211.06247v3"}, _LICENSE_ROWS[1]])
    out = tmp_path / "out" / "unarxive.duckdb"
    bi.build_index(out)
    con = duckdb.connect(str(out), read_only=True)
    try:
        ids = {r[0] for r in con.execute("SELECT paper_arxiv_id FROM citrec").fetchall()}
    finally:
        con.close()
    assert ids == {"2211.06247", "2103.09417"}


def test_legacy_ids_are_dropped_with_a_count_not_published(patched_hf, tmp_path: Path) -> None:
    _write_jsonl(patched_hf[0], [_LICENSE_ROWS[0], {**_LICENSE_ROWS[1], "paper_arxiv_id": "hep-th/9901001"}])
    out = tmp_path / "out" / "unarxive.duckdb"
    assert bi.build_index(out) == 2
    con = duckdb.connect(str(out), read_only=True)
    try:
        ids = {r[0] for r in con.execute("SELECT paper_arxiv_id FROM citrec").fetchall()}
    finally:
        con.close()
    assert ids == {"2211.06247"}


@pytest.mark.parametrize(
    "mutation",
    [
        {"label": None},
        {"label": ""},
        {"label": "W333"},
        {"label": "https://example.com/W333"},
        {"text": None},
        {"text": "   "},
    ],
    ids=["null-label", "empty-label", "bare-label", "foreign-label", "null-text", "blank-text"],
)
def test_build_refuses_a_citrec_row_without_a_usable_label_or_text(
    patched_hf, tmp_path: Path, mutation
) -> None:
    """COALESCE-to-'' used to publish these as rows that count toward every
    reconciliation but can never be found or say nothing."""
    rows = [dict(r) for r in _CITREC_ROWS]
    rows[2].update(mutation)
    _write_jsonl(patched_hf[1], rows)
    out, before = _existing_index(tmp_path)
    with pytest.raises(bi.UnarxiveBuildError, match="lack a sample id, a text"):
        bi.build_index(out)
    assert out.read_bytes() == before
