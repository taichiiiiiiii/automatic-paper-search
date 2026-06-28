"""Tests for paperpilot/scripts/collect_acl_anthology.py.

Parsing is pure given XML bytes; fetch_xml is exercised by patching
request_with_retry. No network.
"""

from __future__ import annotations

import csv as _csv
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    # no oral md when highlighted list is empty
    assert not (tmp_path / "acl-2025" / "oral_summaries_ja.md").exists()
