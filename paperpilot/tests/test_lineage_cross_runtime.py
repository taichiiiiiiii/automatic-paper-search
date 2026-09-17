"""Independent rebound-payload checks across the Python and browser trust gates."""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from paperpilot.replay import canonical_json_bytes
from paperpilot.scripts._lineage_contract_v2 import validate_lineage_quality_v2

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "lineage-pilot" / "positive-release"

NODE_VERIFIER = r"""
const fs = require('node:fs');
globalThis.crypto = require('node:crypto').webcrypto;
require(process.argv[1]);
const core = globalThis.PaperPilotLineageV2;
(async () => {
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = [];
  for (const test of cases) {
    const index = core.parsePilotIndex(test.index);
    const entry = index && core.resolvePilotEntry(index, test.paperId);
    const release = entry && await core.verifyPilotRelease({
      entry,
      artifactBytes: new Uint8Array(Buffer.from(test.artifact, 'utf8')),
      fixtureBytes: new Uint8Array(Buffer.from(test.fixture, 'utf8')),
      qualityBytes: new Uint8Array(Buffer.from(test.quality, 'utf8')),
      catalogPaperIds: [test.paperId],
    });
    results.push(Boolean(release));
  }
  process.stdout.write(JSON.stringify(results));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _payloads() -> tuple[dict, dict, dict, dict]:
    index = json.loads((FIXTURE / "lineage-pilot-index-v1.json").read_text())
    entry = index["entries"][0]
    values = [
        json.loads((FIXTURE / entry[kind]["path"]).read_text())
        for kind in ("artifact", "fixture", "quality")
    ]
    return index, *values


def _rebind(index: dict, artifact: dict, fixture: dict, quality: dict) -> None:
    """Change outer hashes too: rejection must come from content, not stale bytes."""
    entry = index["entries"][0]
    row = quality["collections"][0]
    fixture["collections"][0]["artifact_sha256"] = _digest(artifact)
    row["artifact_sha256"] = _digest(artifact)
    row["fixture_sha256"] = _digest(fixture)
    for kind, value, folder in (
        ("artifact", artifact, "artifacts"),
        ("fixture", fixture, "fixtures"),
        ("quality", quality, "quality"),
    ):
        sha = _digest(value)
        path = f"lineage-pilots/{entry['conference']}/{entry['paper_id']}/{folder}/{sha}.json"
        entry[kind] = {"path": path, "sha256": sha}
        if kind == "artifact":
            row["path"] = path


def _mutations() -> list[tuple[str, str, tuple, object]]:
    return [
        (
            "agreed third-final citation mismatch",
            "fixture",
            ("collections", 0, "edge_labels", 0, "adjudication", "citation_valid"),
            False,
        ),
        (
            "agreed third-final support mismatch",
            "fixture",
            ("collections", 0, "edge_labels", 0, "adjudication", "evidence_support"),
            "conflicts",
        ),
        (
            "agreed third-final mismatch",
            "fixture",
            ("collections", 0, "edge_labels", 0, "adjudication", "gold_relation"),
            "successor",
        ),
        ("escaped DOI alias", "artifact", ("nodes", 0, "aliases"), [["doi", "10.1234/foo%2fbar"]]),
        ("float node count", "quality", ("collections", 0, "node_count"), 2.0),
        (
            "float candidate count",
            "artifact",
            ("meta", "candidate_universe", "candidate_count"),
            2.0,
        ),
        (
            "review beyond as-of by a microsecond",
            "fixture",
            ("collections", 0, "edge_labels", 1, "adjudication", "reviewed_at"),
            "2026-09-05T00:06:00.000001Z",
        ),
        ("zero year", "artifact", ("nodes", 1, "first_published_at"), "0000-01-01T00:00:00Z"),
        ("impossible date", "artifact", ("nodes", 1, "first_published_at"), "2026-02-30T00:00:00Z"),
        (
            "invalid UTC offset",
            "artifact",
            ("nodes", 1, "first_published_at"),
            "2026-01-01T00:00:00+24:00",
        ),
        ("broken IPv6", "artifact", ("evidence", 0, "url"), "https://["),
        (
            "broken normalized authority",
            "artifact",
            ("evidence", 0, "url"),
            "https://example\uff0f.invalid",
        ),
        (
            "unknown classification",
            "artifact",
            ("claims", 0, "classification", "method"),
            "automatic",
        ),
        ("unknown relation", "artifact", ("claims", 0, "relation"), "citation"),
        ("unaccepted claim", "artifact", ("claims", 0, "decision"), "unknown"),
        ("forged evidence endpoint", "artifact", ("evidence", 0, "cited_work_id"), "not-a-node"),
        ("missing excerpt", "artifact", ("evidence", 0, "excerpt"), ""),
        ("noncanonical alias", "artifact", ("nodes", 0, "aliases"), [["arxiv", "2501.00001v2"]]),
        ("duplicate alias", "artifact", ("nodes", 1, "aliases"), [["arxiv", "2501.00001"]]),
        ("missing focus", "artifact", ("nodes", 0, "is_focus"), False),
        ("foreign seed", "artifact", ("nodes", 0, "seed_paper_id"), "2" * 40),
        ("self claim", "artifact", ("claims", 0, "dst"), "node:synthetic-parent"),
        ("candidate count", "artifact", ("meta", "candidate_universe", "candidate_count"), 1),
        (
            "review disagreement",
            "fixture",
            ("collections", 0, "edge_labels", 0, "reviews", 0, "evidence_support"),
            "conflicts",
        ),
        (
            "same blind reviewer",
            "fixture",
            ("collections", 0, "edge_labels", 0, "reviews", 1, "reviewer_id"),
            "synthetic-human-a",
        ),
        (
            "unreviewed citation",
            "fixture",
            ("collections", 0, "edge_labels", 0, "reviews", 0, "citation_valid"),
            False,
        ),
        (
            "wrong gold relation",
            "fixture",
            ("collections", 0, "edge_labels", 0, "reviews", 0, "gold_relation"),
            "contrasts",
        ),
        ("missing candidate", "fixture", ("collections", 0, "edge_labels"), []),
        ("review counter", "quality", ("collections", 0, "review", "agreement"), 0.9),
        (
            "unsupported profile",
            "quality",
            ("collections", 0, "release_profile"),
            "automated-calibrated-v1",
        ),
        ("gate bypass", "quality", ("collections", 0, "checks"), []),
    ]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_browser_never_accepts_rebound_payload_rejected_by_python() -> None:
    baseline = _payloads()
    examples = [("positive producer bytes", copy.deepcopy(baseline))]
    for label, target, path, value in _mutations():
        example = copy.deepcopy(baseline)
        current = example[{"artifact": 1, "fixture": 2, "quality": 3}[target]]
        for part in path[:-1]:
            current = current[part]
        current[path[-1]] = value
        examples.append((label, example))

    cases = []
    python_results = []
    for _label, (index, artifact, fixture, quality) in examples:
        _rebind(index, artifact, fixture, quality)
        entry = index["entries"][0]
        collection = entry["collection_id"]
        issues = validate_lineage_quality_v2(
            quality,
            artifacts={collection: artifact},
            fixtures={collection: fixture},
            catalog_ids={collection: {entry["paper_id"]}},
        )
        python_results.append(not issues)
        cases.append(
            {
                "index": index,
                "paperId": entry["paper_id"],
                "artifact": canonical_json_bytes(artifact).decode(),
                "fixture": canonical_json_bytes(fixture).decode(),
                "quality": canonical_json_bytes(quality).decode(),
            }
        )
    result = subprocess.run(
        ["node", "-e", NODE_VERIFIER, str(ROOT / "docs" / "assets" / "lineage-v2-core.js")],
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    browser_results = json.loads(result.stdout)
    assert len(browser_results) == len(examples)
    assert python_results[0] and browser_results[0], (
        "real producer fixture must verify in both runtimes"
    )
    failures = [
        label
        for (label, _example), python_valid, browser_valid in zip(
            examples, python_results, browser_results, strict=True
        )
        if browser_valid and not python_valid
    ]
    assert failures == [], f"browser accepted Python-invalid rebound content: {failures}"
    for (label, _example), python_valid, browser_valid in zip(
        examples, python_results, browser_results, strict=True
    ):
        if label.startswith("agreed third-final"):
            assert python_valid is False and browser_valid is False, label
