"""Tests for the fail-closed conference/theme lineage quality read model."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from paperpilot.scripts import build_lineage_quality as blq

PAPER_ID = "1" * 40
OTHER_PAPER_ID = "2" * 40
ROOT = Path(__file__).resolve().parents[2]


def _write_json(path: Path, value: object) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(payload)
    return payload


def _catalog_index(docs: Path, slug: str = "test-2026") -> None:
    _write_json(
        docs / "conferences.json",
        [{"name": slug, "papers": 1, "generated": "2026-08-01"}],
    )
    _write_json(docs / "themes" / "themes-manifest.json", [])
    _write_json(
        docs / slug / "papers.json",
        [
            {
                "paper_id": PAPER_ID,
                "arxiv_id": "2602.18473",
                "source": "arxiv",
                "source_id": "2602.18473",
            }
        ],
    )


def _theme_index(docs: Path, slug: str = "test-theme") -> None:
    _write_json(docs / "conferences.json", [])
    _write_json(
        docs / "themes" / "themes-manifest.json",
        [
            {
                "slug": slug,
                "theme": "Test Theme",
                "generated_at": "2026-08-20T00:00:00Z",
            }
        ],
    )


def _provenance() -> dict:
    return {
        "producer": {"name": "fixture", "version": "1"},
        "evidence": {"source": "fixture", "kind": "citation", "sha256": "a" * 64},
        "classification": {
            "method": "citation_heuristic",
            "provider": None,
            "model": None,
            "prompt_version": None,
            "schema_version": "fixture-v1",
        },
    }


def _v1_lineage(*, seed_paper_id: str = PAPER_ID) -> dict:
    return {
        "schema_version": "lineage-artifact-v1",
        "root": "a",
        "meta": {"kind": "conference", "generated_at": "2026-08-20T00:00:00Z"},
        "clusters": [],
        "nodes": [
            {"id": "a", "is_focus": True, "seed_paper_id": seed_paper_id},
            {"id": "b", "is_focus": False},
        ],
        "edges": [
            {
                "src": "a",
                "dst": "b",
                "rel": "extends",
                "relation": "extends",
                "conf": 0.8,
                "confidence": 0.8,
                "rationale": "specific evidence",
                "provenance": _provenance(),
            }
        ],
    }


def _theme_lineage(*, seed_paper_id: str = PAPER_ID) -> dict:
    data = _v1_lineage(seed_paper_id=seed_paper_id)
    data["meta"]["kind"] = "theme"
    data["meta"]["generator"] = "paperpilot.scripts.build_theme_lineage"
    return data


def _deep_lineage(*, seed_paper_id: str = PAPER_ID) -> dict:
    data = _v1_lineage(seed_paper_id=seed_paper_id)
    aliases = [["arxiv", "2602.18473"], ["semantic_scholar", "a"]]
    data["meta"] = {
        "kind": "deep",
        "conference": "test-2026",
        "arxiv_id": "2602.18473",
        "seed_paper_id": seed_paper_id,
        "aliases": aliases,
        "generated_at": "2026-08-20T00:00:00Z",
    }
    data["nodes"][0]["title"] = "Root"
    data["nodes"][0]["aliases"] = aliases
    return data


def _deep_manifest(*, seed_paper_id: str = PAPER_ID) -> dict:
    return {
        "schema_version": "deep-manifest-v1",
        "conference": "test-2026",
        "generated_at": "2026-08-20T00:00:00Z",
        "entries": [
            {
                "paper_id": seed_paper_id,
                "aliases": [["arxiv", "2602.18473"], ["semantic_scholar", "a"]],
                "arxiv_id": "2602.18473",
                "title": "Root",
                "filename": "deep-2602.18473.json",
            }
        ],
    }


def test_empty_lineage_is_unavailable_unknown(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(docs / "test-2026" / "lineage.json", {"nodes": [], "edges": []})
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    assert (row["availability"], row["audit_status"]) == ("unavailable", "unknown")


def test_ready_lineage_without_edge_provenance_fails(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(
        docs / "test-2026" / "lineage.json",
        {
            "root": "a",
            "nodes": [
                {"id": "a", "is_focus": True, "seed_paper_id": "1" * 40},
                {"id": "b"},
            ],
            "edges": [{"src": "a", "dst": "b", "rel": "extends", "conf": 0.8, "rationale": "why"}],
        },
    )
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    assert row["availability"] == "ready"
    assert row["audit_status"] == "failed"
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["edge_semantics_complete"]["status"] == "failed"


def test_valid_structure_without_frozen_fixture_stays_unknown(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(docs / "test-2026" / "lineage.json", _v1_lineage())
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    assert row["audit_status"] == "unknown"
    assert row["freshness"] == "fresh"


def test_matching_frozen_fixture_allows_passed(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    lineage = _v1_lineage()
    payload = _write_json(docs / "test-2026" / "lineage.json", lineage)
    input_hash = hashlib.sha256(payload).hexdigest()
    fixtures = {
        "collections": [
            {
                "collection_id": "conference:test-2026",
                "input_sha256": input_hash,
                "reviewer": "test-reviewer",
                "reviewed_at": "2026-08-29T00:00:00Z",
                "focus_labels": [{"node_id": "a", "on_topic": True}],
                "sample_labels": [{"node_id": "b", "on_topic": True}],
            }
        ]
    }
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures=fixtures,
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    assert manifest["collections"][0]["audit_status"] == "passed"


def test_catalog_seed_membership_mismatch_fails(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(
        docs / "test-2026" / "lineage.json",
        _v1_lineage(seed_paper_id=OTHER_PAPER_ID),
    )
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    checks = {check["name"]: check for check in manifest["collections"][0]["audit"]["checks"]}
    assert checks["catalog_seed_membership"]["status"] == "failed"
    assert manifest["collections"][0]["audit_status"] == "failed"


def test_legacy_artifact_fails_v1_contract_even_with_fixture(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    legacy = _v1_lineage()
    legacy.pop("schema_version")
    payload = _write_json(docs / "test-2026" / "lineage.json", legacy)
    fixtures = {
        "collections": [
            {
                "collection_id": "conference:test-2026",
                "input_sha256": hashlib.sha256(payload).hexdigest(),
                "reviewer": "test-reviewer",
                "reviewed_at": "2026-08-29T00:00:00Z",
                "focus_labels": [{"node_id": "a", "on_topic": True}],
                "sample_labels": [{"node_id": "b", "on_topic": True}],
            }
        ]
    }
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures=fixtures,
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["artifact_contract_v1"]["status"] == "failed"
    assert row["audit_status"] == "failed"


def test_legacy_theme_without_seed_fails_seed_audit(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _theme_index(docs)
    legacy = _theme_lineage()
    legacy.pop("schema_version")
    legacy["nodes"][0].pop("seed_paper_id")
    _write_json(docs / "themes" / "test-theme" / "lineage.json", legacy)

    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert row["collection_id"] == "theme:test-theme"
    assert checks["artifact_contract_v1"]["status"] == "failed"
    assert checks["catalog_seed_ids"]["status"] == "failed"
    assert checks["catalog_seed_membership"]["status"] == "passed"
    assert row["audit_status"] == "failed"


def test_valid_v1_theme_can_pass_without_catalog_membership(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _theme_index(docs)
    payload = _write_json(
        docs / "themes" / "test-theme" / "lineage.json",
        _theme_lineage(seed_paper_id=OTHER_PAPER_ID),
    )
    fixtures = {
        "collections": [
            {
                "collection_id": "theme:test-theme",
                "input_sha256": hashlib.sha256(payload).hexdigest(),
                "reviewer": "test-reviewer",
                "reviewed_at": "2026-08-29T00:00:00Z",
                "focus_labels": [{"node_id": "a", "on_topic": True}],
                "sample_labels": [{"node_id": "b", "on_topic": True}],
            }
        ]
    }
    manifest = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures=fixtures,
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = manifest["collections"][0]
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["artifact_contract_v1"]["status"] == "passed"
    assert checks["catalog_seed_ids"]["status"] == "passed"
    assert checks["catalog_seed_membership"]["status"] == "passed"
    assert (row["availability"], row["audit_status"]) == ("ready", "passed")

    schema = json.loads(
        (ROOT / "schemas" / "lineage-quality-v1.schema.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    assert list(validator.iter_errors(manifest)) == []

    mutations = []
    legacy_schema = deepcopy(manifest)
    legacy_schema["collections"][0]["artifact_schema_version"] = "legacy"
    mutations.append(legacy_schema)
    missing_hash = deepcopy(manifest)
    missing_hash["collections"][0]["input_sha256"] = None
    mutations.append(missing_hash)
    missing_fixture = deepcopy(manifest)
    missing_fixture["collections"][0]["audit"]["fixture_sha256"] = None
    mutations.append(missing_fixture)
    failed_check = deepcopy(manifest)
    failed_check["collections"][0]["audit"]["checks"][0]["status"] = "failed"
    mutations.append(failed_check)
    missing_contract_check = deepcopy(manifest)
    missing_contract_check["collections"][0]["audit"]["checks"] = [
        check
        for check in missing_contract_check["collections"][0]["audit"]["checks"]
        if check["name"] != "artifact_contract_v1"
    ]
    mutations.append(missing_contract_check)
    for invalid in mutations:
        assert list(validator.iter_errors(invalid))


def test_theme_meta_contract_fails_even_with_matching_fixture(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _theme_index(docs)
    cases: list[dict] = []
    wrong_kind = _theme_lineage()
    wrong_kind["meta"]["kind"] = "conference"
    cases.append(wrong_kind)
    no_generator = _theme_lineage()
    no_generator["meta"].pop("generator")
    cases.append(no_generator)
    blank_generator = _theme_lineage()
    blank_generator["meta"]["generator"] = "   "
    cases.append(blank_generator)
    no_timestamp = _theme_lineage()
    no_timestamp["meta"].pop("generated_at")
    cases.append(no_timestamp)
    legacy_clusters = _theme_lineage()
    legacy_clusters["clusters"] = [{"id": "legacy"}]
    cases.append(legacy_clusters)

    for lineage in cases:
        payload = _write_json(docs / "themes" / "test-theme" / "lineage.json", lineage)
        fixtures = {
            "collections": [
                {
                    "collection_id": "theme:test-theme",
                    "input_sha256": hashlib.sha256(payload).hexdigest(),
                    "reviewer": "test-reviewer",
                    "reviewed_at": "2026-08-29T00:00:00Z",
                    "focus_labels": [{"node_id": "a", "on_topic": True}],
                    "sample_labels": [{"node_id": "b", "on_topic": True}],
                }
            ]
        }
        manifest = blq.build_manifest(
            docs_root=docs,
            as_of="2026-08-30T00:00:00Z",
            fixtures=fixtures,
            policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
        )
        row = manifest["collections"][0]
        checks = {check["name"]: check for check in row["audit"]["checks"]}
        assert checks["golden_fixture"]["status"] == "passed"
        assert checks["artifact_contract_v1"]["status"] == "failed"
        assert row["audit_status"] == "failed"


def test_matching_deep_manifest_and_artifact_are_audited_as_a_collection(
    tmp_path: Path,
) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    manifest_payload = _write_json(docs / "test-2026" / "deep-manifest.json", _deep_manifest())
    artifact_payload = _write_json(docs / "test-2026" / "deep-2602.18473.json", _deep_lineage())
    fixtures = {
        "collections": [
            {
                "collection_id": f"deep:test-2026:{PAPER_ID}",
                "input_sha256": hashlib.sha256(artifact_payload).hexdigest(),
                "reviewer": "test-reviewer",
                "reviewed_at": "2026-08-29T00:00:00Z",
                "focus_labels": [{"node_id": "a", "on_topic": True}],
                "sample_labels": [{"node_id": "b", "on_topic": True}],
            }
        ]
    }
    quality = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures=fixtures,
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = next(item for item in quality["collections"] if item["kind"] == "deep")
    assert row["collection_id"] == f"deep:test-2026:{PAPER_ID}"
    assert row["path"] == "test-2026/deep-2602.18473.json"
    assert row["paper_id"] == PAPER_ID
    assert row["manifest_input_sha256"] == hashlib.sha256(manifest_payload).hexdigest()
    assert (row["availability"], row["audit_status"]) == ("ready", "passed")
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["deep_manifest_contract"]["status"] == "passed"
    assert checks["deep_manifest_identity"]["status"] == "passed"


def test_deep_seed_mismatch_fails_manifest_identity(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(docs / "test-2026" / "deep-manifest.json", _deep_manifest())
    _write_json(
        docs / "test-2026" / "deep-2602.18473.json",
        _deep_lineage(seed_paper_id=OTHER_PAPER_ID),
    )
    quality = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = next(item for item in quality["collections"] if item["kind"] == "deep")
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["deep_manifest_identity"]["status"] == "failed"
    assert row["audit_status"] == "failed"


def test_deep_catalog_requires_same_row_paper_and_arxiv_pair(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(
        docs / "test-2026" / "papers.json",
        [
            {
                "paper_id": PAPER_ID,
                "arxiv_id": "2602.99999",
                "source": "arxiv",
                "source_id": "2602.99999",
            }
        ],
    )
    _write_json(docs / "test-2026" / "deep-manifest.json", _deep_manifest())
    _write_json(docs / "test-2026" / "deep-2602.18473.json", _deep_lineage())
    quality = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = next(item for item in quality["collections"] if item["kind"] == "deep")
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["deep_manifest_identity"]["status"] == "failed"
    assert "catalog-paper-arxiv-pair" in checks["deep_manifest_identity"]["evidence"]


def test_unlisted_deep_artifact_is_explicitly_failed(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    empty_manifest = _deep_manifest()
    empty_manifest["entries"] = []
    _write_json(docs / "test-2026" / "deep-manifest.json", empty_manifest)
    _write_json(docs / "test-2026" / "deep-2602.18473.json", _deep_lineage())
    quality = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = next(item for item in quality["collections"] if item["kind"] == "deep")
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["deep_manifest_identity"]["status"] == "failed"
    assert row["audit_status"] == "failed"


def test_missing_deep_artifact_referenced_by_manifest_is_failed(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _catalog_index(docs)
    _write_json(docs / "test-2026" / "deep-manifest.json", _deep_manifest())
    quality = blq.build_manifest(
        docs_root=docs,
        as_of="2026-08-30T00:00:00Z",
        fixtures={"collections": []},
        policy={"conference_max_age_days": 120, "theme_max_age_days": 120},
    )
    row = next(item for item in quality["collections"] if item["kind"] == "deep")
    assert row["availability"] == "unavailable"
    assert row["audit_status"] == "failed"
    checks = {check["name"]: check for check in row["audit"]["checks"]}
    assert checks["deep_manifest_identity"]["status"] == "failed"


def test_quality_json_schema_closes_deep_fields_by_kind() -> None:
    schema = json.loads(
        (ROOT / "schemas" / "lineage-quality-v1.schema.json").read_text(encoding="utf-8")
    )
    collection = schema["$defs"]["collection"]
    assert collection["additionalProperties"] is False
    assert set(collection["properties"]["kind"]["enum"]) == {
        "conference",
        "theme",
        "deep",
    }
    deep_rule = collection["allOf"][0]
    assert deep_rule["if"]["properties"]["kind"] == {"const": "deep"}
    deep_fields = {
        "conference",
        "paper_id",
        "arxiv_id",
        "manifest_path",
        "manifest_input_sha256",
    }
    assert deep_fields <= set(deep_rule["then"]["required"])
    forbidden_outside_deep = {
        next(iter(rule["required"])) for rule in deep_rule["else"]["not"]["anyOf"]
    }
    assert forbidden_outside_deep == deep_fields
    passed_rule = deep_rule["then"]["allOf"][0]
    assert passed_rule["if"]["properties"] == {
        "availability": {"const": "ready"},
        "audit_status": {"const": "passed"},
    }
    assert {
        "paper_id",
        "arxiv_id",
        "input_sha256",
        "manifest_input_sha256",
    } <= set(passed_rule["then"]["properties"])
