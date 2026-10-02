"""Tests for paperpilot/scripts/build_pages.py.

The script converts summary.csv -> docs/<conference>/papers.json, which
the static viewer consumes. These tests cover:
    - tag column splits on whitespace
    - authors column splits on ';' or ','
    - conferences.json index is written with aggregated stats
    - missing summary.csv is a no-op (skip) rather than a crash
    - published files are replaced atomically, and only after the no-JS
      projection validates
    - a build smaller than the published catalog is refused before anything is written,
      and so is one that loses Oral labels, published paper_ids or abstract / author
      content while keeping the row count (unless --allow-shrink, or --allow-shrink-for
      for one conference only)
    - a scoped --conference build that finds nothing to build exits non-zero, while an
      unscoped build keeps skipping
    - a full build prepares every selected conference before publishing any of them,
      so one refused or invalid conference leaves the whole site byte-identical
    - the committed docs/<conference>/papers.json files are byte-for-byte what this
      build would publish, including the trailing newline
    - the spreadsheet formula guard build_summary_csv writes into summary.csv never
      becomes catalog text, and the "generated" stamp comes from the collection that
      CSV was built from (its sidecar), falling back to the newest dated collection
      when the sidecar is missing, unreadable or names a file that is not there
"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path

import pytest

from paperpilot.identity import IdentityError
from paperpilot.scripts import build_pages, build_summary_csv


def _write_summary(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "title",
        "type",
        "tags",
        "venue",
        "authors",
        "arxiv_url",
        "pdf_url",
        "abstract",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
        "source",
        "source_id",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in fields})


# ---- abstract preview ----


def test_abstract_preview_keeps_short_text_verbatim():
    assert build_pages._abstract_preview("a short abstract") == "a short abstract"
    assert build_pages._abstract_preview("") == ""
    assert build_pages._abstract_preview(None) == ""


def test_abstract_preview_trims_long_text_on_word_boundary():
    long = "word " * 200  # 1000 chars
    out = build_pages._abstract_preview(long)
    assert out.endswith("…")  # single codepoint U+2026
    assert len(out) <= build_pages._ABSTRACT_PREVIEW_CHARS + 1  # +1 for the ellipsis char
    assert "word word" in out  # whole words retained
    assert not out[:-1].endswith(" ")  # no trailing space before the ellipsis


def test_abstract_preview_hard_cuts_single_long_token():
    # No space to break on -> hard cut at the limit, then the ellipsis.
    out = build_pages._abstract_preview("a" * 500)
    assert out.endswith("…")
    assert len(out) == build_pages._ABSTRACT_PREVIEW_CHARS + 1


def test_abstract_preview_in_papers_json(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")
    long_abstract = "lorem ipsum " * 60  # ~720 chars
    _write_summary(
        project / "output" / "iclr-2026" / "summary.csv",
        [
            {
                "title": "T",
                "type": "Poster",
                "tags": "",
                "authors": "",
                "abstract": long_abstract,
                "arxiv_url": "https://arxiv.org/abs/2404.00005",
            }
        ],
    )
    build_pages.build_conference("iclr-2026")
    data = json.loads((tmp_path / "docs" / "iclr-2026" / "papers.json").read_text(encoding="utf-8"))
    assert data[0]["abstract"].endswith("…")
    assert len(data[0]["abstract"]) <= build_pages._ABSTRACT_PREVIEW_CHARS + 1


# ---- load_summary ----


def test_load_summary_splits_tags_and_authors(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "Paper One",
                "type": "Oral",
                "tags": "LLM Transformer",
                "venue": "ICLR",
                "authors": "Alice; Bob, Carol",  # mixed separators
                "arxiv_url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "http://arxiv.org/pdf/2404.00001",
                "abstract": "abstract one",
            }
        ],
    )

    rows = build_pages.load_summary(summary)
    assert len(rows) == 1
    assert rows[0]["tags"] == ["LLM", "Transformer"]
    assert rows[0]["authors"] == ["Alice", "Bob", "Carol"]


def test_load_summary_empty_tags_becomes_empty_list(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "T",
                "type": "Poster",
                "tags": "",
                "authors": "",
                "arxiv_url": "https://arxiv.org/abs/2404.00006",
            }
        ],
    )
    rows = build_pages.load_summary(summary)
    assert rows[0]["tags"] == []
    assert rows[0]["authors"] == []


def test_load_summary_adds_deterministic_native_identity(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "Identity",
                "type": "Poster",
                "tags": "",
                "authors": "",
                "arxiv_url": "https://openreview.net/forum?id=AbC_123",
            }
        ],
    )
    rows = build_pages.load_summary(summary)
    assert rows[0]["source"] == "openreview"
    assert rows[0]["source_id"] == "AbC_123"
    assert len(rows[0]["paper_id"]) == 40


def test_write_detail_shards_is_compact_and_prefix_partitioned(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path)
    details = {
        "00" + "a" * 38: "full zero",
        "ff" + "b" * 38: "full ff",
    }
    outputs = build_pages.write_detail_shards(details)
    assert len(outputs) == 256
    zero = json.loads((tmp_path / "paper-details-v1" / "00.json").read_text())
    middle = json.loads((tmp_path / "paper-details-v1" / "7a.json").read_text())
    assert zero == {
        "schema_version": "paper-details-v1",
        "prefix": "00",
        "papers": [["00" + "a" * 38, "full zero"]],
    }
    assert middle["papers"] == []


# ---- build_conference ----


def test_build_conference_writes_papers_json(tmp_path: Path, monkeypatch):
    # Redirect PROJECT and DOCS_ROOT so the test writes into tmp_path
    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    _write_summary(
        project / "output" / "iclr-2026" / "summary.csv",
        [
            {
                "title": "A",
                "type": "Oral",
                "tags": "LLM Theory",
                "venue": "ICLR",
                "authors": "X",
                "arxiv_url": "https://arxiv.org/abs/2404.00001",
                "pdf_url": "p",
                "abstract": "a",
            },
            {
                "title": "B",
                "type": "Poster",
                "tags": "LLM",
                "venue": "ICLR",
                "authors": "Y",
                "arxiv_url": "https://arxiv.org/abs/2404.00002",
                "pdf_url": "p",
                "abstract": "b",
            },
        ],
    )

    result = build_pages.build_conference("iclr-2026")
    assert result is not None
    assert result["papers"] == 2
    assert result["types"] == {"Oral": 1, "Poster": 1}
    # LLM hits twice, Theory once — top_tags is sorted by count descending
    top_tags = dict(result["top_tags"])
    assert top_tags["LLM"] == 2
    assert top_tags["Theory"] == 1

    # papers.json is written next to the viewer's HTML
    papers_json = docs_root / "iclr-2026" / "papers.json"
    assert papers_json.exists()
    assert (docs_root / "iclr-2026" / "paper-links.html").exists()
    data = json.loads(papers_json.read_text(encoding="utf-8"))
    assert {p["title"] for p in data} == {"A", "B"}
    # tags column must round-trip as a list
    assert all(isinstance(p["tags"], list) for p in data)
    assert all(len(p["paper_id"]) == 40 for p in data)
    assert {p["source"] for p in data} == {"arxiv"}


def test_load_summary_carries_structured_ids(tmp_path: Path):
    """papers.json must keep arxiv_id / citation_count / venue_tier / github_stars

    so the lineage builder can skip the S2 re-lookup (rule §12) and the
    viewer can size nodes by citation count without another API call.
    """
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "P",
                "type": "Oral",
                "tags": "LLM",
                "authors": "X",
                "arxiv_url": "http://arxiv.org/abs/2404.00001",
                "pdf_url": "p",
                "abstract": "a",
                "arxiv_id": "2404.00001",
                "citation_count": "17",
                "venue_tier": "3",
                "github_stars": "250",
            }
        ],
    )

    rows = build_pages.load_summary(summary)
    assert rows[0]["arxiv_id"] == "2404.00001"
    # Numeric fields are parsed as ints so the viewer can skip type coercion
    assert rows[0]["citation_count"] == 17
    assert rows[0]["venue_tier"] == 3
    assert rows[0]["github_stars"] == 250


def test_load_summary_numeric_fields_missing_become_none(tmp_path: Path):
    summary = tmp_path / "summary.csv"
    _write_summary(
        summary,
        [
            {
                "title": "Legacy",
                "type": "Poster",
                "tags": "",
                "authors": "",
                "arxiv_id": "",
                "citation_count": "",
                "venue_tier": "",
                "github_stars": "",
                "arxiv_url": "https://arxiv.org/abs/2404.00002",
            }
        ],
    )
    rows = build_pages.load_summary(summary)
    assert rows[0]["arxiv_id"] == ""
    assert rows[0]["citation_count"] is None
    assert rows[0]["venue_tier"] is None
    assert rows[0]["github_stars"] is None


# ---- the spreadsheet formula guard must not become catalog text ----


def _write_collector_csv(path: Path, rows: list[dict[str, str]]) -> None:
    """A pipeline `papers_*.csv` — the file build_summary_csv turns into summary.csv.

    Its cells are written formula-neutralized by the collectors, exactly as below: the
    guard prefix is already there when the reader starts.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "title",
        "authors",
        "abstract",
        "url",
        "pdf_url",
        "venue",
        "arxiv_id",
        "citation_count",
        "venue_tier",
        "github_stars",
        "source",
        "source_id",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in fields})


def _collector_row(index: int, title: str) -> dict[str, str]:
    return {
        "title": title,
        "authors": "X",
        "abstract": "a",
        "url": f"https://arxiv.org/abs/2404.0000{index}",
        "pdf_url": f"https://arxiv.org/pdf/2404.0000{index}",
        "venue": "ICLR",
    }


def test_formula_guard_round_trips_into_the_catalog(tmp_path: Path, monkeypatch) -> None:
    """A title the guard prefixes stays protected in the CSVs and is published as itself.

    The chain is the real one: collector `papers_*.csv` -> `summary.csv` ->
    `papers.json` / `paper-links.html`. ``neutralize`` adds a leading "'" so a
    spreadsheet does not evaluate the cell; that prefix is not part of the title, so the
    reader that publishes the catalog has to remove it — otherwise the viewer searches,
    links and shows "'-Deep nets" for the paper called "-Deep nets".
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    conf_dir = project / "output" / "iclr-2026"
    _write_collector_csv(
        conf_dir / "papers_2026-06-28.csv",
        [
            _collector_row(1, "'-Deep nets"),  # neutralized "-Deep nets"
            _collector_row(2, "'=SUM(1,1)"),  # neutralized "=SUM(1,1)"
            _collector_row(3, "'Deep nets"),  # a real apostrophe: content, never prefixed
        ],
    )

    build_summary_csv.build(conference_dir=conf_dir)
    build_pages.build_conference("iclr-2026")

    # summary.csv keeps the guard for the human who opens it, and never doubles it.
    with (conf_dir / "summary.csv").open(encoding="utf-8", newline="") as f:
        assert [row["title"] for row in csv.DictReader(f)] == [
            "'Deep nets",
            "'-Deep nets",
            "'=SUM(1,1)",
        ]

    published = json.loads((docs_root / "iclr-2026" / "papers.json").read_text(encoding="utf-8"))
    assert [p["title"] for p in published] == ["'Deep nets", "-Deep nets", "=SUM(1,1)"]
    fallback = (docs_root / "iclr-2026" / "paper-links.html").read_text(encoding="utf-8")
    assert ">-Deep nets</a>" in fallback
    assert "'-Deep nets" not in fallback


def test_build_conference_returns_none_when_summary_missing(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    (project / "output" / "empty-conf").mkdir(parents=True)  # no summary.csv
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    assert build_pages.build_conference("empty-conf") is None


@pytest.mark.parametrize(
    "conference",
    (
        "/tmp/absolute",
        "../escape",
        "dot.segment",
        "Upper-2026",
        # Rejected by the collectors' shared validator, so a build must not
        # accept a shape no collector could ever have written.
        "a--b",
        "-cvpr-2026",
        "cvpr-2026-",
        "cvpr-2026\n",
        "a" * 65,
        # Reserved docs/ public paths (scaffold_conference_page's own set).
        "daily",
        "themes",
        "assets",
        "paper-details-v1",
        "paper-slides-v1",
        "search-paper-ids-v1",
        "how-it-works",
    ),
)
def test_conference_slug_is_rejected_before_filesystem_access(
    conference: str, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(build_pages, "PROJECT", tmp_path / "project")
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")
    with pytest.raises(ValueError, match="conference"):
        build_pages.build_conference(conference)
    with pytest.raises(ValueError, match="conference"):
        build_pages.render_paper_links_page(conference, [])


@pytest.mark.parametrize(
    "conference",
    ("iclr-2026", "cvpr-2026", "neurips-2025", "emnlp-findings-2025", "a", "a" * 41),
)
def test_slugs_the_collectors_may_write_stay_buildable(
    conference: str, tmp_path: Path, monkeypatch
) -> None:
    """Every real catalog slug must survive validation, including the template.

    ``cvpr-2026`` is in scaffold's reserved set only because it is the page that
    set is copied from; ``docs/cvpr-2026/`` is still a published catalog. The
    1-character and 41-character cases pin the shared 1-64 bound: a stricter
    rule here would strand output a collector was allowed to write.
    """
    monkeypatch.setattr(build_pages, "PROJECT", tmp_path / "project")
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    # Isolated paths, so validation is the only thing under test: it passed when
    # the build gets as far as reporting there is nothing to build.
    assert build_pages.build_conference(conference) is None
    assert build_pages._validate_conference_slug(conference) == conference


def test_containment_rejects_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "safe-conf").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="escapes configured root"):
        build_pages._contained_path(root, "safe-conf", "paper-links.html")


def test_fallback_write_uses_same_directory_atomic_replace(tmp_path: Path, monkeypatch) -> None:
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)
    real_replace = os.replace
    replacements: list[tuple[Path, Path]] = []

    def replace(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        replacements.append((Path(source), Path(destination)))
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", replace)
    paper = {
        "paper_id": "a" * 40,
        "title": "Atomic paper",
        "arxiv_url": "https://arxiv.org/abs/2404.00001",
        "pdf_url": "",
    }

    output = build_pages.write_paper_links_page("safe-conf", [paper])

    assert output.is_file()
    assert len(replacements) == 1
    assert replacements[0][1] == output
    assert replacements[0][0].parent == output.parent
    assert not replacements[0][0].exists()
    assert output.stat().st_mode & 0o777 == 0o644


# ---- publishing validates before it replaces the catalog ----


def test_build_conference_keeps_published_papers_json_when_the_fallback_raises(
    tmp_path: Path, monkeypatch
) -> None:
    """A catalog that cannot pass the no-JS checks must not be published at all.

    Two rows carrying the same source URL share one ``paper_id``, and that
    duplicate is only detectable while rendering the fallback. Rendering first
    means the raise leaves the previously published ``papers.json``
    byte-identical instead of shipping a catalog with no matching fallback.
    """
    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    row = {
        "title": "A",
        "type": "Poster",
        "tags": "LLM",
        "venue": "ICLR",
        "authors": "X",
        "arxiv_url": "https://arxiv.org/abs/2404.00001",
        "pdf_url": "p",
        "abstract": "a",
    }
    _write_summary(
        project / "output" / "iclr-2026" / "summary.csv",
        [row, {**row, "title": "B"}],
    )

    papers_json = docs_root / "iclr-2026" / "papers.json"
    papers_json.parent.mkdir(parents=True, exist_ok=True)
    published = '[{"title":"previously published catalog"}]'
    papers_json.write_text(published, encoding="utf-8")

    with pytest.raises(IdentityError, match="duplicate paper_id"):
        build_pages.build_conference("iclr-2026")

    assert papers_json.read_text(encoding="utf-8") == published
    assert not (docs_root / "iclr-2026" / "paper-links.html").exists()


# ---- the shrink gate: an incomplete build must not replace the live catalog ----


def _isolate_paths(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    """Point PROJECT / DOCS_ROOT at tmp_path so the build never touches the repo."""
    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)
    return project, docs_root


def _summary_url(index: int, offset: int = 0) -> str:
    """The arXiv URL ``_summary_rows`` gives its ``index``-th row.

    Shared with the published-catalog helper below so the ``paper_id`` a test plants is
    the ``paper_id`` the build derives for the same paper, and the only difference a test
    introduces is the one it names.
    """
    return f"https://arxiv.org/abs/2404.000{index + offset:02d}"


def _summary_rows(count: int, *, oral: bool = False, offset: int = 0) -> list[dict[str, str]]:
    """`count` distinct, renderable summary rows; at most one labelled Oral.

    ``offset`` shifts the titles and arXiv ids so two conferences can hold
    distinguishable papers.
    """
    return [
        {
            "title": f"P{i + offset}",
            "type": "Oral" if oral and i == 1 else "Poster",
            "tags": "LLM",
            "venue": "ICLR",
            "authors": "X",
            "arxiv_url": _summary_url(i, offset),
            "pdf_url": "p",
            "abstract": "a",
        }
        for i in range(1, count + 1)
    ]


def _publish(docs_root: Path, rows: str, *, conference: str = "iclr-2026") -> Path:
    """Write the published catalog payload for ``conference`` and return its path."""
    conf = docs_root / conference
    conf.mkdir(parents=True, exist_ok=True)
    papers_json = conf / "papers.json"
    papers_json.write_text(rows, encoding="utf-8")
    return papers_json


def _published_payload(rows: int, *, oral_at: int | None = None) -> str:
    """A published papers.json of ``rows`` entries, one labelled Oral if ``oral_at``."""
    return json.dumps(
        [
            {"title": f"P{i}", "type": "Oral" if oral_at == i else "Poster"}
            for i in range(1, rows + 1)
        ]
    )


def _published_site(docs_root: Path) -> dict[str, bytes]:
    """Snapshot every published file under ``docs_root`` as `relative path -> bytes`.

    Comparing the whole tree byte-for-byte, instead of only the refused conference's
    catalog, is what proves a failed build published nothing: the other catalogs, the
    landing index and the detail shards have to stay exactly as they were.
    """
    return {
        str(path.relative_to(docs_root)): path.read_bytes()
        for path in sorted(docs_root.rglob("*"))
        if path.is_file()
    }


def _publish_catalog_with_fallback(docs_root: Path, rows: int, *, conference: str) -> None:
    """Plant ``conference``'s published catalog and its no-JS fallback page."""
    _publish(docs_root, _published_payload(rows), conference=conference)
    (docs_root / conference / "paper-links.html").write_text(
        f"<html>published {conference} fallback</html>", encoding="utf-8"
    )


def _publish_old_index(docs_root: Path) -> None:
    """Plant the landing index a refused build must not have replaced."""
    (docs_root / "conferences.json").write_text(
        '[{"name":"old-2025","papers":99}]\n', encoding="utf-8"
    )


def _publish_index(docs_root: Path, names: list[str]) -> Path:
    """Plant a published landing index listing ``names``, and return its path."""
    docs_root.mkdir(parents=True, exist_ok=True)
    index = docs_root / "conferences.json"
    index.write_text(
        json.dumps([{"name": name, "papers": 1} for name in names], indent=2), encoding="utf-8"
    )
    return index


def _plant_published_site(docs_root: Path, payload: str) -> Path:
    """Publish ``payload`` as the live iclr-2026 catalog, next to its real neighbours.

    A refusal has to leave the catalog, the no-JS page beside it and the landing index
    that links to them alone, so the helpers that compare bytes snapshot all three.
    """
    papers_json = _publish(docs_root, payload)
    (docs_root / "iclr-2026" / "paper-links.html").write_text(
        "<html>published fallback</html>", encoding="utf-8"
    )
    _publish_old_index(docs_root)
    return papers_json


def _published_catalog(
    count: int,
    *,
    offset: int = 0,
    oral: int = 0,
    abstract: str = "a",
    authors: list[str] | None = None,
) -> str:
    """A published ``papers.json`` carrying the fields the content-loss gate compares.

    The rows mirror what :func:`build_pages.load_summary` publishes for
    ``_summary_rows(count, offset)`` — the same ``paper_id`` derived from the same arXiv
    URL, a non-empty ``abstract`` preview, a non-empty ``authors`` list — so re-collecting
    the same papers is a no-op for every rule and the only loss a test introduces is the
    one it names. ``oral`` labels the first ``oral`` rows Oral, and ``authors`` defaults to
    ``["X"]`` (pass ``[]`` for a field the published catalog already had blank).
    """
    return json.dumps(
        [
            {
                "title": f"P{index + offset}",
                "type": "Oral" if index <= oral else "Poster",
                "paper_id": build_pages.identity_from_url(_summary_url(index, offset)).paper_id,
                "abstract": abstract,
                "authors": ["X"] if authors is None else authors,
            }
            for index in range(1, count + 1)
        ]
    )


def _published_ids(count: int, *, offset: int = 0) -> list[str]:
    """The ``paper_id`` of the first ``count`` papers of ``_published_catalog``."""
    return [
        build_pages.identity_from_url(_summary_url(index, offset)).paper_id
        for index in range(1, count + 1)
    ]


def test_build_conference_refuses_to_publish_a_smaller_catalog(
    tmp_path: Path, monkeypatch
) -> None:
    """A collection that lost rows publishes nothing at all.

    The rows in ``papers.json`` are the catalog a visitor sees; a shorter one is
    indistinguishable from a venue that genuinely shrank once the fetch is already
    over, so the comparison has to happen while the published file is still there.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, _published_payload(3))
    published = papers_json.read_text(encoding="utf-8")
    fallback = "<html>published fallback</html>"
    (docs_root / "iclr-2026" / "paper-links.html").write_text(fallback, encoding="utf-8")
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))

    with pytest.raises(build_pages.CatalogShrinkError, match="2 row"):
        build_pages.build_conference("iclr-2026")

    assert papers_json.read_text(encoding="utf-8") == published
    assert (docs_root / "iclr-2026" / "paper-links.html").read_text(encoding="utf-8") == fallback

    # allow_shrink is the operator's explicit acknowledgement, and then it publishes.
    res = build_pages.build_conference("iclr-2026", allow_shrink=True)
    assert res is not None and res["papers"] == 2
    assert papers_json.read_text(encoding="utf-8") != published


def test_build_conference_publishes_a_catalog_of_equal_size(
    tmp_path: Path, monkeypatch
) -> None:
    """Equal (or larger) row counts are the normal re-collection; only shrink is refused."""
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, _published_payload(2))
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))

    res = build_pages.build_conference("iclr-2026")

    assert res is not None and res["papers"] == 2
    published_titles = [p["title"] for p in json.loads(papers_json.read_text(encoding="utf-8"))]
    assert published_titles == ["P1", "P2"]
    assert (docs_root / "iclr-2026" / "paper-links.html").is_file()


def test_build_conference_refuses_when_the_published_oral_labels_would_vanish(
    tmp_path: Path, monkeypatch
) -> None:
    """The row count alone cannot catch a skipped arXiv oral overlay.

    ``build_summary_csv`` marks Oral purely from oral_summaries_ja.md, so a re-run
    without ``--oral-arxiv-query`` keeps every row and still turns the whole catalog
    into Poster — the labels, not the count, are what disappears.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, _published_payload(3, oral_at=1))
    published = papers_json.read_text(encoding="utf-8")
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(3))

    with pytest.raises(build_pages.CatalogShrinkError, match="Oral"):
        build_pages.build_conference("iclr-2026")

    assert papers_json.read_text(encoding="utf-8") == published

    # A build that keeps at least one Oral is not refused.
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(3, oral=True))
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["types"] == {"Oral": 1, "Poster": 2}


def test_build_conference_refuses_to_overwrite_an_uninspectable_catalog(
    tmp_path: Path, monkeypatch
) -> None:
    """A published file that cannot be counted must not be replaced blindly."""
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, '[{"title": "P1", "type": "Poster"},')
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(1))

    with pytest.raises(build_pages.CatalogShrinkError, match="cannot be inspected"):
        build_pages.build_conference("iclr-2026")
    assert papers_json.read_text(encoding="utf-8") == '[{"title": "P1", "type": "Poster"},'
    assert not (docs_root / "iclr-2026" / "paper-links.html").exists()

    papers_json.write_text('{"papers": []}', encoding="utf-8")
    with pytest.raises(build_pages.CatalogShrinkError, match="not a JSON array"):
        build_pages.build_conference("iclr-2026")
    assert papers_json.read_text(encoding="utf-8") == '{"papers": []}'

    # First publication has no baseline, so nothing can shrink.
    papers_json.unlink()
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["papers"] == 1


def test_build_conference_refuses_a_partial_loss_of_the_published_oral_labels(
    tmp_path: Path, monkeypatch
) -> None:
    """Published 120 Oral and new 40 Oral at the same row count is still a regression.

    The arXiv oral overlay labels a subset of the rows, so a build that matches only part
    of it keeps both the row count and at least one Oral label — the two things the gate
    used to look at — and quietly erases the rest. The published Oral count is the floor.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _plant_published_site(docs_root, _published_catalog(3, oral=2))
    before = _published_site(docs_root)
    rows = _summary_rows(4)
    rows[0]["type"] = "Oral"  # one of the two published Oral labels survived
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)

    with pytest.raises(build_pages.CatalogShrinkError, match="Oral") as raised:
        build_pages.build_conference("iclr-2026")

    message = str(raised.value)
    assert "2 row(s) Oral" in message and "labels 1" in message
    assert _published_site(docs_root) == before

    # Matching the published Oral count publishes again: a floor, not a freeze.
    rows[1]["type"] = "Oral"
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["types"] == {"Oral": 2, "Poster": 2}


def test_build_conference_refuses_a_same_size_collection_of_different_papers(
    tmp_path: Path, monkeypatch
) -> None:
    """A re-collection that returned *other* papers is not the catalog that is online.

    An upstream listing page that changed shape can hand back a perfectly plausible row
    count while naming different papers. The published ``paper_id``s are the only evidence
    of that swap available without re-fetching anything, so losing one is refused even
    when nothing else about the collection looks wrong.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _plant_published_site(docs_root, _published_catalog(4))
    before = _published_site(docs_root)
    published_ids = _published_ids(4)
    # Four rows again, and not one of them is a paper that is currently online.
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(4, offset=4))

    with pytest.raises(build_pages.CatalogShrinkError, match="missing") as raised:
        build_pages.build_conference("iclr-2026")

    message = str(raised.value)
    assert ", ".join(published_ids[:3]) in message  # up to three ids, enough to grep
    assert published_ids[3] not in message  # ...the rest is only counted
    assert "(4 in total)" in message
    assert _published_site(docs_root) == before

    # A strict superset of the published ids is the normal re-collection.
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(5))
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["papers"] == 5
    published_rows = json.loads(papers_json.read_text(encoding="utf-8"))
    assert [row["title"] for row in published_rows] == ["P1", "P2", "P3", "P4", "P5"]


def test_build_conference_refuses_when_published_abstracts_come_back_empty(
    tmp_path: Path, monkeypatch
) -> None:
    """Rows that survived with a blank abstract mean the collector stopped reading them.

    Only emptiness counts: ``papers.json`` ships a truncated preview, so a shorter or
    reworded abstract is a normal rebuild, while a field that came back blank for every
    paper is an upstream markup change that would empty the catalog's cards.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _plant_published_site(docs_root, _published_catalog(4))
    before = _published_site(docs_root)
    published_ids = _published_ids(4)
    rows = _summary_rows(4)
    for row in rows:
        row["abstract"] = ""
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)

    with pytest.raises(build_pages.CatalogShrinkError, match="abstract") as raised:
        build_pages.build_conference("iclr-2026")

    message = str(raised.value)
    assert ", ".join(published_ids[:3]) in message and published_ids[3] not in message
    assert "(4 in total)" in message
    assert _published_site(docs_root) == before

    # A preview that only changed wording or length, and one filling a published blank,
    # are both gains: the rule has no direction that punishes a rewrite.
    _publish(docs_root, _published_catalog(4, abstract=""))
    for row in rows:
        row["abstract"] = "a longer abstract than the published preview"
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["papers"] == 4
    published_rows = json.loads(papers_json.read_text(encoding="utf-8"))
    assert all(row["abstract"].startswith("a longer abstract") for row in published_rows)


def test_build_conference_refuses_when_published_author_lists_come_back_empty(
    tmp_path: Path, monkeypatch
) -> None:
    """``authors`` is a list, so emptiness has to be read out of the shape the row uses.

    Every row and every abstract survives a broken author split, so this is the one loss
    neither the count nor the abstract rule can see — and the catalog's cards and the
    lineage builder both read it.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _plant_published_site(docs_root, _published_catalog(3))
    before = _published_site(docs_root)
    rows = _summary_rows(3)
    for row in rows:
        row["authors"] = ""  # load_summary publishes this as the empty list
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)

    with pytest.raises(build_pages.CatalogShrinkError, match="authors") as raised:
        build_pages.build_conference("iclr-2026")

    assert "(3 in total)" in str(raised.value)
    assert _published_site(docs_root) == before

    # Filling an author list the published catalog did not have is a gain, not a loss.
    _publish(docs_root, _published_catalog(3, authors=[]))
    for row in rows:
        row["authors"] = "X"
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", rows)
    res = build_pages.build_conference("iclr-2026")
    assert res is not None and res["papers"] == 3
    published_rows = json.loads(papers_json.read_text(encoding="utf-8"))
    assert all(row["authors"] == ["X"] for row in published_rows)


def test_main_refuses_a_smaller_catalog_and_leaves_the_site_unchanged(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """The CLI must fail loudly: non-zero exit, named counts, named flag."""
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, _published_payload(3))
    published = papers_json.read_text(encoding="utf-8")
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    index = docs_root / "conferences.json"
    index.write_text('[{"name":"other-2025","papers":10}]\n', encoding="utf-8")

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    out = capsys.readouterr().out
    assert "iclr-2026" in out
    assert "2 row" in out and "has 3" in out  # new vs published counts
    assert "--allow-shrink" in out
    # Nothing published by this build changed: catalog, fallback, index, shards.
    assert papers_json.read_text(encoding="utf-8") == published
    assert not (docs_root / "iclr-2026" / "paper-links.html").exists()
    assert index.read_text(encoding="utf-8") == '[{"name":"other-2025","papers":10}]\n'
    assert not (docs_root / "paper-details-v1").exists()


def test_main_publishes_a_shrunk_catalog_only_with_allow_shrink(
    tmp_path: Path, monkeypatch
) -> None:
    """--allow-shrink must reach build_conference from the CLI."""
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    papers_json = _publish(docs_root, _published_payload(3))
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))

    monkeypatch.setattr(
        sys, "argv", ["build_pages", "--conference", "iclr-2026", "--allow-shrink"]
    )
    build_pages.main()

    assert len(json.loads(papers_json.read_text(encoding="utf-8"))) == 2
    assert (docs_root / "iclr-2026" / "paper-links.html").is_file()


def test_main_allow_shrink_for_only_releases_the_named_conference(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """``--allow-shrink-for CONF`` answers for one catalog, never for the whole run.

    A weekly collection rebuilds every venue at once, so acknowledging one venue's
    shorter catalog must not carry the other venue's loss online with it. The flag is
    repeatable because two venues can genuinely need the same acknowledgement.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    iclr = _publish(docs_root, _published_payload(3), conference="iclr-2026")
    neurips = _publish(docs_root, _published_payload(4), conference="neurips-2026")
    neurips_rows = _summary_rows(3, offset=4)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    _write_summary(project / "output" / "neurips-2026" / "summary.csv", neurips_rows)
    before = _published_site(docs_root)

    monkeypatch.setattr(sys, "argv", ["build_pages", "--allow-shrink-for", "neurips-2026"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()
    assert exit_info.value.code != 0
    # The named conference was not the one that lost content, so iclr still refused —
    # and its refusal names both ways out so the operator can pick the narrow one.
    out = capsys.readouterr().out
    assert "iclr-2026" in out
    assert "--allow-shrink" in out and "--allow-shrink-for iclr-2026" in out
    assert _published_site(docs_root) == before

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "build_pages",
            "--allow-shrink-for",
            "iclr-2026",
            "--allow-shrink-for",
            "neurips-2026",
        ],
    )
    build_pages.main()

    assert len(json.loads(iclr.read_text(encoding="utf-8"))) == 2
    assert len(json.loads(neurips.read_text(encoding="utf-8"))) == 3
    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    assert [entry["papers"] for entry in index] == [2, 3]


# ---- the landing-index gate: a full build must not take a published catalog offline ----


def test_main_refuses_a_full_build_that_drops_a_published_conference(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """A conference whose output dir disappeared must not vanish from the index silently.

    ``conferences.json`` is rewritten from the catalogs this run built, so the lost
    conference loses its catalog card — and the catalog it links to — with nothing to
    compare against. The per-catalog shrink gate cannot see it: it has no new catalog for
    that conference at all, and a brand-new conference has no published baseline either.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _publish_index(docs_root, ["iclr-2026", "neurips-2026"])
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    before = _published_site(docs_root)

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    out = capsys.readouterr().out
    assert "neurips-2026" in out
    assert "--allow-shrink" in out and "--allow-shrink-for" in out
    # Nothing written at all: not the refused index, not the one healthy catalog.
    assert _published_site(docs_root) == before
    assert not (docs_root / "iclr-2026" / "papers.json").exists()
    assert not (docs_root / "paper-details-v1").exists()

    # The narrow acknowledgement still works: naming the going-offline conference
    # publishes the index this run can actually fill.
    monkeypatch.setattr(sys, "argv", ["build_pages", "--allow-shrink-for", "neurips-2026"])
    build_pages.main()

    published = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    assert [entry["name"] for entry in published] == ["iclr-2026"]
    assert (docs_root / "iclr-2026" / "papers.json").is_file()


def test_main_refuses_a_full_build_with_an_uninspectable_published_index(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """An index the build cannot count must not be overwritten blindly — a missing one may.

    Same rule as an uninspectable catalog: the full build is about to replace this file,
    and "I could not read it" is not evidence that nothing was lost. No file at all is the
    first build, where there is nothing to lose.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    index = _publish_index(docs_root, ["iclr-2026"])
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))

    for broken, expected in (
        ('[{"name": "iclr-2026"},', "cannot be inspected"),
        ('{"name": "iclr-2026"}', "not a JSON array"),
    ):
        index.write_text(broken, encoding="utf-8")
        before = _published_site(docs_root)

        monkeypatch.setattr(sys, "argv", ["build_pages"])
        with pytest.raises(SystemExit) as exit_info:
            build_pages.main()

        assert exit_info.value.code != 0
        out = capsys.readouterr().out
        assert "conferences.json" in out and expected in out
        assert _published_site(docs_root) == before
        assert not (docs_root / "iclr-2026" / "papers.json").exists()

    index.unlink()
    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()
    assert (docs_root / "iclr-2026" / "papers.json").is_file()


# ---- the shrink acknowledgement must name something this run can publish ----


@pytest.mark.parametrize(
    "entry,expected",
    [
        ("iclr2026", "iclr2026"),  # a slug-shaped typo: names no buildable conference
        ("../etc", "invalid --conference"),  # not a slug at all, so rejected outright
        ("ICLR 2026", "invalid --conference"),
    ],
)
def test_main_aborts_a_full_build_acknowledgement_that_names_nothing(
    tmp_path: Path, monkeypatch, capsys, entry: str, expected: str
) -> None:
    """A typo in ``--allow-shrink-for`` must not read to the operator as a loosened gate.

    The entry is checked with the build's own slug validator and must then name a
    conference this run publishes or one the published index still lists; otherwise the
    acknowledgement is a no-op and the run refuses for a different conference than the one
    the operator believes they waived.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _publish_index(docs_root, ["iclr-2026"])
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    before = _published_site(docs_root)

    monkeypatch.setattr(sys, "argv", ["build_pages", "--allow-shrink-for", entry])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    out = capsys.readouterr().out
    assert "--allow-shrink-for" in out and expected in out
    assert _published_site(docs_root) == before


def test_main_aborts_a_scoped_build_acknowledgement_for_another_conference(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """``--conference iclr-2026 --allow-shrink-for neurips-2026`` acknowledges nothing.

    A scoped build publishes exactly one catalog, so an entry naming any other conference
    is a typo or a copy-paste from another run; the index is not consulted here because a
    scoped build never rewrites it.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))

    monkeypatch.setattr(
        sys,
        "argv",
        ["build_pages", "--conference", "iclr-2026", "--allow-shrink-for", "neurips-2026"],
    )
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    out = capsys.readouterr().out
    assert "neurips-2026" in out and "iclr-2026" in out
    assert not docs_root.exists()

    # The matching acknowledgement is accepted, and a scoped build still needs no index.
    monkeypatch.setattr(
        sys,
        "argv",
        ["build_pages", "--conference", "iclr-2026", "--allow-shrink-for", "iclr-2026"],
    )
    build_pages.main()
    assert (docs_root / "iclr-2026" / "papers.json").is_file()
    assert not (docs_root / "conferences.json").exists()


def test_main_publishes_catalog_files_through_atomic_write_text(
    tmp_path: Path, monkeypatch
) -> None:
    """Published artifacts are replaced by rename, never truncated in place.

    A visitor reading ``papers.json`` while the build runs must see either the
    old or the new file. Patching the shared helper pins that every publish
    (catalog, no-JS fallback, index, detail shards) really goes through it.
    """
    import sys

    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", [_row()])

    real = build_pages.atomic_write_text
    written: list[Path] = []

    def record(path: str | Path, text: str, *, encoding: str = "utf-8") -> None:
        written.append(Path(path))
        real(path, text, encoding=encoding)

    monkeypatch.setattr(build_pages, "atomic_write_text", record)
    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()

    names = {path.name for path in written}
    assert {"papers.json", "paper-links.html", "conferences.json"} <= names
    assert len([p for p in written if p.parent.name == "paper-details-v1"]) == 256
    assert (docs_root / "iclr-2026" / "papers.json").is_file()


# ---- a rebuild of unchanged data must not touch the committed catalog bytes ----


def test_published_papers_json_ends_with_exactly_one_newline(tmp_path: Path, monkeypatch) -> None:
    """The catalog file is closed by one newline, exactly as the committed ones are.

    ``promote-generated.sh`` dies when the promotion-time rebuild leaves tracked
    changes outside the candidate allowlist, and a payload without its newline rewrites
    all ten committed catalogs with a newline-only diff even when nothing was collected.
    """
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    summary_csv = project / "output" / "iclr-2026" / "summary.csv"
    _write_summary(summary_csv, _summary_rows(2))

    build_pages.build_conference("iclr-2026")

    raw = (docs_root / "iclr-2026" / "papers.json").read_bytes()
    assert raw.endswith(b"\n")
    assert not raw.endswith(b"\n\n")
    rows, _ = build_pages.load_summary_with_details(summary_csv)
    assert json.loads(raw.decode("utf-8")) == rows


def test_rebuilding_unchanged_data_publishes_identical_bytes(tmp_path: Path, monkeypatch) -> None:
    """Rebuilding the same summary is byte-for-byte the publication that is already there."""
    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    papers_json = docs_root / "iclr-2026" / "papers.json"

    build_pages.build_conference("iclr-2026")
    first = papers_json.read_bytes()
    build_pages.build_conference("iclr-2026")

    assert papers_json.read_bytes() == first


def test_committed_catalogs_are_what_this_build_would_publish(monkeypatch) -> None:
    """The real ``docs/<conference>/papers.json`` bytes are pinned to this builder.

    ``promote-generated.sh`` only tolerates a rebuild that reproduces the committed bytes,
    and the single trailing newline is part of them: a payload without it rewrites all ten
    catalogs with a newline-only diff and the promotion dies on those tracked changes.
    Reading the real ``PROJECT`` / ``DOCS_ROOT`` is what makes this a pin instead of a unit
    test, so preparation runs with the writer patched out — nothing here may touch the repo.
    """

    def refuse_write(path: str | Path, text: str, *, encoding: str = "utf-8") -> None:
        raise AssertionError(f"pinning the committed catalogs must not write: {path}")

    monkeypatch.setattr(build_pages, "atomic_write_text", refuse_write)

    output_dir = build_pages.PROJECT / "output"
    names = sorted(
        directory.name
        for directory in output_dir.iterdir()
        if directory.is_dir()
        and directory.name not in build_pages.NON_CONFERENCE
        and (directory / "summary.csv").is_file()
    )
    assert names, f"no conference collection output under {output_dir}"

    for name in names:
        try:
            prepared = build_pages.prepare_conference(name)
        except build_pages.CatalogShrinkError as exc:
            # The published catalog holds content the collection no longer produces, which
            # is exactly the drift this pin exists to catch — but it never reaches the
            # byte comparison, so report it as the failure it is.
            pytest.fail(f"{name}: the published catalog refuses this build: {exc}")
        assert prepared is not None, name
        published = prepared.out_json
        assert published.is_file(), f"{name}: nothing committed at {published}"
        assert published.read_bytes() == (prepared.papers_json + "\n").encode("utf-8"), (
            f"stale committed catalog: {published} is not what build_pages.py publishes; "
            f"re-run it for {name}"
        )


# ---- a whole-run build is all-or-nothing ----


def test_main_refuses_a_second_shrinking_catalog_and_writes_nothing(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """One refused conference must abort the run before any conference is published.

    Conferences used to be written as they were built, so when the second one lost
    rows the first one's ``papers.json`` and no-JS page were already replaced while
    ``conferences.json`` and the detail shards still described the old site — landing
    counts that disagree with the catalogs they link to. Preparing every selected
    conference first removes that half-published state.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _publish_catalog_with_fallback(docs_root, 2, conference="iclr-2026")
    _publish_catalog_with_fallback(docs_root, 4, conference="neurips-2026")
    _publish_old_index(docs_root)
    shrunk = _summary_rows(2, offset=4)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    _write_summary(project / "output" / "neurips-2026" / "summary.csv", shrunk)
    before = _published_site(docs_root)

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    # The healthy first conference was never published either.
    assert _published_site(docs_root) == before
    assert not (docs_root / "paper-details-v1").exists()
    out = capsys.readouterr().out
    assert "neurips-2026" in out
    assert "2 row" in out and "has 4" in out


def test_main_writes_nothing_when_a_second_conference_fails_the_identity_check(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """A validation failure aborts the run exactly like a shrink refusal: nothing written.

    Two rows sharing one source URL share one ``paper_id``, which only the no-JS
    render detects — after the shrink gate, so the conference looks publishable until
    the render raises. Because the render now happens while preparing, the conference
    that already prepared cleanly is still left untouched.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    _publish_catalog_with_fallback(docs_root, 1, conference="iclr-2026")
    _publish_catalog_with_fallback(docs_root, 2, conference="neurips-2026")
    _publish_old_index(docs_root)
    twin = _summary_rows(1, offset=8)[0]
    duplicated = [twin, {**twin, "title": "Twin"}]
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(1))
    _write_summary(project / "output" / "neurips-2026" / "summary.csv", duplicated)
    before = _published_site(docs_root)

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    assert _published_site(docs_root) == before
    assert not (docs_root / "paper-details-v1").exists()
    out = capsys.readouterr().out
    assert "IdentityError" in out and "duplicate paper_id" in out


def test_main_publishes_every_selected_conference(tmp_path: Path, monkeypatch) -> None:
    """Two healthy conferences still publish both catalogs plus the matching index."""
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    neurips_rows = _summary_rows(3, offset=4)
    _write_summary(project / "output" / "iclr-2026" / "summary.csv", _summary_rows(2))
    _write_summary(project / "output" / "neurips-2026" / "summary.csv", neurips_rows)

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()

    expected = {"iclr-2026": ["P1", "P2"], "neurips-2026": ["P5", "P6", "P7"]}
    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    assert [entry["name"] for entry in index] == list(expected)
    for entry, (name, titles) in zip(index, expected.items(), strict=True):
        papers = json.loads((docs_root / name / "papers.json").read_text(encoding="utf-8"))
        assert [paper["title"] for paper in papers] == titles
        # The landing count describes the catalog it links to, not a previous build.
        assert entry["papers"] == len(papers)
        fallback = (docs_root / name / "paper-links.html").read_text(encoding="utf-8")
        assert all(paper["paper_id"] in fallback for paper in papers)
    assert (docs_root / "paper-details-v1").is_dir()


# ---- write_index ----


def test_write_index_aggregates_stats(tmp_path: Path, monkeypatch):
    docs_root = tmp_path / "docs"
    docs_root.mkdir()
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    build_pages.write_index(
        [
            {"name": "iclr-2026", "papers": 218, "types": {"Oral": 13}, "top_tags": [("LLM", 90)]},
            {
                "name": "neurips-2025",
                "papers": 100,
                "types": {"Oral": 5},
                "top_tags": [("Vision", 40)],
            },
        ]
    )

    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    assert [c["name"] for c in index] == ["iclr-2026", "neurips-2025"]
    assert index[0]["papers"] == 218


# ---- main() discovery ----


def test_main_skips_daily_pseudo_conference(tmp_path: Path, monkeypatch):
    """`daily` carries a summary.csv but is the daily-watch output, not a
    conference. Auto-discovery (no --conference) must exclude it so it never
    lands in conferences.json (which would render a broken catalog card)."""
    import sys

    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)

    row = {
        "title": "A",
        "type": "Poster",
        "tags": "Vision",
        "venue": "CVPR",
        "authors": "X",
        "arxiv_url": "https://arxiv.org/abs/2404.00003",
        "pdf_url": "p",
        "abstract": "a",
    }
    _write_summary(project / "output" / "cvpr-2026" / "summary.csv", [row])
    _write_summary(project / "output" / "daily" / "summary.csv", [row])

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()

    index = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    names = {c["name"] for c in index}
    assert "cvpr-2026" in names
    assert "daily" not in names
    # ...and no docs/daily/ catalog page is generated.
    assert not (docs_root / "daily" / "papers.json").exists()


def test_single_conference_build_does_not_overwrite_global_index(
    tmp_path: Path, monkeypatch
) -> None:
    """A scoped catalog rebuild must not replace the ten-conference index."""
    import sys

    project = tmp_path / "paperpilot"
    docs_root = tmp_path / "docs"
    docs_root.mkdir()
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", docs_root)
    _write_summary(project / "output" / "cvpr-2026" / "summary.csv", [_row()])
    original = '[{"name":"existing-2025","papers":10}]\n'
    (docs_root / "conferences.json").write_text(original, encoding="utf-8")

    monkeypatch.setattr(sys, "argv", ["build_pages", "--conference", "cvpr-2026"])
    build_pages.main()

    assert (docs_root / "cvpr-2026" / "papers.json").is_file()
    assert (docs_root / "conferences.json").read_text(encoding="utf-8") == original
    assert not (docs_root / "paper-details-v1").exists()


def test_main_fails_a_scoped_build_that_produced_nothing(tmp_path: Path, monkeypatch, capsys):
    """``--conference`` named one catalog, so a skip there must not exit 0.

    The weekly workflow rebuilds one conference per collection and treats a zero exit as
    "the catalog is published"; a missing summary.csv has to fail loudly there. A build
    without --conference discovers its conferences, so it keeps skipping silently.
    """
    import sys

    project, docs_root = _isolate_paths(tmp_path, monkeypatch)
    (project / "output" / "iclr-2026").mkdir(parents=True)  # directory, no summary.csv

    monkeypatch.setattr(sys, "argv", ["build_pages", "--conference", "iclr-2026"])
    with pytest.raises(SystemExit) as exit_info:
        build_pages.main()

    assert exit_info.value.code != 0
    out = capsys.readouterr().out
    assert "iclr-2026" in out and "summary.csv" in out
    assert not docs_root.exists()

    monkeypatch.setattr(sys, "argv", ["build_pages"])
    build_pages.main()  # nothing discovered at all: the unscoped skip, still exit 0
    assert not docs_root.exists()


# ---- data date stamping ----


def _row() -> dict[str, str]:
    return {
        "title": "A",
        "type": "Poster",
        "tags": "Vision",
        "venue": "CVPR",
        "authors": "X",
        "arxiv_url": "https://arxiv.org/abs/2404.00004",
        "pdf_url": "p",
        "abstract": "a",
    }


def test_build_conference_stamps_latest_data_date(tmp_path: Path, monkeypatch):
    """`generated` = the newest papers_YYYY-MM-DD.csv date (the real data
    date), so the viewer's 'last updated' reflects the data, not page load."""
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    conf_dir = project / "output" / "cvpr-2026"
    _write_summary(conf_dir / "summary.csv", [_row()])
    (conf_dir / "papers_2026-05-01.csv").write_text("title\nA\n", encoding="utf-8")
    (conf_dir / "papers_2026-06-27.csv").write_text("title\nA\n", encoding="utf-8")

    res = build_pages.build_conference("cvpr-2026")
    assert res is not None
    assert res["generated"] == "2026-06-27"  # newest wins


def test_build_conference_generated_none_without_dated_csv(tmp_path: Path, monkeypatch):
    project = tmp_path / "paperpilot"
    monkeypatch.setattr(build_pages, "PROJECT", project)
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    conf_dir = project / "output" / "legacy-conf"
    _write_summary(conf_dir / "summary.csv", [_row()])  # no papers_*.csv

    res = build_pages.build_conference("legacy-conf")
    assert res is not None
    assert res["generated"] is None


def _assert_generated(conf_dir: Path, meta_text: str | None, expected: str | None) -> None:
    """Publish a conference holding two dated CSVs and check its `generated` stamp."""
    _write_summary(conf_dir / "summary.csv", [_row()])
    (conf_dir / "papers_2026-05-01.csv").write_text("title\nA\n", encoding="utf-8")
    (conf_dir / "papers_2026-06-27.csv").write_text("title\nA\n", encoding="utf-8")
    if meta_text is not None:
        (conf_dir / build_summary_csv.SUMMARY_META_FILENAME).write_text(
            meta_text, encoding="utf-8"
        )
    entry = build_pages.build_conference("cvpr-2026")
    assert entry is not None
    assert entry["generated"] == expected


@pytest.mark.parametrize(
    ("meta_text", "expected"),
    [
        # Older than the newest CSV: re-collecting without re-summarising must not date
        # the catalog by rows it does not contain.
        (json.dumps({"source": "papers_2026-05-01.csv"}), "2026-05-01"),
        (json.dumps({"source": "papers_2026-06-27.csv"}), "2026-06-27"),
    ],
)
def test_build_conference_generated_uses_the_summary_sidecar(
    tmp_path: Path, monkeypatch, meta_text: str, expected: str
):
    """`generated` comes from the sidecar naming the CSV build_summary_csv actually read."""
    monkeypatch.setattr(build_pages, "PROJECT", tmp_path / "paperpilot")
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    _assert_generated(tmp_path / "paperpilot" / "output" / "cvpr-2026", meta_text, expected)


@pytest.mark.parametrize(
    "meta_text",
    [
        None,  # summarised before the sidecar existed
        "",
        "not json",
        "{}",  # no source recorded
        '{"source": "papers-january.csv"}',  # names nothing dated
        '["papers_2026-05-01.csv"]',  # not the object the writer makes
    ],
    ids=["absent", "empty", "corrupt", "no-source", "undated-source", "not-an-object"],
)
def test_build_conference_generated_falls_back_without_a_usable_sidecar(
    tmp_path: Path, monkeypatch, meta_text: str | None
):
    """An unusable sidecar keeps the previous stamp instead of failing or lying.

    The committed conferences.json was built with no sidecar at all, so a build that
    cannot read one still has to answer with the newest dated collection.
    """
    monkeypatch.setattr(build_pages, "PROJECT", tmp_path / "paperpilot")
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    _assert_generated(tmp_path / "paperpilot" / "output" / "cvpr-2026", meta_text, "2026-06-27")


def test_build_conference_generated_ignores_a_sidecar_naming_an_absent_csv(
    tmp_path: Path, monkeypatch
):
    """A sidecar names a basename, so it is this directory's file only if it is here.

    A summary built with --input at another conference's CSV used to record that CSV's name
    beside a summary whose rows came from somewhere else, and a dated collection that was
    since moved or deleted leaves the same shape. Either way the stamp falls back to the
    newest papers_*.csv in this directory instead of a date no file here supports.
    """
    monkeypatch.setattr(build_pages, "PROJECT", tmp_path / "paperpilot")
    monkeypatch.setattr(build_pages, "DOCS_ROOT", tmp_path / "docs")

    conf_dir = tmp_path / "paperpilot" / "output" / "cvpr-2026"
    _write_summary(conf_dir / "summary.csv", [_row()])
    (conf_dir / "papers_2026-05-01.csv").write_text("title\nA\n", encoding="utf-8")
    (conf_dir / "papers_2026-06-27.csv").write_text("title\nA\n", encoding="utf-8")
    (conf_dir / build_summary_csv.SUMMARY_META_FILENAME).write_text(
        json.dumps({"source": "papers_2026-01-01.csv"}), encoding="utf-8"
    )

    entry = build_pages.build_conference("cvpr-2026")
    assert entry is not None
    assert entry["generated"] == "2026-06-27"
