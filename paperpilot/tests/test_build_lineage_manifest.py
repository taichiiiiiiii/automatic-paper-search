"""`docs/lineage-manifest.json` must reflect the lineage data that exists.

Issue #372 P2: the unified lineage viewer's selector needs a single
manifest describing which conference lineages are populated so it can
render "clickable" vs "not generated yet" cards with one fetch instead
of probing each `docs/<conf>/lineage.json` individually (the N+1 fetch
problem the brief flags).

The generator walks every `docs/<conf>/lineage.json` and records:
  has_lineage = meta.source != "none" AND len(nodes) > 0
  node_count  = len(nodes)

Real state at time of writing:
  iclr-2026 / eccv-2024 → true / >0 nodes
  other 8 conferences   → false / 0 nodes
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from paperpilot.scripts import build_lineage_manifest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = REPO_ROOT / "docs"


def test_conference_paths_are_enumerated() -> None:
    """Every `docs/<conf>/lineage.json` must appear in the output."""
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    expected_confs = {
        p.parent.name
        for p in DOCS_ROOT.glob("*/lineage.json")
        if p.parent.name != "themes"
    }
    assert expected_confs <= set(manifest["conferences"].keys())


def test_has_lineage_true_only_when_populated() -> None:
    """Empty stubs (`meta.source == "none"` OR zero nodes) → false.

    iclr-2026 and eccv-2024 are known populated at time of writing; the
    other 8 conferences ship empty stubs and must be `false`.
    """
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    confs = manifest["conferences"]
    for slug, entry in confs.items():
        nodes = (DOCS_ROOT / slug / "lineage.json")
        data = json.loads(nodes.read_text(encoding="utf-8"))
        meta_source = (data.get("meta") or {}).get("source", "")
        real_nodes = len(data.get("nodes") or [])
        expected = meta_source != "none" and real_nodes > 0
        assert entry["has_lineage"] is expected, (
            f"{slug}: has_lineage={entry['has_lineage']} but "
            f"source={meta_source!r} nodes={real_nodes}"
        )


def test_node_count_matches_data() -> None:
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    for slug, entry in manifest["conferences"].items():
        data = json.loads(
            (DOCS_ROOT / slug / "lineage.json").read_text(encoding="utf-8")
        )
        assert entry["node_count"] == len(data.get("nodes") or [])


def test_generated_at_timestamp_present() -> None:
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    assert "generated_at" in manifest and isinstance(manifest["generated_at"], str)
    # ISO-8601 with timezone — the generator uses datetime.now(UTC).
    assert "T" in manifest["generated_at"]


def test_known_populated_conferences() -> None:
    """iclr-2026 and eccv-2024 are the only two with lineage data today.

    If a future run adds more, this test needs updating — but that is
    exactly the kind of drift we want a hard assertion on.
    """
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    populated = {
        slug
        for slug, entry in manifest["conferences"].items()
        if entry["has_lineage"]
    }
    assert populated == {"iclr-2026", "eccv-2024"}


def test_known_empty_conferences() -> None:
    """The 8 scaffolded conferences with no lineage yet must be false."""
    manifest = build_lineage_manifest.build(DOCS_ROOT)
    expected_empty = {
        "aaai-2026",
        "acl-2025",
        "cvpr-2025",
        "cvpr-2026",
        "emnlp-2025",
        "iccv-2025",
        "icml-2025",
        "neurips-2025",
    }
    for slug in expected_empty:
        assert manifest["conferences"][slug]["has_lineage"] is False
        assert manifest["conferences"][slug]["node_count"] == 0


def test_cli_writes_file(tmp_path: Path) -> None:
    """Running as a module should produce a parseable JSON file."""
    out = tmp_path / "lineage-manifest.json"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "paperpilot.scripts.build_lineage_manifest",
            "--output",
            str(out),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert "conferences" in data
    assert "generated_at" in data


def test_repo_manifest_is_up_to_date() -> None:
    """The committed docs/lineage-manifest.json must match the generator.

    Same pattern as test_build_sitemap.py — a --check flag fails when
    the file and the walker disagree, so drift is caught in CI.
    """
    result = subprocess.run(
        [sys.executable, "-m", "paperpilot.scripts.build_lineage_manifest", "--check"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, (
        "docs/lineage-manifest.json does not match docs/*/lineage.json. "
        "Run `uv run python -m paperpilot.scripts.build_lineage_manifest`.\n"
        f"{result.stdout}\n{result.stderr}"
    )
