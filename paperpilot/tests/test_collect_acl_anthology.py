"""Tests for paperpilot/scripts/collect_acl_anthology.py.

Parsing is pure given XML bytes; fetch_xml is exercised by patching
request_with_retry. No network. main() refuses a fetch whose XML carries none of
the main-track volume ids, and one that is missing a volume within the naming
convention in use, so a thinner collection is never published silently; the
second case goes through only with an explicit --allow-missing-volume per id.
"""

from __future__ import annotations

import csv as _csv
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from paperpilot.scripts import collect_acl_anthology as acl
from paperpilot.scripts import collect_conference as cc

_XML = b"""<?xml version="1.0"?>
<collection id="2025.acl">
  <volume id="long">
    <meta><booktitle>Long Papers</booktitle></meta>
    <paper id="0"><title>Proceedings front matter</title><url>2025.acl-long.0</url></paper>
    <paper id="1">
      <title>A <fixed-case>G</fixed-case>raph Method</title>
      <author><first>Bo</first><last>Pan</last><affiliation>X Univ</affiliation></author>
      <author><first>Mei</first><last>Li</last></author>
      <abstract>We study graphs and <i>attention</i>.</abstract>
      <url>2025.acl-long.1</url>
    </paper>
  </volume>
  <volume id="short">
    <paper id="2">
      <title>Short Insight</title>
      <author><first>Ann</first><last>Wu</last></author>
      <abstract>Short result.</abstract>
      <url>2025.acl-short.2</url>
    </paper>
  </volume>
  <volume id="findings">
    <paper id="3">
      <title>Findings Paper</title>
      <author><first>Foo</first><last>Bar</last></author>
      <abstract>Findings.</abstract>
      <url>2025.findings-acl.3</url>
    </paper>
  </volume>
</collection>
"""


def test_parse_papers_keeps_main_track_with_abstracts():
    rows = acl.parse_papers(_XML, "ACL")
    titles = {r["title"] for r in rows}
    assert titles == {"A Graph Method", "Short Insight"}  # long + short only
    graph = next(r for r in rows if r["title"] == "A Graph Method")
    assert graph["authors"] == "Bo Pan; Mei Li"
    assert graph["abstract"] == "We study graphs and attention."  # nested markup flattened
    assert graph["venue"] == "ACL" and graph["venue_tier"] == 2
    assert graph["url"] == "https://aclanthology.org/2025.acl-long.1/"
    assert graph["pdf_url"] == "https://aclanthology.org/2025.acl-long.1.pdf"


def test_parse_papers_skips_frontmatter_and_findings():
    rows = acl.parse_papers(_XML, "ACL")
    titles = {r["title"] for r in rows}
    assert "Proceedings front matter" not in titles  # no authors -> skipped
    assert "Findings Paper" not in titles  # findings volume excluded


def test_parse_papers_findings_included_when_requested():
    rows = acl.parse_papers(_XML, "ACL", volumes={"long", "short", "findings"})
    assert "Findings Paper" in {r["title"] for r in rows}


def test_parse_papers_dedups_and_handles_bad_xml():
    assert acl.parse_papers(b"not xml at all", "ACL") == []


def test_parse_papers_includes_emnlp_main_volume():
    # EMNLP uses a single "main" volume id (not long/short).
    xml = b"""<collection id="2025.emnlp"><volume id="main">
      <paper id="1"><title>EMNLP Main</title>
        <author><first>Em</first><last>Nlp</last></author>
        <abstract>Main track.</abstract><url>2025.emnlp-main.1</url></paper>
    </volume>
    <volume id="industry">
      <paper id="2"><title>Industry Paper</title>
        <author><first>In</first><last>Dustry</last></author>
        <url>2025.emnlp-industry.2</url></paper>
    </volume></collection>"""
    rows = acl.parse_papers(xml, "EMNLP")
    titles = {r["title"] for r in rows}
    assert "EMNLP Main" in titles  # main volume kept
    assert "Industry Paper" not in titles  # industry track excluded


# ---- the main-track volumes the XML actually carries ----

_LONG_ONLY_XML = b"""<?xml version="1.0"?>
<collection id="2025.acl">
  <volume id="long">
    <paper id="1"><title>Long Only</title>
      <author><first>Lo</first><last>Ng</last></author>
      <abstract>Long only.</abstract><url>2025.acl-long.1</url></paper>
  </volume>
</collection>
"""

_NO_MAIN_TRACK_XML = b"""<?xml version="1.0"?>
<collection id="2026.acl">
  <volume id="workshops">
    <paper id="1"><title>Workshop Paper</title>
      <author><first>Wo</first><last>rk</last></author>
      <abstract>Workshop.</abstract><url>2026.acl-ws.1</url></paper>
  </volume>
  <volume id="findings">
    <paper id="2"><title>Findings Paper</title>
      <author><first>Fin</first><last>Dings</last></author>
      <abstract>Findings.</abstract><url>2026.findings-acl.2</url></paper>
  </volume>
</collection>
"""

_XML_ID_ARGV = [
    "collect_acl_anthology.py",
    "--conference",
    "acl-2026",
    "--venue",
    "ACL",
    "--xml-id",
    "2026.acl",
]


def test_present_volume_ids_lists_the_ids_the_file_carries() -> None:
    assert acl.present_volume_ids(_XML) == ["long", "short", "findings"]
    assert acl.present_volume_ids(_NO_MAIN_TRACK_XML) == ["workshops", "findings"]
    # Unparseable XML carries nothing, which the caller reads as an incomplete fetch.
    assert acl.present_volume_ids(b"not xml at all") == []


def test_main_refuses_a_collection_with_no_main_track_volume(monkeypatch, capsys) -> None:
    """A collection carrying no main-track id at all is the whole track gone.

    Either the venue's main track was renamed out of the ids this script knows, or --xml-id
    names a different collection. parse_papers keeps only the main-track volumes, so such a
    fetch is indistinguishable from a venue that has no main track, and writing what came
    back would take every acceptance of this venue out of the catalog. The run stops with
    nothing written and names the ids it did find. One volume missing while the convention
    in use still holds another is the missing-volume refusal, not this one.
    """
    written: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _NO_MAIN_TRACK_XML)
    monkeypatch.setattr(acl, "write_outputs", lambda *a, **kw: written.append(a))
    monkeypatch.setattr(sys, "argv", _XML_ID_ARGV)

    assert acl.main() == 1
    assert written == []
    out = capsys.readouterr().out
    assert "carries none of the main-track volume ids" in out
    assert "found volume ids: findings, workshops" in out
    assert "Nothing written" in out
    # Distinguishable from the 0-rows refusal, which also lists the found ids: an
    # operator has to be able to tell "no main track here" from "a main track with no
    # papers in it" from the message alone.
    assert "0 papers" not in out
    assert "has no main-track volume named" not in out


def test_main_refuses_a_missing_volume_within_the_convention(monkeypatch, capsys) -> None:
    """A proceedings missing a volume the convention says is there is a half collection.

    Some years genuinely have no short papers and a single EMNLP "main" volume is complete,
    but from here a renamed track looks the same, so the run stops instead of publishing
    the thinner set. The ids that did not turn up are named, as is the flag that lets the
    operator say the gap is real.
    """
    written: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _LONG_ONLY_XML)
    monkeypatch.setattr(
        acl, "write_outputs", lambda *a, **kw: written.append(a) or Path("papers.csv")
    )
    monkeypatch.setattr(sys, "argv", _XML_ID_ARGV)

    assert acl.main() == 1
    assert written == []
    out = capsys.readouterr().out
    # Only "short" is named: "main" belongs to the other convention and is absent from
    # every ACL run, so reporting it would flag a complete collection as a broken one.
    assert "has no main-track volume named short (" in out
    assert "found volume ids: long" in out
    assert "--allow-missing-volume short" in out
    assert "Nothing written." in out
    assert "0 papers" not in out


def test_main_collects_a_missing_volume_once_the_operator_acknowledges_it(
    monkeypatch, capsys
) -> None:
    """--allow-missing-volume is the explicit "this venue really has no such volume".

    The year with no short papers is legitimate, so the acknowledgement has to be enough to
    collect the volumes that are there — one flag per id, nothing more.
    """
    written: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _LONG_ONLY_XML)
    monkeypatch.setattr(
        acl, "write_outputs", lambda *a, **kw: written.append(a) or Path("papers.csv")
    )
    monkeypatch.setattr(sys, "argv", [*_XML_ID_ARGV, "--allow-missing-volume", "short"])

    assert acl.main() == 0
    assert len(written) == 1
    out = capsys.readouterr().out
    assert "has no main-track volume named" not in out
    assert "0 papers" not in out


def test_main_refuses_an_acknowledgement_that_names_no_missing_volume(monkeypatch, capsys) -> None:
    """A typo in the acknowledgement must not read to the operator as a loosened gate.

    "main" is a real Anthology volume id — just not one this long/short collection is
    missing — so accepting it would let a later run skip the gate without anyone noticing.
    """
    written: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _LONG_ONLY_XML)
    monkeypatch.setattr(
        acl, "write_outputs", lambda *a, **kw: written.append(a) or Path("papers.csv")
    )
    monkeypatch.setattr(sys, "argv", [*_XML_ID_ARGV, "--allow-missing-volume", "main"])

    assert acl.main() == 1
    assert written == []
    out = capsys.readouterr().out
    assert "acknowledges nothing" in out
    assert "convention in use is (long, short)" in out
    assert "Nothing written." in out


def test_main_does_not_refuse_a_complete_convention(monkeypatch, capsys) -> None:
    """An EMNLP-style single "main" volume is complete; nothing is refused for long/short."""
    xml = _LONG_ONLY_XML.replace(b'id="long"', b'id="main"')
    assert xml != _LONG_ONLY_XML
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: xml)
    monkeypatch.setattr(acl, "write_outputs", lambda *a, **kw: Path("papers.csv"))
    monkeypatch.setattr(sys, "argv", _XML_ID_ARGV)

    assert acl.main() == 0
    assert "has no main-track volume named" not in capsys.readouterr().out


def test_main_reports_the_volumes_it_found_when_no_paper_survives(monkeypatch, capsys) -> None:
    """A main-track volume full of front matter is the same silent-empty risk.

    The zero-row refusal already existed; it now names the volume ids so an operator can
    see whether the tracks were there and empty or gone entirely. Both convention volumes
    are present here, so the run reaches the row count instead of the missing-volume gate.
    """
    xml = (
        b'<collection id="2026.acl"><volume id="long">'
        b'<paper id="1"><title>T</title></paper></volume>'
        b'<volume id="short"><paper id="2"><title>U</title></paper></volume></collection>'
    )
    written: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: xml)
    monkeypatch.setattr(acl, "write_outputs", lambda *a, **kw: written.append(a))
    monkeypatch.setattr(sys, "argv", _XML_ID_ARGV)

    assert acl.main() == 1
    assert written == []
    out = capsys.readouterr().out
    assert "0 papers" in out and "found volume ids: long" in out
    # The other two refusals name what this one cannot: no main track at all, and a main
    # track missing a volume the convention says is there.
    assert "carries none of the main-track volume ids" not in out
    assert "has no main-track volume named" not in out


def test_venue_tier():
    assert acl._venue_tier("ACL") == 2
    assert acl._venue_tier("EMNLP") == 2
    assert acl._venue_tier("NAACL") == 3
    assert acl._venue_tier("???") == 0


def test_fetch_xml_ok_and_failsafe():
    ok = SimpleNamespace(status_code=200, content=b"<x/>")
    with patch.object(acl, "request_with_retry", return_value=ok):
        assert acl.fetch_xml("2025.acl") == b"<x/>"
    with patch.object(acl, "request_with_retry", return_value=None):
        assert acl.fetch_xml("2025.acl") is None


def test_rows_write_via_shared_writer(tmp_path: Path):
    rows = acl.parse_papers(_XML, "ACL")
    csv_path = cc.write_outputs("acl-2025", rows, [], output_root=tmp_path, date="2026-06-28")
    with csv_path.open(encoding="utf-8-sig") as f:
        read = list(_csv.DictReader(f))
    assert list(read[0].keys()) == cc._CSV_COLUMNS
    # an empty oral list writes no oral md of its own
    assert not (tmp_path / "acl-2025" / "oral_summaries_ja.md").exists()


def test_empty_oral_list_keeps_the_published_oral_md(tmp_path: Path) -> None:
    """The Anthology marks no oral/spotlight, so a plain re-collection always
    passes an empty list here; that must not erase the Oral labels an earlier
    --oral-arxiv-query overlay established."""
    conf_dir = tmp_path / "acl-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# acl-2025 Oral / Highlight\n## 1. A Graph Method\n"
    oral_md.write_text(existing, encoding="utf-8")

    cc.write_outputs(
        "acl-2025",
        acl.parse_papers(_XML, "ACL"),
        [],
        output_root=tmp_path,
        date="2026-06-28",
    )

    assert oral_md.read_text(encoding="utf-8") == existing


def test_clear_oral_deletes_the_published_oral_md(tmp_path: Path) -> None:
    """--clear-oral (clear_oral=True) is the explicit way to drop the Oral marks."""
    conf_dir = tmp_path / "acl-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    oral_md.write_text("# acl-2025 Oral / Highlight\n## 1. A Graph Method\n", encoding="utf-8")

    cc.write_outputs(
        "acl-2025",
        acl.parse_papers(_XML, "ACL"),
        [],
        output_root=tmp_path,
        date="2026-06-28",
        clear_oral=True,
    )

    assert not oral_md.exists()


def test_main_passes_clear_oral_through(tmp_path: Path, monkeypatch) -> None:
    """--clear-oral must reach the shared writer; the default must not clear."""
    captured: list[dict[str, object]] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _XML)
    monkeypatch.setattr(
        acl, "write_outputs", lambda *a, **kw: captured.append(kw) or Path("papers.csv")
    )
    argv = [
        "collect_acl_anthology.py",
        "--conference",
        "acl-2025",
        "--venue",
        "ACL",
        "--xml-id",
        "2025.acl",
    ]
    with patch.object(sys, "argv", argv):
        assert acl.main() == 0
    with patch.object(sys, "argv", [*argv, "--clear-oral"]):
        assert acl.main() == 0

    assert [kw["clear_oral"] for kw in captured] == [False, True]


_ORAL_ARGV = [
    "collect_acl_anthology.py",
    "--conference",
    "acl-2025",
    "--venue",
    "ACL",
    "--xml-id",
    "2025.acl",
    "--oral-arxiv-query",
    'co:"ACL 2025"',
]


def test_main_oral_max_defaults_to_the_overlay_cap(monkeypatch) -> None:
    """--oral-max must widen the very cap the overlay reports hitting.

    A second literal default would let the operator raise one and still trip the
    other, so the collector's default is the overlay's own constant.
    """
    captured: list[tuple] = []
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _XML)
    monkeypatch.setattr(
        acl, "write_outputs", lambda *a, **kw: (captured.append(a), Path("papers.csv"))[1]
    )
    monkeypatch.setattr(sys, "argv", _ORAL_ARGV)
    with patch.object(cc, "fetch_results", return_value=[]) as fetch:
        assert acl.main() == 0

    assert fetch.call_args.args[1] == cc.ORAL_MAX_RESULTS_DEFAULT
    assert captured[0][2] == []


def test_main_skips_a_truncated_overlay_and_keeps_the_published_oral_md(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """A full arXiv window must not replace the published oral list with a partial one.

    The overlay is newest-first and bounded, so filling it says nothing about the
    older acceptances. The collector then passes an empty list, which is what
    ``write_outputs`` already treats as "leave oral_summaries_ja.md alone".
    """
    conf_dir = tmp_path / "output" / "acl-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# acl-2025 Oral / Highlight\n## 1. A Graph Method\n"
    oral_md.write_text(existing, encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _XML)
    # Exactly --oral-max results: the window is full, so the overlay is incomplete.
    filled = [
        SimpleNamespace(title=f"Oral {i}", comment="Accepted to ACL 2025 (Oral)")
        for i in range(2)
    ]
    monkeypatch.setattr(cc, "fetch_results", lambda *a, **kw: filled)
    monkeypatch.setattr(sys, "argv", [*_ORAL_ARGV, "--oral-max", "2"])

    assert acl.main() == 0
    assert oral_md.read_text(encoding="utf-8") == existing
    out = capsys.readouterr().out
    assert "oral overlay filled the --oral-max 2 window" in out
    assert "(0 oral via arXiv)" in out


def _malformed_feed_fetch(results: list[SimpleNamespace]):
    """A stand-in for ``fetch_results`` that logs the client's malformed-feed warning.

    Mirrors arxiv 4.0.1, which logs and hands back the partial page instead of raising —
    see test_collect_conference.py for the test that pins that against the library.
    """

    def _fetch(*_args: object, **_kwargs: object) -> list[SimpleNamespace]:
        logging.getLogger("arxiv").warning(
            "Malformed feed; consider handling: %s", "not well-formed (invalid token)"
        )
        return results

    return _fetch


@pytest.mark.parametrize("incomplete", ["window", "malformed"])
def test_main_an_incomplete_overlay_does_not_authorize_clear_oral(
    tmp_path: Path, monkeypatch, capsys, incomplete: str
) -> None:
    """--clear-oral is an operator decision about a KNOWN oral set, nothing else.

    Both incomplete cases hand back no titles, and neither says the venue has no orals:
    the window never reached the older acceptances, the malformed feed dropped entries from
    the middle. Removing the published list on that reading would turn every paper into
    Poster. Each case must also print its own advice, because only one of them is fixed by
    raising --oral-max.
    """
    conf_dir = tmp_path / "output" / "acl-2025"
    conf_dir.mkdir(parents=True)
    oral_md = conf_dir / "oral_summaries_ja.md"
    existing = "# acl-2025 Oral / Highlight\n## 1. A Graph Method\n"
    oral_md.write_text(existing, encoding="utf-8")

    monkeypatch.setattr(cc, "PROJECT", tmp_path)
    monkeypatch.setattr(acl, "fetch_xml", lambda *a, **kw: _XML)
    filled = [
        SimpleNamespace(title=f"Oral {i}", comment="Accepted to ACL 2025 (Oral)")
        for i in range(2)
    ]
    fetch = _malformed_feed_fetch(filled) if incomplete == "malformed" else lambda *a, **kw: filled
    monkeypatch.setattr(cc, "fetch_results", fetch)
    monkeypatch.setattr(sys, "argv", [*_ORAL_ARGV, "--oral-max", "2", "--clear-oral"])

    assert acl.main() == 0
    assert oral_md.read_text(encoding="utf-8") == existing
    out = capsys.readouterr().out
    assert "(0 oral via arXiv)" in out
    if incomplete == "window":
        assert "filled the --oral-max 2 window" in out and "malformed" not in out
    else:
        assert "malformed feed" in out and "filled the --oral-max" not in out
