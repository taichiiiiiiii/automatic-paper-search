"""Pure contract tests for lineage-artifact-v1 and deep-manifest-v1."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from paperpilot.scripts._lineage_contract import (
    canonical_focus_node,
    validate_deep_manifest,
    validate_lineage_artifact,
)

PAPER_ID = "1" * 40
OTHER_PAPER_ID = "2" * 40
SHA256 = "a" * 64


def _provenance() -> dict:
    return {
        "producer": {"name": "test-producer", "version": "1"},
        "evidence": {"source": "fixture", "kind": "citation", "sha256": SHA256},
        "classification": {
            "method": "citation_heuristic",
            "provider": None,
            "model": None,
            "prompt_version": None,
            "schema_version": "fixture-v1",
        },
    }


def _artifact() -> dict:
    return {
        "schema_version": "lineage-artifact-v1",
        "root": "focus",
        "nodes": [
            {
                "id": "focus",
                "title": "Focus",
                "is_focus": True,
                "seed_paper_id": PAPER_ID,
            },
            {"id": "related", "title": "Related", "is_focus": False},
        ],
        "edges": [
            {
                "src": "focus",
                "dst": "related",
                "rel": "extends",
                "relation": "extends",
                "conf": 0.8,
                "confidence": 0.8,
                "rationale": "Specific evidence",
                "provenance": _provenance(),
            }
        ],
        "clusters": [],
        "meta": {
            "kind": "conference",
            "generator": "test-producer",
            "generated_at": "2026-08-30T00:00:00Z",
        },
    }


def _codes(issues) -> set[str]:
    return {issue.code for issue in issues}


def test_valid_conference_artifact_passes() -> None:
    assert validate_lineage_artifact(_artifact(), kind="conference", catalog_ids={PAPER_ID}) == []


def test_valid_theme_and_empty_theme_artifacts_pass() -> None:
    artifact = _artifact()
    artifact["meta"]["kind"] = "theme"
    assert validate_lineage_artifact(artifact, kind="theme") == []

    empty = {
        "schema_version": "lineage-artifact-v1",
        "root": None,
        "nodes": [],
        "edges": [],
        "clusters": [],
        "meta": {
            "kind": "theme",
            "generator": "test-producer",
            "generated_at": "2026-08-30T00:00:00Z",
        },
    }
    assert validate_lineage_artifact(empty, kind="theme") == []


def test_theme_focus_seed_is_required_and_unique_without_catalog_membership() -> None:
    artifact = _artifact()
    artifact["meta"]["kind"] = "theme"
    artifact["nodes"][0].pop("seed_paper_id")
    assert "focus_seed" in _codes(validate_lineage_artifact(artifact, kind="theme"))

    artifact = _artifact()
    artifact["meta"]["kind"] = "theme"
    artifact["nodes"].append({"id": "second-focus", "is_focus": True, "seed_paper_id": PAPER_ID})
    issues = validate_lineage_artifact(
        artifact,
        kind="theme",
        catalog_ids=set(),
    )
    assert "focus_seed_duplicate" in _codes(issues)
    assert "catalog_seed_membership" not in _codes(issues)


def test_missing_schema_and_legacy_provenance_fail() -> None:
    artifact = _artifact()
    artifact.pop("schema_version")
    artifact["edges"][0]["provenance"] = "llm"
    assert {"artifact_schema_version", "provenance_shape"} <= _codes(
        validate_lineage_artifact(artifact, kind="conference")
    )


def test_root_must_resolve_to_unique_focus_without_first_node_fallback() -> None:
    artifact = _artifact()
    artifact["root"] = "related"
    assert canonical_focus_node(artifact) is None
    assert "root_focus" in _codes(validate_lineage_artifact(artifact, kind="conference"))

    artifact = _artifact()
    artifact["nodes"].append(deepcopy(artifact["nodes"][0]))
    assert canonical_focus_node(artifact) is None
    assert {"node_id_duplicate", "root_resolution", "root_focus"} <= _codes(
        validate_lineage_artifact(artifact, kind="conference")
    )


def test_root_and_wire_order_are_deterministic() -> None:
    artifact = _artifact()
    artifact["nodes"].append(
        {
            "id": "z-focus",
            "title": "Other focus",
            "is_focus": True,
            "seed_paper_id": OTHER_PAPER_ID,
        }
    )
    artifact["root"] = "z-focus"
    assert "root_deterministic" in _codes(
        validate_lineage_artifact(
            artifact,
            kind="conference",
            catalog_ids={PAPER_ID, OTHER_PAPER_ID},
        )
    )

    artifact = _artifact()
    artifact["nodes"].reverse()
    assert "node_order" in _codes(validate_lineage_artifact(artifact, kind="conference"))

    artifact = _artifact()
    artifact["edges"].append(
        {
            "src": "related",
            "dst": "focus",
            "rel": "contrasts",
            "relation": "contrasts",
            "conf": 0.7,
            "confidence": 0.7,
            "rationale": "Specific reverse evidence",
            "provenance": _provenance(),
        }
    )
    artifact["edges"].reverse()
    assert "edge_order" in _codes(validate_lineage_artifact(artifact, kind="conference"))


def test_focus_seed_must_be_unique_and_belong_to_catalog() -> None:
    artifact = _artifact()
    artifact["nodes"][0]["seed_paper_id"] = OTHER_PAPER_ID
    assert "catalog_seed_membership" in _codes(
        validate_lineage_artifact(artifact, kind="conference", catalog_ids={PAPER_ID})
    )

    artifact = _artifact()
    artifact["nodes"].append({"id": "second-focus", "is_focus": True, "seed_paper_id": PAPER_ID})
    assert "focus_seed_duplicate" in _codes(
        validate_lineage_artifact(artifact, kind="conference", catalog_ids={PAPER_ID})
    )


def test_edge_aliases_endpoints_and_llm_identity_are_strict() -> None:
    artifact = _artifact()
    edge = artifact["edges"][0]
    edge["dst"] = "missing"
    edge["rel"] = "contrasts"
    edge["conf"] = 0.2
    edge["provenance"]["classification"] = {
        "method": "llm",
        "provider": None,
        "model": None,
        "prompt_version": None,
        "schema_version": "fixture-v1",
    }
    assert {
        "edge_endpoint",
        "edge_relation_alias",
        "edge_confidence_alias",
        "llm_identity",
    } <= _codes(validate_lineage_artifact(artifact, kind="conference"))


def test_provenance_is_closed_and_requires_complete_identity_keys() -> None:
    artifact = _artifact()
    artifact["edges"][0]["provenance"]["unexpected"] = "not allowed"
    artifact["edges"][0]["provenance"]["producer"]["unexpected"] = "not allowed"
    artifact["edges"][0]["provenance"]["evidence"]["unexpected"] = "not allowed"
    artifact["edges"][0]["provenance"]["classification"].pop("provider")
    assert {
        "provenance_fields",
        "provenance_producer_fields",
        "provenance_evidence_fields",
        "provenance_classification_fields",
    } <= _codes(validate_lineage_artifact(artifact, kind="conference"))


def test_json_schema_requires_llm_identity() -> None:
    schema_path = (
        Path(__file__).resolve().parents[2] / "schemas" / "lineage-artifact-v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    classification = schema["$defs"]["provenance"]["properties"]["classification"]
    llm_rule = classification["allOf"][0]
    assert llm_rule["if"]["properties"]["method"] == {"const": "llm"}
    assert set(llm_rule["then"]["properties"]) == {"provider", "model", "prompt_version"}


def test_theme_focus_seed_python_and_json_schema_are_in_parity() -> None:
    schema_path = (
        Path(__file__).resolve().parents[2] / "schemas" / "lineage-artifact-v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    node_schema = schema["properties"]["nodes"]["items"]
    focus_rule = node_schema["allOf"][0]
    assert focus_rule["if"] == {
        "properties": {"is_focus": {"const": True}},
        "required": ["is_focus"],
    }
    assert focus_rule["then"] == {"required": ["seed_paper_id"]}
    seed_pattern = node_schema["properties"]["seed_paper_id"]["pattern"]

    valid = _artifact()
    valid["meta"]["kind"] = "theme"
    assert validate_lineage_artifact(valid, kind="theme") == []
    assert re.fullmatch(seed_pattern, valid["nodes"][0]["seed_paper_id"])

    for invalid_seed in (None, "A" * 40):
        invalid = deepcopy(valid)
        if invalid_seed is None:
            invalid["nodes"][0].pop("seed_paper_id")
        else:
            invalid["nodes"][0]["seed_paper_id"] = invalid_seed
        assert "focus_seed" in _codes(validate_lineage_artifact(invalid, kind="theme"))
        assert invalid_seed is None or re.fullmatch(seed_pattern, invalid_seed) is None


def test_theme_meta_and_empty_clusters_python_schema_parity() -> None:
    schema_path = (
        Path(__file__).resolve().parents[2] / "schemas" / "lineage-artifact-v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    valid = _artifact()
    valid["meta"]["kind"] = "theme"
    assert validate_lineage_artifact(valid, kind="theme") == []
    assert list(validator.iter_errors(valid)) == []

    mutations: list[tuple[dict, str, bool]] = []
    wrong_kind = deepcopy(valid)
    wrong_kind["meta"]["kind"] = "conference"
    # The shared schema uses meta.kind as its discriminator; only the Python
    # validator receives the caller's expected kind and can reject this lie.
    mutations.append((wrong_kind, "theme_meta_kind", False))
    no_generator = deepcopy(valid)
    no_generator["meta"].pop("generator")
    mutations.append((no_generator, "theme_meta_generator", True))
    blank_generator = deepcopy(valid)
    blank_generator["meta"]["generator"] = "   "
    mutations.append((blank_generator, "theme_meta_generator", True))
    bad_time = deepcopy(valid)
    bad_time["meta"]["generated_at"] = "2026-08-30"
    mutations.append((bad_time, "theme_meta_generated_at", True))
    impossible_time = deepcopy(valid)
    impossible_time["meta"]["generated_at"] = "2026-02-30T00:00:00Z"
    # RFC3339 format validation in the standard jsonschema FormatChecker does
    # not reject every impossible calendar date; Python/JS runtime validators do.
    mutations.append((impossible_time, "theme_meta_generated_at", False))
    clusters = deepcopy(valid)
    clusters["clusters"] = [{"id": "legacy"}]
    mutations.append((clusters, "theme_clusters", True))

    for artifact, issue_code, schema_rejects in mutations:
        assert issue_code in _codes(validate_lineage_artifact(artifact, kind="theme"))
        assert bool(list(validator.iter_errors(artifact))) is schema_rejects


def test_node_aliases_are_normalized_unique_and_theme_strong_only() -> None:
    schema_path = (
        Path(__file__).resolve().parents[2] / "schemas" / "lineage-artifact-v1.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    valid = _artifact()
    valid["meta"]["kind"] = "theme"
    valid["nodes"][0]["aliases"] = [
        ["arxiv", "2601.00001"],
        ["doi", "10.1234/example.paper"],
    ]
    assert validate_lineage_artifact(valid, kind="theme") == []
    assert list(validator.iter_errors(valid)) == []

    for alias in (
        ["legacy", "value"],
        ["arxiv", "2601.00001v2"],
        ["doi", "10.1234/EXAMPLE.PAPER"],
        ["openreview", "contains/slash"],
    ):
        invalid = deepcopy(valid)
        invalid["nodes"][0]["aliases"] = [alias]
        assert "node_alias_normalized" in _codes(validate_lineage_artifact(invalid, kind="theme"))
        assert list(validator.iter_errors(invalid))

    semantic = deepcopy(valid)
    semantic["nodes"][0]["aliases"] = [["semantic_scholar", "S2-root"]]
    assert "node_alias_normalized" in _codes(validate_lineage_artifact(semantic, kind="theme"))
    # The shared schema permits this migration-only namespace because JSON
    # Schema cannot branch node items on the enclosing meta.kind. Runtime
    # Python/JS validators reject it specifically for themes.
    assert list(validator.iter_errors(semantic)) == []

    conference = deepcopy(semantic)
    conference["meta"]["kind"] = "conference"
    assert validate_lineage_artifact(conference, kind="conference") == []

    duplicate = deepcopy(valid)
    duplicate["nodes"][1]["aliases"] = [["arxiv", "2601.00001"]]
    assert "node_alias_ambiguous" in _codes(validate_lineage_artifact(duplicate, kind="theme"))

    duplicate_in_node = deepcopy(valid)
    duplicate_in_node["nodes"][0]["aliases"] = [
        ["arxiv", "2601.00001"],
        ["arxiv", "2601.00001"],
    ]
    assert "node_alias_duplicate" in _codes(
        validate_lineage_artifact(duplicate_in_node, kind="theme")
    )
    assert list(validator.iter_errors(duplicate_in_node))


def _manifest() -> dict:
    return {
        "schema_version": "deep-manifest-v1",
        "conference": "test-2026",
        "generated_at": "2026-08-30T00:00:00Z",
        "entries": [
            {
                "paper_id": PAPER_ID,
                "aliases": [["arxiv", "2602.18473"], ["semantic_scholar", "S2-root"]],
                "arxiv_id": "2602.18473",
                "title": "Focus",
                "filename": "deep-2602.18473.json",
            }
        ],
    }


def test_valid_deep_manifest_passes() -> None:
    assert validate_deep_manifest(_manifest(), catalog_ids={PAPER_ID}) == []


def test_deep_manifest_rejects_legacy_array_and_ambiguous_aliases() -> None:
    assert _codes(validate_deep_manifest([])) == {"manifest_shape"}

    manifest = _manifest()
    duplicate = deepcopy(manifest["entries"][0])
    duplicate["paper_id"] = OTHER_PAPER_ID
    duplicate["arxiv_id"] = "2401.12345"
    duplicate["filename"] = "deep-2401.12345.json"
    duplicate["aliases"][0][1] = "2401.12345"
    manifest["entries"].append(duplicate)
    assert "manifest_alias_duplicate" in _codes(validate_deep_manifest(manifest))


def test_deep_manifest_is_closed_and_validates_slug_and_timestamp() -> None:
    manifest = _manifest()
    manifest["unexpected"] = True
    manifest["entries"][0]["unexpected"] = True
    manifest["conference"] = "../test"
    manifest["generated_at"] = "2026-08-30"
    assert {
        "manifest_fields",
        "manifest_entry_fields",
        "manifest_conference",
        "manifest_generated_at",
    } <= _codes(validate_deep_manifest(manifest))
