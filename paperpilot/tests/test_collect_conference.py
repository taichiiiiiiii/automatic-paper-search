"""Tests for paperpilot/scripts/collect_conference.py.

Network (arXiv) is never hit — build_rows / write_outputs are pure given
duck-typed result objects, so we feed SimpleNamespace stand-ins for
arxiv.Result, and the one test that drives the installed arxiv client patches
its session's get(). The key invariant: the SAME VenueSignal acceptance
semantics the pipeline uses (keep "accepted to <venue>", drop workshop /
bare-mention / other-venue) carry through here.
"""

from __future__ import annotations

import csv as _csv
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import arxiv
import pytest

from paperpilot.scripts import collect_conference as cc


def _result(title: str, comment: str, aid: str, authors: tuple[str, ...] = ("Alice", "Bob")):
    return SimpleNamespace(
        title=title,
        summary="an abstract about computer vision",
        comment=comment,
        entry_id=f"http://arxiv.org/abs/{aid}v1",
        pdf_url=f"https://arxiv.org/pdf/{aid}v1",
        authors=[SimpleNamespace(name=n) for n in authors],
    )


def _malformed_fetch(results: list[SimpleNamespace]):
    """A stand-in for ``fetch_results`` that logs the client's malformed-feed warning.

    ``arxiv`` retries an HTTP error and an empty non-first page and then raises, so a
    malformed feed is the only way the library returns quietly with entries missing.
    """

    def _fetch(*_args: object, **_kwargs: object) -> list[SimpleNamespace]:
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
        )
        return results

    return _fetch


def test_build_rows_keeps_genuine_acceptance_only():
    results = [
        _result("Accepted paper", "Accepted to CVPR 2026", "2604.00001"),
        _result("Highlight paper", "Accepted to CVPR 2026 (Highlight)", "2604.00002"),
        _result("Workshop paper", "CVPR 2026 FGVC Workshop", "2604.00003"),
        _result("Bare mention", "CVPR 2026", "2604.00004"),
        _result("Other venue", "Accepted to ICLR 2026", "2604.00005"),
        _result("No comment", "", "2604.00006"),
    ]
    rows, orals = cc.build_rows(results, "CVPR")

    titles = {r["title"] for r in rows}
    # workshop, bare mention, other venue, and no-comment are all dropped
    assert titles == {"Accepted paper", "Highlight paper"}
    assert all(r["venue"] == "CVPR" and r["venue_tier"] == 2 for r in rows)
    assert all(r["citation_count"] == 0 and r["github_stars"] == 0 for r in rows)
    # only the Highlight one carries an oral marker
    assert orals == ["Highlight paper"]


def test_oral_titles_from_arxiv_overlay():
    """The overlay helper returns only the venue's arXiv oral/highlight titles."""
    from unittest.mock import patch

    results = [
        _result("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
        _result("Highlight two", "Accepted to CVPR 2025 Highlight", "2501.00002"),
        _result("Plain poster", "Accepted to CVPR 2025", "2501.00003"),
        _result("Other venue oral", "Accepted to ICLR 2025 (Oral)", "2501.00004"),
    ]
    with patch.object(cc, "fetch_results", return_value=results) as fr:
        overlay = cc.oral_titles_from_arxiv('co:"CVPR 2025"', "CVPR")
    fr.assert_called_once()
    # CVPR orals only; poster + other venue excluded. A usable overlay carries no reason.
    assert overlay.titles == ["Oral one", "Highlight two"]
    assert overlay.reason is None


def test_oral_titles_from_arxiv_returns_none_when_the_window_is_full(capsys):
    """A fetch that fills the whole window proves nothing about the older acceptances.

    The scan is newest-first and bounded, so returning the titles it did find would
    let ``write_outputs`` replace the published oral file with a partial list.
    """
    results = [
        _result("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
        _result("Oral two", "Accepted to CVPR 2025 (Oral)", "2501.00002"),
        _result("Poster three", "Accepted to CVPR 2025", "2501.00003"),
    ]
    with patch.object(cc, "fetch_results", return_value=results):
        overlay = cc.oral_titles_from_arxiv('co:"CVPR 2025"', "CVPR", max_results=3)
    assert overlay.titles is None and overlay.reason == cc.ORAL_WINDOW_FILLED

    warning = capsys.readouterr().out
    assert "--oral-max" in warning and "3" in warning
    assert "malformed" not in warning


def test_oral_titles_from_arxiv_returns_titles_below_the_cap():
    """One result short of the cap: the client paginated to the end and raised nothing."""
    results = [
        _result("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
        _result("Poster two", "Accepted to CVPR 2025", "2501.00002"),
    ]
    with patch.object(cc, "fetch_results", return_value=results):
        overlay = cc.oral_titles_from_arxiv('co:"CVPR 2025"', "CVPR", max_results=3)
    assert overlay.titles == ["Oral one"] and overlay.reason is None


def test_oral_titles_from_arxiv_returns_none_on_a_malformed_feed(capsys):
    """A skipped malformed page makes even a short return an incomplete scan.

    The client logs and keeps going there, so the fetched set is missing entries from the
    middle; the overlay must not replace the published oral list with the remainder it
    happened to read.
    """
    results = [
        _result("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
        _result("Poster two", "Accepted to CVPR 2025", "2501.00002"),
    ]

    with patch.object(cc, "fetch_results", side_effect=_malformed_fetch(results)):
        overlay = cc.oral_titles_from_arxiv('co:"CVPR 2025"', "CVPR", max_results=3)
    assert overlay.titles is None and overlay.reason == cc.ORAL_MALFORMED_FEED

    warning = capsys.readouterr().out
    assert "malformed" in warning and "--oral-max" not in warning


def test_fetch_results_checked_reports_completeness():
    """The completeness flag comes from the malformed-feed warning, and only from it.

    HTTP errors and an empty non-first page raise out of the client, so a fetched list
    that size short is normally the whole venue; the malformed feed is the one partial
    return that arrives without an exception. An unrelated arXiv warning must not be
    mistaken for one, and the temporary handler must not outlive the fetch.
    """
    logger = logging.getLogger("arxiv")
    results = _accepted_results(2)
    before = list(logger.handlers)

    with patch.object(cc, "fetch_results", return_value=results) as fr:
        fetched, complete = cc.fetch_results_checked('co:"CVPR 2026"', 3)
    assert (fetched, complete) == (results, True)
    # Still the raw fetch under the same positional call the other collectors mock.
    assert fr.call_args.args == ('co:"CVPR 2026"', 3)

    def _warn(message: str):
        def _fetch(*_args: object, **_kwargs: object) -> list[SimpleNamespace]:
            logger.warning(message)
            return results

        return _fetch

    with patch.object(cc, "fetch_results", side_effect=_warn("unrelated notice")):
        assert cc.fetch_results_checked('co:"CVPR 2026"', 3)[1] is True

    with patch.object(cc, "fetch_results", side_effect=_malformed_fetch(results)):
        fetched, complete = cc.fetch_results_checked('co:"CVPR 2026"', 3)
    assert complete is False
    assert fetched == results

    assert list(logger.handlers) == before


def _installed_client_outcome(monkeypatch, caplog, body: bytes) -> SimpleNamespace:
    """Run the real ``arxiv.Client`` over one canned response body, offline.

    Only the session's ``get`` is replaced, so the library's own Atom parser, its
    malformed-feed branch and its pagination all run unchanged.
    """
    requested: list[str] = []
    response = SimpleNamespace(status_code=200, content=body)

    def _get(url: str, **_kwargs: object) -> SimpleNamespace:
        requested.append(url)
        return response

    client = arxiv.Client(page_size=1, delay_seconds=0, num_retries=0)
    monkeypatch.setattr(client._session, "get", _get)
    caplog.clear()
    raised: Exception | None = None
    # Same reason fetch_results_checked lifts the level itself: an ambient ERROR level
    # on the arxiv logger would hide the warning and read as a clean fetch.
    with caplog.at_level(logging.WARNING, logger="arxiv"):
        try:
            results = list(client.results(arxiv.Search(query='co:"CVPR 2026"', max_results=5)))
        except Exception as exc:  # the outage path is the other half of what is pinned
            results, raised = [], exc

    return SimpleNamespace(
        body=body,
        results=results,
        raised=raised,
        requests=len(requested),
        malformed_records=[
            record
            for record in caplog.records
            if record.name == "arxiv"
            and record.getMessage().startswith(cc._MALFORMED_FEED_PREFIX)
        ],
    )


def test_installed_arxiv_client_warns_on_a_malformed_page(caplog, monkeypatch) -> None:
    """Pin the third-party contract ``fetch_results_checked`` rests on, offline.

    arxiv 4.0.1 (the version uv.lock pins, and what ``fetch_results`` talks to) hands every
    page to its own lxml parser and, when that parser reports the document malformed, logs
    ``Malformed feed; consider handling: ...`` on the "arxiv" logger and HANDS BACK the page
    it could read — no exception. That warning is therefore the only observable sign of a
    silent partial return, so ``_MALFORMED_FEED_PREFIX`` has to keep matching the installed
    library and not just this suite's stand-ins. If a bump makes a malformed page raise
    instead of warn, or warn with different words, this test fails and the collectors'
    completeness gate has to be re-read rather than trusted.

    Several broken bodies are tried because the parser runs with ``recover=True``: it fixes
    some damaged documents quietly and reports others as malformed, so what matters here is
    that a garbage response really can reach the warn-and-continue branch.
    """
    outcomes = [
        _installed_client_outcome(monkeypatch, caplog, body)
        for body in (b"<not xml", b"not xml at all", b"")
    ]

    warned = [outcome for outcome in outcomes if outcome.malformed_records]
    assert warned, (
        "no non-XML response body made the installed arxiv client log a warning starting "
        f"with {cc._MALFORMED_FEED_PREFIX!r}, and none raised: fetch_results_checked has no "
        "signal left for a partial return and its completeness gate is now blind"
    )
    for outcome in warned:
        assert all(r.levelno >= logging.WARNING for r in outcome.malformed_records)
        # The malformed page is returned as a finished fetch: the caller has to judge it
        # from the log line, and the empty first page stops pagination after one request.
        assert outcome.raised is None, outcome.body
        assert outcome.results == [], outcome.body
        assert outcome.requests == 1, outcome.body


def test_build_rows_is_case_insensitive_on_venue_arg():
    results = [_result("P", "Accepted to CVPR 2026", "2604.00010")]
    rows, _ = cc.build_rows(results, "cvpr")  # lowercase arg
    assert len(rows) == 1 and rows[0]["venue"] == "CVPR"


def test_build_rows_dedups_by_arxiv_id():
    results = [
        _result("First", "Accepted to CVPR 2026", "2604.00001"),
        _result("Duplicate same id", "Accepted to CVPR 2026", "2604.00001"),
    ]
    rows, _ = cc.build_rows(results, "CVPR")
    assert len(rows) == 1 and rows[0]["title"] == "First"


def test_build_rows_skips_unparseable_id():
    bad = SimpleNamespace(
        title="No id",
        summary="x",
        comment="Accepted to CVPR 2026",
        entry_id="not-a-real-url",
        pdf_url="",
        authors=[],
    )
    rows, _ = cc.build_rows([bad], "CVPR")
    assert rows == []


def test_write_outputs_schema_and_oral_md(tmp_path: Path):
    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026 Oral", "2604.00009")], "CVPR"
    )
    csv_path = cc.write_outputs("cvpr-2026", rows, orals, output_root=tmp_path, date="2026-06-28")

    assert csv_path == tmp_path / "cvpr-2026" / "papers_2026-06-28.csv"
    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS
    assert read[0]["arxiv_id"] == "2604.00009"
    assert read[0]["venue"] == "CVPR"
    assert read[0]["source"] == "arxiv"
    assert read[0]["source_id"] == "2604.00009"

    oral_md = (tmp_path / "cvpr-2026" / "oral_summaries_ja.md").read_text(encoding="utf-8")
    assert "## 1. Paper One" in oral_md


def test_write_outputs_no_oral_md_when_empty(tmp_path: Path):
    rows, orals = cc.build_rows([_result("Poster", "Accepted to CVPR 2026", "2604.00011")], "CVPR")
    cc.write_outputs("cvpr-2026", rows, orals, output_root=tmp_path, date="2026-06-28")
    assert not (tmp_path / "cvpr-2026" / "oral_summaries_ja.md").exists()


def _poster_row() -> list[dict[str, object]]:
    return [
        {
            "title": "P",
            "authors": "",
            "venue": "CVPR",
            "venue_tier": 2,
            "citation_count": 0,
            "github_stars": 0,
            "arxiv_id": "",
            "abstract": "",
            "url": "https://arxiv.org/abs/2404.00007",
            "pdf_url": "",
            "comment": "",
        }
    ]


def test_write_outputs_keeps_the_existing_oral_md_when_a_run_finds_no_orals(
    tmp_path: Path,
) -> None:
    """Regression: an empty oral list must NOT delete the published oral list.

    The list is empty for the benign reason too — a CVF/ACL re-collection without
    --oral-arxiv-query, or an overlay whose fetch came back empty — and deleting it
    there silently turns every paper of the catalog into Poster. Removal is an
    explicit operator decision (--clear-oral).
    """
    conf_dir = tmp_path / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# old\n## 1. Some Old Oral Title\n"
    oral_md.write_text(existing, encoding="utf-8")

    cc.write_outputs("cvpr-2025", _poster_row(), [], output_root=tmp_path, date="2026-06-28")

    assert oral_md.read_text(encoding="utf-8") == existing


def test_write_outputs_clear_oral_deletes_the_existing_oral_md(tmp_path: Path) -> None:
    """clear_oral=True keeps the old delete-on-empty escape hatch available."""
    conf_dir = tmp_path / "cvpr-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    oral_md.write_text("# old\n## 1. Some Old Oral Title\n", encoding="utf-8")

    cc.write_outputs(
        "cvpr-2025",
        _poster_row(),
        [],
        output_root=tmp_path,
        date="2026-06-28",
        clear_oral=True,
    )

    assert not oral_md.exists()


def test_main_passes_clear_oral_through(tmp_path: Path, monkeypatch) -> None:
    """--clear-oral must reach the shared writer; the default must not clear."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    fake_result = _result("Poster", "Accepted to CVPR 2026", "2604.00012")
    argv = [
        "collect_conference.py",
        "--conference",
        "cvpr-2026",
        "--venue",
        "CVPR",
        "--query",
        'co:"CVPR 2026"',
    ]
    captured: list[dict[str, object]] = []
    monkeypatch.setattr(
        cc, "write_outputs", lambda *a, **kw: captured.append(kw) or Path("papers.csv")
    )
    with patch.object(cc, "fetch_results", return_value=[fake_result]):
        with patch.object(sys, "argv", argv):
            assert cc.main() == 0
        with patch.object(sys, "argv", [*argv, "--clear-oral"]):
            assert cc.main() == 0

    assert [kw["clear_oral"] for kw in captured] == [False, True]


def _accepted_results(count: int, *, start: int = 1) -> list[SimpleNamespace]:
    """``count`` genuine CVPR acceptances, each with its own arXiv id."""
    return [
        _result(f"Paper {i}", "Accepted to CVPR 2026", f"2604.{i:05d}")
        for i in range(start, start + count)
    ]


def _main_argv(*, conference: str = "cvpr-2026", maxn: str) -> list[str]:
    return [
        "collect_conference.py",
        "--conference",
        conference,
        "--venue",
        "CVPR",
        "--query",
        'co:"CVPR 2026"',
        "--max",
        maxn,
    ]


def _written_papers_csv(project_root: Path, conference: str = "cvpr-2026") -> list[Path]:
    conf_dir = project_root / "output" / conference
    return sorted(conf_dir.glob("papers_*.csv")) if conf_dir.is_dir() else []


def test_main_refuses_a_fetch_that_filled_the_max_window(tmp_path: Path, monkeypatch, capsys):
    """A fetch that hands back the whole --max window is a slice of the venue, not a venue.

    The scan is newest-first and bounded, so a full window proves nothing about the older
    acceptances. For a NEW conference build_pages has no published catalog to compare
    against, so the shrink gate cannot catch it either — the partial catalog and the
    partial oral list would simply go online.
    """
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    results = _accepted_results(3)

    with patch.object(cc, "fetch_results", return_value=results):
        with patch.object(sys, "argv", _main_argv(maxn="3")):
            rc = cc.main()

    assert rc == 1
    out = capsys.readouterr().out
    assert "--max window truncated" in out and "3-result" in out
    assert "Raise --max" in out
    assert _written_papers_csv(tmp_path) == []
    assert not (tmp_path / "output" / "cvpr-2026" / "oral_summaries_ja.md").exists()


def test_no_allow_truncated_escape_hatch_exists(tmp_path: Path, monkeypatch):
    """Regression test: there is no opt-in override to publish a truncated window.

    Same policy as collect_openreview's --allow-partial removal (closes #388): a written
    papers_<date>.csv carries no marker separating "authoritative complete" from
    "partial", so forcing one under the same filename/schema only hides the loss. The
    refusal must be unconditional, so argparse rejects --allow-truncated as unknown.
    """
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    results = _accepted_results(3)

    with patch.object(cc, "fetch_results", return_value=results):
        with patch.object(sys, "argv", [*_main_argv(maxn="3"), "--allow-truncated"]):
            with pytest.raises(SystemExit):
                cc.main()

    assert _written_papers_csv(tmp_path) == []
    assert not (tmp_path / "output").exists()


def test_main_refuses_a_malformed_arxiv_feed(tmp_path: Path, monkeypatch, capsys):
    """The client's one silent partial path must not be published as a venue.

    A malformed feed is logged and skipped instead of raised, so entries are missing from
    the middle of the window while the list still looks short-but-complete — exactly the
    case the length check cannot see.
    """
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    results = _accepted_results(2)

    with patch.object(cc, "fetch_results", side_effect=_malformed_fetch(results)):
        with patch.object(sys, "argv", _main_argv(maxn="3")):
            rc = cc.main()

    assert rc == 1
    out = capsys.readouterr().out
    assert "malformed" in out and "Nothing written" in out
    assert _written_papers_csv(tmp_path) == []


def test_main_writes_when_the_window_came_back_short(tmp_path: Path, monkeypatch):
    """One result below the cap is a complete fetch, given how the client fails.

    ``arxiv.Client._results`` retries an HTTP error and an empty non-first page and then
    raises, and it keeps paginating until ``total_results`` — so a list that size short
    means the window held everything, not that the outage was swallowed. A malformed feed
    is the exception to that reading and is detected separately by fetch_results_checked.
    """
    monkeypatch.setattr(cc, "PROJECT", tmp_path)

    with patch.object(cc, "fetch_results", return_value=_accepted_results(2)):
        with patch.object(sys, "argv", _main_argv(maxn="3")):
            rc = cc.main()

    assert rc == 0
    written = _written_papers_csv(tmp_path)
    assert len(written) == 1
    with written[0].open(encoding="utf-8-sig") as f:
        assert len(list(_csv.DictReader(f))) == 2


def test_write_outputs_rejects_path_traversal_conference_slug(tmp_path: Path):
    """Regression test (closes #390): a malicious --conference value must
    be rejected outright, never used to escape the output root."""
    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026", "2604.00009")], "CVPR"
    )
    for bad in ("../../etc/passwd", "..", "/etc/passwd", "cvpr/../../escape", ""):
        with pytest.raises(ValueError):
            cc.write_outputs(bad, rows, orals, output_root=tmp_path, date="2026-06-28")
    # Nothing must have been written inside the root...
    assert list(tmp_path.iterdir()) == []
    # ...and prove the "outside" claim concretely: compute exactly what the
    # unvalidated old code (`root / conference`) would have resolved to for
    # one representative traversal string, and assert nothing exists there.
    escape_target = (tmp_path / "../../etc/passwd").resolve()
    assert not escape_target.exists()


def test_main_cli_rejects_malicious_conference_argv(tmp_path: Path, monkeypatch):
    """Regression test (closes #390 follow-up): the actual CLI entry point
    (main(), not just write_outputs() called directly) must refuse a
    malicious --conference argv value before any output is written."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    fake_result = _result("Paper One", "Accepted to CVPR 2026", "2604.00009")
    with patch.object(cc, "fetch_results", return_value=[fake_result]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "../../etc/passwd",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            with pytest.raises(ValueError):
                cc.main()
    assert not (tmp_path / "output").exists()


def test_main_writes_nothing_when_zero_papers_matched(tmp_path: Path, monkeypatch):
    """Regression test (closes #389): when 0 papers match, main() must NOT
    call write_outputs() at all — the old ordering wrote a header-only CSV
    for today's date first and checked `if not rows` after, silently
    overwriting/masking an existing good catalog file from an earlier run
    on the same day."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    # A result whose comment doesn't match VenueSignal's acceptance pattern
    # for CVPR -> build_rows() filters it out -> rows == [].
    non_matching = _result("Irrelevant Paper", "Just a preprint, not accepted anywhere", "2604.00099")
    with patch.object(cc, "fetch_results", return_value=[non_matching]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "cvpr-2026",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            rc = cc.main()
    assert rc == 1
    # No output/ directory (and thus no papers_<date>.csv) must exist.
    assert not (tmp_path / "output").exists()


def test_main_does_not_overwrite_existing_same_day_csv_on_zero_matches(
    tmp_path: Path, monkeypatch
):
    """Regression test (closes #389): a same-day re-run that matches 0
    papers (e.g. a transient VenueSignal/query issue) must leave an
    existing good papers_<date>.csv from an earlier run untouched."""
    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    today = cc.datetime.now(cc.timezone.utc).strftime("%Y-%m-%d")
    existing_dir = tmp_path / "output" / "cvpr-2026"
    existing_dir.mkdir(parents=True)
    existing_csv = existing_dir / f"papers_{today}.csv"
    existing_csv.write_text("title,authors\nReal Paper,Alice\n", encoding="utf-8")

    non_matching = _result("Irrelevant Paper", "Just a preprint", "2604.00099")
    with patch.object(cc, "fetch_results", return_value=[non_matching]):
        with patch.object(
            sys,
            "argv",
            [
                "collect_conference.py",
                "--conference",
                "cvpr-2026",
                "--venue",
                "CVPR",
                "--query",
                'co:"CVPR 2026"',
            ],
        ):
            rc = cc.main()
    assert rc == 1
    assert existing_csv.read_text(encoding="utf-8") == "title,authors\nReal Paper,Alice\n"


def test_write_outputs_rejects_uppercase_or_space_conference_slug(tmp_path: Path):
    """A conference value that isn't already slug-shaped is rejected, not
    silently coerced (coercion would mask an operator typo)."""
    import pytest

    rows, orals = cc.build_rows(
        [_result("Paper One", "Accepted to CVPR 2026", "2604.00009")], "CVPR"
    )
    for bad in ("CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr-2026", "cvpr-2026-"):
        with pytest.raises(ValueError):
            cc.write_outputs(bad, rows, orals, output_root=tmp_path, date="2026-06-28")


def test_write_outputs_neutralizes_spreadsheet_formula_payloads(tmp_path):
    """Regression test: the CSVExporter got formula neutralization but the
    conference collectors bypassed it, so a hostile OpenReview/CVF/ACL
    title still reached papers_*.csv and from there summary.csv."""
    import csv as _csv

    from paperpilot.scripts import collect_conference as cc

    row = {
        "title": '=HYPERLINK("http://evil.example","click")',
        "authors": "A; B",
        "abstract": "@SUM(1+1)*cmd",
        "url": "https://arxiv.org/abs/2604.00001",
        "source": "arxiv",
        "source_id": "2604.00001",
    }
    path = cc.write_outputs(
        "cvpr-2026", [row], [], output_root=tmp_path, date="2026-09-26"
    )
    with path.open(encoding="utf-8-sig", newline="") as f:
        out = list(_csv.DictReader(f))
    assert out[0]["title"].startswith("'=HYPERLINK")
    assert out[0]["abstract"].startswith("'@SUM")
    # A normal URL is not a trigger, so identity parsing downstream is
    # unaffected.
    assert out[0]["url"] == "https://arxiv.org/abs/2604.00001"


def test_write_outputs_leaves_ordinary_text_untouched(tmp_path):
    import csv as _csv

    from paperpilot.scripts import collect_conference as cc

    row = {
        "title": "Retrieval-Augmented Generation for Knowledge Tasks",
        "authors": "A; B",
        "abstract": "We propose a method.",
        "url": "https://arxiv.org/abs/2604.00002",
        "source": "arxiv",
        "source_id": "2604.00002",
    }
    path = cc.write_outputs(
        "cvpr-2026", [row], [], output_root=tmp_path, date="2026-09-26"
    )
    with path.open(encoding="utf-8-sig", newline="") as f:
        out = list(_csv.DictReader(f))
    assert out[0]["title"] == "Retrieval-Augmented Generation for Knowledge Tasks"
    assert out[0]["abstract"] == "We propose a method."


def test_arxiv_id_requires_a_real_arxiv_host():
    assert cc._arxiv_id("http://arxiv.org/abs/2604.00009v1") == "2604.00009"
    assert cc._arxiv_id("https://example.com/arxiv.org/abs/2604.00009") == ""
    assert cc._arxiv_id("https://openreview.net/forum?id=abc") == ""
    # Legacy IDs contain a slash; downstream file names assume the modern form.
    assert cc._arxiv_id("http://arxiv.org/abs/hep-th/9901001v1") == ""
