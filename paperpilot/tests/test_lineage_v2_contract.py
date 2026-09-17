"""Focused acceptance tests for the isolated lineage v2 wire contracts."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from paperpilot.scripts._lineage_contract_v2 import (
    build_lineage_quality_v2,
    canonical_json_sha256,
    validate_lineage_artifact_v2,
    validate_lineage_audit_fixtures_v2,
    validate_lineage_quality_v2,
)

ROOT = Path(__file__).resolve().parents[2]
PAPER_ID = "1" * 40


def _evidence(
    excerpt: str = "Synthetic child explicitly extends the synthetic parent mechanism.",
) -> dict:
    return {
        "id": "evidence:synthetic-primary",
        "source": "synthetic-primary",
        "kind": "paper-text",
        "source_work_id": "synthetic-child",
        "cited_work_id": "node:synthetic-parent",
        "citing_work_id": "node:synthetic-child",
        "url": "https://example.invalid/synthetic-child",
        "locator": {
            "page": 2,
            "section": "Method",
            "reference_marker": "[1]",
            "sentence_ordinal": 1,
            "paragraph_ordinal": 1,
        },
        "excerpt": excerpt,
        "excerpt_sha256": hashlib.sha256(excerpt.encode()).hexdigest(),
        "input_sha256": "b" * 64,
        "retrieved_at": "2026-09-05T00:00:00Z",
        "snapshot_ref": "fixture://synthetic/source-v1",
    }


def _artifact(*, decision: str = "accepted", trust: str = "verified") -> dict:
    evidence = _evidence()
    evidence_hash = canonical_json_sha256([evidence])
    relation = "extends" if decision in {"accepted", "rejected"} else None
    return {
        "schema_version": "lineage-artifact-v2",
        "release_id": "synthetic-release-v1",
        "root": "node:synthetic-parent",
        "nodes": [
            {
                "id": "node:synthetic-parent",
                "title": "Synthetic Parent",
                "first_published_at": "2025-01-01T00:00:00Z",
                "is_focus": True,
                "seed_paper_id": PAPER_ID,
                "aliases": [["arxiv", "2501.00001"]],
            },
            {
                "id": "node:synthetic-child",
                "title": "Synthetic Child",
                "first_published_at": "2026-01-01T00:00:00Z",
                "is_focus": False,
                "seed_paper_id": None,
                "aliases": [["arxiv", "2601.00001"]],
            },
        ],
        "links": [
            {
                "id": "link:synthetic-citation",
                "src": "node:synthetic-child",
                "dst": "node:synthetic-parent",
                "type": "citation",
                "evidence_ids": [evidence["id"]],
            }
        ],
        "evidence": [evidence],
        "claims": [
            {
                "id": "claim:synthetic-lineage",
                "src": "node:synthetic-parent",
                "dst": "node:synthetic-child",
                "claim_family": "genealogy",
                "relation": relation,
                "decision": decision,
                "trust_tier": trust,
                "raw_score": None,
                "calibrated_probability": None,
                "calibration_id": None,
                "evidence_ids": [evidence["id"]],
                "rationale": "Synthetic, explicit extension statement."
                if decision in {"accepted", "rejected"}
                else "",
                "classification": {
                    "method": "human_review",
                    "provider": None,
                    "model": None,
                    "prompt_version": None,
                    "schema_version": "synthetic-v1",
                },
                "reason_codes": []
                if decision in {"accepted", "rejected"}
                else ["insufficient_evidence"],
                "review_binding": {
                    "review_id": "synthetic-review-1",
                    "fixture_id": "synthetic-pilot-fixture-v1",
                    "evidence_sha256": evidence_hash,
                }
                if trust == "verified" and decision == "accepted"
                else None,
            },
            {
                "id": "claim:synthetic-unknown",
                "src": "node:synthetic-child",
                "dst": "node:synthetic-parent",
                "claim_family": "genealogy",
                "relation": None,
                "decision": "unknown",
                "trust_tier": "tentative",
                "raw_score": None,
                "calibrated_probability": None,
                "calibration_id": None,
                "evidence_ids": [evidence["id"]],
                "rationale": "",
                "classification": {
                    "method": "human_review",
                    "provider": None,
                    "model": None,
                    "prompt_version": None,
                    "schema_version": "synthetic-v1",
                },
                "reason_codes": ["insufficient_evidence"],
                "review_binding": None,
            },
        ],
        "clusters": [],
        "meta": {
            "kind": "theme",
            "producer": {"name": "synthetic-fixture", "version": "1"},
            "generated_at": "2026-09-05T00:00:00Z",
            "candidate_universe": {
                "snapshot_ref": "fixture://synthetic/candidates-v1",
                "input_sha256": "c" * 64,
                "selection_method": "synthetic-exhaustive-v1",
                "candidate_count": 2,
            },
        },
    }


def _fixture(artifact: dict) -> dict:
    evidence_hash = canonical_json_sha256(artifact["evidence"])
    return {
        "schema_version": "lineage-audit-fixtures-v2",
        "fixture_id": "synthetic-pilot-fixture-v1",
        "created_at": "2026-09-05T00:00:00Z",
        "collections": [
            {
                "collection_id": "theme:synthetic-pilot",
                "release_id": artifact["release_id"],
                "artifact_sha256": canonical_json_sha256(artifact),
                "candidate_universe": deepcopy(artifact["meta"]["candidate_universe"]),
                "focus_labels": [{"node_id": artifact["root"], "on_topic": True}],
                "edge_labels": [
                    {
                        "review_id": "synthetic-review-1",
                        "collection_id": "theme:synthetic-pilot",
                        "src": "node:synthetic-parent",
                        "dst": "node:synthetic-child",
                        "evidence_sha256": evidence_hash,
                        "reviews": [
                            {
                                "reviewer_id": "synthetic-human-a",
                                "blind_to_model": True,
                                "blind_to_peer": True,
                                "citation_valid": True,
                                "gold_family": "genealogy",
                                "gold_relation": "extends",
                                "evidence_support": "supports",
                                "notes": "Synthetic only",
                                "reviewed_at": "2026-09-05T00:00:00Z",
                            },
                            {
                                "reviewer_id": "synthetic-human-b",
                                "blind_to_model": True,
                                "blind_to_peer": True,
                                "citation_valid": True,
                                "gold_family": "genealogy",
                                "gold_relation": "extends",
                                "evidence_support": "supports",
                                "notes": "Synthetic only",
                                "reviewed_at": "2026-09-05T00:01:00Z",
                            },
                        ],
                        "adjudication": {
                            "adjudicator_id": "synthetic-human-c",
                            "citation_valid": True,
                            "gold_family": "genealogy",
                            "gold_relation": "extends",
                            "evidence_support": "supports",
                            "notes": "Synthetic only",
                            "reviewed_at": "2026-09-05T00:02:00Z",
                        },
                    },
                    {
                        "review_id": "synthetic-review-2",
                        "collection_id": "theme:synthetic-pilot",
                        "src": "node:synthetic-child",
                        "dst": "node:synthetic-parent",
                        "evidence_sha256": evidence_hash,
                        "reviews": [
                            {
                                "reviewer_id": "synthetic-human-a",
                                "blind_to_model": True,
                                "blind_to_peer": True,
                                "citation_valid": True,
                                "gold_family": None,
                                "gold_relation": None,
                                "evidence_support": "insufficient",
                                "notes": "Synthetic only",
                                "reviewed_at": "2026-09-05T00:03:00Z",
                            },
                            {
                                "reviewer_id": "synthetic-human-b",
                                "blind_to_model": True,
                                "blind_to_peer": True,
                                "citation_valid": True,
                                "gold_family": None,
                                "gold_relation": None,
                                "evidence_support": "insufficient",
                                "notes": "Synthetic only",
                                "reviewed_at": "2026-09-05T00:04:00Z",
                            },
                        ],
                        "adjudication": {
                            "adjudicator_id": "synthetic-human-c",
                            "citation_valid": True,
                            "gold_family": None,
                            "gold_relation": None,
                            "evidence_support": "insufficient",
                            "notes": "Synthetic only",
                            "reviewed_at": "2026-09-05T00:05:00Z",
                        },
                    },
                ],
            }
        ],
    }


def _quality(artifact: dict, fixture: dict, profile: str = "claim-verified-pilot-v1") -> dict:
    calibration = {
        "status": "not_applicable",
        "reason": "Synthetic claim-verified pilot does not claim collection calibration.",
        "sample_count": 0,
        "wilson_lower_bound": None,
        "supersedes_wilson_lower_bound": None,
        "macro_precision": None,
        "ece": None,
        "brier": None,
        "accepted_coverage": None,
        "unknown_abstained_recall": None,
    }
    if profile == "automated-calibrated-v1":
        calibration = {
            "status": "passed",
            "reason": "Frozen synthetic metrics",
            "sample_count": 300,
            "wilson_lower_bound": 0.8,
            "supersedes_wilson_lower_bound": 0.9,
            "macro_precision": 0.8,
            "ece": 0.1,
            "brier": 0.15,
            "accepted_coverage": 0.2,
            "unknown_abstained_recall": 0.9,
        }
    return {
        "schema_version": "lineage-quality-v2",
        "audit_version": "audit-v2",
        "as_of": "2026-09-05T00:06:00Z",
        "collections": [
            {
                "collection_id": "theme:synthetic-pilot",
                "kind": "theme",
                "slug": "synthetic-pilot",
                "label": "Synthetic Pilot",
                "path": "staging/synthetic-pilot/lineage-v2.json",
                "release_id": artifact["release_id"],
                "release_profile": profile,
                "availability": "ready",
                "audit_status": "passed",
                "artifact_schema_version": "lineage-artifact-v2",
                "artifact_sha256": canonical_json_sha256(artifact),
                "fixture_sha256": canonical_json_sha256(fixture),
                "node_count": 2,
                "link_count": 1,
                "claim_decision_count": 2,
                "accepted_genealogy_count": 1,
                "accepted_comparison_count": 0,
                "decision_counts": {"accepted": 1, "unknown": 1, "abstained": 0, "rejected": 0},
                "calibration": calibration,
                "review": {
                    "status": "passed",
                    "reviewed_claim_count": 1,
                    "agreement": 1.0,
                    "fixture_id": fixture["fixture_id"],
                },
                "checks": [
                    {"name": name, "status": "passed", "detail": "synthetic"}
                    for name in [
                        "artifact_contract_v2",
                        "identity",
                        "evidence_binding",
                        "review_binding",
                        "accepted_dag",
                        "accepted_temporal",
                        "frozen_candidate_ledger",
                    ]
                    + (["automated_calibration"] if profile == "automated-calibrated-v1" else [])
                ],
            }
        ],
    }


def _codes(issues) -> set[str]:
    return {issue.code for issue in issues}


def _json_paths(value: object, path: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    paths = [path]
    if isinstance(value, dict):
        for key, nested in value.items():
            paths.extend(_json_paths(nested, (*path, key)))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            paths.extend(_json_paths(nested, (*path, index)))
    return paths


def _replace_json_path(value: object, path: tuple[object, ...], replacement: object) -> object:
    if not path:
        return deepcopy(replacement)
    mutated = deepcopy(value)
    cursor = mutated
    for segment in path[:-1]:
        cursor = cursor[segment]
    cursor[path[-1]] = deepcopy(replacement)
    return mutated


@pytest.mark.parametrize(
    ("schema_name", "factory", "validator"),
    [
        ("lineage-artifact-v2.schema.json", _artifact, validate_lineage_artifact_v2),
        (
            "lineage-audit-fixtures-v2.schema.json",
            lambda: _fixture(_artifact()),
            validate_lineage_audit_fixtures_v2,
        ),
        (
            "lineage-quality-v2.schema.json",
            lambda: _quality(_artifact(), _fixture(_artifact())),
            lambda value: validate_lineage_quality_v2(
                value,
                artifacts={"theme:synthetic-pilot": _artifact()},
                fixtures={"theme:synthetic-pilot": _fixture(_artifact())},
                catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
            ),
        ),
    ],
)
def test_recursive_mutations_are_total_and_at_least_as_strict_as_schema(
    schema_name: str, factory, validator
) -> None:
    value = factory()
    schema = json.loads((ROOT / "schemas" / schema_name).read_text())
    schema_validator = Draft202012Validator(schema, format_checker=FormatChecker())
    failures = []
    replacements = (None, True, {}, [], 42, "", "arbitrary", 10**1000, "\ud800")
    for path in _json_paths(value):
        original = value if not path else _value_at_path(value, path)
        for replacement in replacements:
            if replacement == original and type(replacement) is type(original):
                continue
            mutated = _replace_json_path(value, path, replacement)
            try:
                issues = validator(mutated)
            except Exception as exc:  # pragma: no cover - assertion reports exact hostile path
                failures.append((path, replacement, f"crashed: {type(exc).__name__}: {exc}"))
                continue
            if not schema_validator.is_valid(mutated) and not issues:
                failures.append((path, replacement, "accepted schema-invalid mutation"))
    assert failures == []


def _value_at_path(value: object, path: tuple[object, ...]) -> object:
    cursor = value
    for segment in path:
        cursor = cursor[segment]
    return cursor


def _rebind_quality(quality: dict, artifact: dict, fixture: dict) -> None:
    row = quality["collections"][0]
    artifact_hash = canonical_json_sha256(artifact)
    fixture["collections"][0]["artifact_sha256"] = artifact_hash
    row["artifact_sha256"] = artifact_hash
    row["fixture_sha256"] = canonical_json_sha256(fixture)


def _canonical_or_placeholder(value: object) -> str:
    try:
        return canonical_json_sha256(value)
    except (TypeError, ValueError):
        return "f" * 64


def test_valid_synthetic_pilot_contract_and_schemas() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    assert validate_lineage_artifact_v2(artifact, kind="theme", catalog_ids={PAPER_ID}) == []
    assert validate_lineage_audit_fixtures_v2(fixture) == []
    assert (
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
        == []
    )
    for filename, value in [
        ("lineage-artifact-v2.schema.json", artifact),
        ("lineage-audit-fixtures-v2.schema.json", fixture),
        ("lineage-quality-v2.schema.json", quality),
    ]:
        schema = json.loads((ROOT / "schemas" / filename).read_text())
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)


@pytest.mark.parametrize(
    "url", ["https://[", "https://[not-ipv6]", "https://example\uff0f.invalid"]
)
def test_malformed_evidence_authority_is_a_validation_issue(url: str) -> None:
    artifact = _artifact()
    artifact["evidence"][0]["url"] = url
    assert "evidence_url" in _codes(validate_lineage_artifact_v2(artifact))
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    assert validate_lineage_quality_v2(
        quality,
        artifacts={"theme:synthetic-pilot": artifact},
        fixtures={"theme:synthetic-pilot": fixture},
        catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
    )


def test_artifact_is_closed_and_does_not_accept_v1() -> None:
    artifact = _artifact()
    artifact["edges"] = []
    assert {"artifact_fields"} <= _codes(validate_lineage_artifact_v2(artifact))
    assert "artifact_schema_version" in _codes(
        validate_lineage_artifact_v2({"schema_version": "lineage-artifact-v1"})
    )


@pytest.mark.parametrize("decision", ["unknown", "abstained"])
def test_unknown_and_abstained_require_null_relation_and_reason(decision: str) -> None:
    artifact = _artifact(decision=decision, trust="tentative")
    assert validate_lineage_artifact_v2(artifact) == []
    artifact["claims"][0]["relation"] = "extends"
    artifact["claims"][0]["reason_codes"] = []
    assert {"claim_unknown_relation", "claim_reason_codes"} <= _codes(
        validate_lineage_artifact_v2(artifact)
    )


def test_ledger_hash_review_temporal_and_dag_fail_closed() -> None:
    artifact = _artifact()
    artifact["meta"]["candidate_universe"]["candidate_count"] = 4
    artifact["claims"][0]["review_binding"]["evidence_sha256"] = "f" * 64
    artifact["nodes"][0]["first_published_at"] = "2027-01-01T00:00:00Z"
    reverse = deepcopy(artifact["claims"][0])
    reverse["id"] = "claim:reverse"
    reverse["src"], reverse["dst"] = reverse["dst"], reverse["src"]
    artifact["claims"].append(reverse)
    assert {
        "ledger_coverage",
        "review_evidence_hash",
        "accepted_temporal_reversal",
        "accepted_bidirectional",
        "accepted_cycle",
    } <= _codes(validate_lineage_artifact_v2(artifact))


def test_verified_and_corroborated_have_distinct_bindings() -> None:
    artifact = _artifact()
    artifact["claims"][0]["review_binding"] = None
    assert "verified_review_missing" in _codes(validate_lineage_artifact_v2(artifact))
    artifact = _artifact(trust="corroborated")
    assert {"corroborated_calibration", "corroborated_evidence"} <= _codes(
        validate_lineage_artifact_v2(artifact)
    )


def test_evidence_endpoints_bind_nodes_links_and_accepted_claim_direction() -> None:
    artifact = _artifact()
    artifact["claims"][0]["evidence_ids"] = []
    assert "accepted_evidence_direction" in _codes(validate_lineage_artifact_v2(artifact))

    artifact = _artifact()
    artifact["evidence"][0]["cited_work_id"] = "node:synthetic-child"
    artifact["evidence"][0]["citing_work_id"] = "node:synthetic-parent"
    codes = _codes(validate_lineage_artifact_v2(artifact))
    assert {"link_evidence_endpoint_binding", "accepted_evidence_direction"} <= codes

    artifact = _artifact(trust="corroborated")
    claim = artifact["claims"][0]
    claim["calibrated_probability"] = 0.8
    claim["calibration_id"] = "synthetic-calibration-v1"
    second = deepcopy(artifact["evidence"][0])
    second["id"] = "evidence:synthetic-secondary"
    second["source"] = "synthetic-secondary"
    second["kind"] = "primary-api"
    artifact["evidence"].append(second)
    claim["evidence_ids"].append(second["id"])
    assert "corroborated_evidence" in _codes(validate_lineage_artifact_v2(artifact))


def test_fixture_requires_two_blind_people_and_independent_adjudicator() -> None:
    fixture = _fixture(_artifact())
    label = fixture["collections"][0]["edge_labels"][0]
    label["reviews"][1]["reviewer_id"] = "synthetic-human-a"
    label["reviews"][0]["blind_to_model"] = False
    label["adjudication"]["adjudicator_id"] = "synthetic-human-a"
    assert {"review_not_blind", "reviewer_independence", "adjudication"} <= _codes(
        validate_lineage_audit_fixtures_v2(fixture)
    )

    fixture = _fixture(_artifact())
    second_reviews = fixture["collections"][0]["edge_labels"][1]["reviews"]
    second_reviews[0]["reviewer_id"] = "synthetic-human-x"
    second_reviews[1]["reviewer_id"] = "synthetic-human-y"
    assert "reviewer_panel_mismatch" in _codes(validate_lineage_audit_fixtures_v2(fixture))

    fixture = _fixture(_artifact())
    fixture["collections"][0]["edge_labels"][0]["adjudication"]["reviewed_at"] = (
        "2026-09-04T23:59:00Z"
    )
    assert "adjudication_time" in _codes(validate_lineage_audit_fixtures_v2(fixture))


def test_quality_profiles_do_not_weaken_automated_gate() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    automated = _quality(artifact, fixture, "automated-calibrated-v1")
    automated["collections"][0]["calibration"]["sample_count"] = 29
    assert {"automated_calibration_gate", "automated_profile_unsupported"} <= _codes(
        validate_lineage_quality_v2(automated)
    )
    pilot = _quality(artifact, fixture)
    pilot["collections"][0]["calibration"]["status"] = "passed"
    assert "pilot_calibration" in _codes(validate_lineage_quality_v2(pilot))


def test_quality_rejects_unknown_profile_counts_and_hash_mismatch() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    row = quality["collections"][0]
    row["release_profile"] = "invented-profile"
    row["decision_counts"]["unknown"] = 2
    row["artifact_sha256"] = "f" * 64
    assert {"release_profile", "quality_ledger_coverage", "artifact_hash_mismatch"} <= _codes(
        validate_lineage_quality_v2(quality, artifacts={"theme:synthetic-pilot": artifact})
    )


def test_checked_in_fixture_is_explicitly_synthetic_and_valid() -> None:
    fixture_dir = ROOT / "paperpilot/tests/fixtures/lineage-v2"
    artifact = json.loads((fixture_dir / "synthetic-pilot-artifact.json").read_text())
    fixture = json.loads((fixture_dir / "synthetic-pilot-fixture.json").read_text())
    quality = json.loads((fixture_dir / "synthetic-pilot-quality.json").read_text())
    assert validate_lineage_artifact_v2(artifact) == []
    assert validate_lineage_audit_fixtures_v2(fixture) == []
    assert (
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
        == []
    )
    assert all(
        "synthetic" in review["reviewer_id"]
        for review in fixture["collections"][0]["edge_labels"][0]["reviews"]
    )


def test_validators_are_total_for_hostile_json_values() -> None:
    artifact = _artifact()
    artifact["root"] = ["not", "hashable"]
    artifact["claims"][0]["decision"] = ["accepted"]
    artifact["claims"][0]["src"] = {"bad": "endpoint"}
    artifact["claims"][0]["relation"] = ["extends"]
    assert validate_lineage_artifact_v2(artifact)

    fixture = _fixture(_artifact())
    fixture["collections"][0]["edge_labels"][0]["review_id"] = ["bad"]
    fixture["collections"][0]["edge_labels"][0]["reviews"][0]["reviewer_id"] = ["bad"]
    assert validate_lineage_audit_fixtures_v2(fixture)

    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    quality["collections"][0]["collection_id"] = ["bad"]
    quality["collections"][0]["kind"] = ["bad"]
    assert validate_lineage_quality_v2(quality)


def test_ready_quality_requires_actual_artifact_and_fixture_bindings() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    assert "ready_bindings_unverified" in _codes(
        validate_lineage_quality_v2(_quality(artifact, fixture))
    )


def test_verified_claim_must_match_complete_human_gold_ledger() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    fixture["collections"][0]["edge_labels"][0]["reviews"][0]["gold_relation"] = "successor"
    fixture["collections"][0]["edge_labels"][0]["adjudication"]["evidence_support"] = "conflicts"
    quality["collections"][0]["fixture_sha256"] = canonical_json_sha256(fixture)
    assert "accepted_gold_mismatch" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )

    fixture = _fixture(artifact)
    fixture["collections"][0]["edge_labels"] = []
    fixture["collections"][0]["candidate_universe"]["candidate_count"] = 0
    quality["collections"][0]["fixture_sha256"] = canonical_json_sha256(fixture)
    assert "candidate_label_bijection" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )


def test_quality_producer_derives_counts_and_refuses_unbound_release() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    expected = _quality(artifact, fixture)["collections"][0]
    manifest = build_lineage_quality_v2(
        as_of="2026-09-05T00:06:00Z",
        artifact=artifact,
        fixture=fixture,
        collection_id="theme:synthetic-pilot",
        slug="synthetic-pilot",
        label="Synthetic Pilot",
        path="staging/synthetic-pilot/lineage-v2.json",
        release_profile="claim-verified-pilot-v1",
        calibration=expected["calibration"],
        review=expected["review"],
        checks=expected["checks"],
        catalog_ids={PAPER_ID},
    )
    assert manifest["collections"][0]["claim_decision_count"] == 2
    broken = deepcopy(fixture)
    broken["collections"][0]["release_id"] = "other-release"
    with pytest.raises(ValueError, match="fixture_release_binding"):
        build_lineage_quality_v2(
            as_of="2026-09-05T00:06:00Z",
            artifact=artifact,
            fixture=broken,
            collection_id="theme:synthetic-pilot",
            slug="synthetic-pilot",
            label="Synthetic Pilot",
            path="staging/synthetic-pilot/lineage-v2.json",
            release_profile="claim-verified-pilot-v1",
            calibration=expected["calibration"],
            review=expected["review"],
            checks=expected["checks"],
            catalog_ids={PAPER_ID},
        )


def test_ready_quality_revalidates_bound_payloads_after_hashes_are_recomputed() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    artifact["claims"][0]["classification"]["provider"] = {"hostile": True}
    _rebind_quality(quality, artifact, fixture)
    assert "classification_identity" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )


@pytest.mark.parametrize("bound_name", ["artifact", "fixture"])
def test_ready_quality_bound_input_mutations_are_total_and_fail_closed(
    bound_name: str,
) -> None:
    schema = json.loads(
        (
            ROOT
            / "schemas"
            / (
                "lineage-artifact-v2.schema.json"
                if bound_name == "artifact"
                else "lineage-audit-fixtures-v2.schema.json"
            )
        ).read_text()
    )
    schema_validator = Draft202012Validator(schema, format_checker=FormatChecker())
    base_artifact = _artifact()
    base_fixture = _fixture(base_artifact)
    source = base_artifact if bound_name == "artifact" else base_fixture
    failures = []
    for path in _json_paths(source):
        original = source if not path else _value_at_path(source, path)
        for replacement in (None, True, {}, [], 42, "", "arbitrary", 10**1000, "\ud800"):
            if replacement == original and type(replacement) is type(original):
                continue
            artifact = deepcopy(base_artifact)
            fixture = deepcopy(base_fixture)
            if bound_name == "artifact":
                artifact = _replace_json_path(artifact, path, replacement)
                fixture["collections"][0]["artifact_sha256"] = _canonical_or_placeholder(artifact)
            else:
                fixture = _replace_json_path(fixture, path, replacement)
            quality = _quality(base_artifact, base_fixture)
            quality["collections"][0]["artifact_sha256"] = _canonical_or_placeholder(artifact)
            quality["collections"][0]["fixture_sha256"] = _canonical_or_placeholder(fixture)
            try:
                issues = validate_lineage_quality_v2(
                    quality,
                    artifacts={"theme:synthetic-pilot": artifact},
                    fixtures={"theme:synthetic-pilot": fixture},
                    catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
                )
            except Exception as exc:  # pragma: no cover - reports exact hostile path
                failures.append((path, replacement, f"crashed: {type(exc).__name__}: {exc}"))
                continue
            mutated = artifact if bound_name == "artifact" else fixture
            if not schema_validator.is_valid(mutated) and not issues:
                failures.append((path, replacement, "accepted schema-invalid bound mutation"))
    assert failures == []

    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    fixture["collections"][0]["candidate_universe"]["snapshot_ref"] = "fixture://other"
    _rebind_quality(quality, artifact, fixture)
    assert "candidate_universe_mismatch" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )


def test_candidate_identity_bijection_rejects_duplicates_without_dict_overwrite() -> None:
    artifact = _artifact()
    duplicate_claim = deepcopy(artifact["claims"][1])
    duplicate_claim["id"] = "claim:synthetic-unknown-duplicate"
    artifact["claims"].append(duplicate_claim)
    artifact["meta"]["candidate_universe"]["candidate_count"] = 3
    fixture = _fixture(artifact)
    duplicate_label = deepcopy(fixture["collections"][0]["edge_labels"][1])
    duplicate_label["review_id"] = "synthetic-review-3"
    fixture["collections"][0]["edge_labels"].append(duplicate_label)
    fixture["collections"][0]["candidate_universe"]["candidate_count"] = 3
    quality = _quality(artifact, fixture)
    quality["collections"][0]["claim_decision_count"] = 3
    quality["collections"][0]["decision_counts"]["unknown"] = 2
    _rebind_quality(quality, artifact, fixture)
    codes = _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )
    assert {"candidate_label_bijection", "edge_label_duplicate"} <= codes


def test_focus_labels_and_catalog_membership_are_bound_to_actual_artifact() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    fixture["collections"][0]["focus_labels"][0]["node_id"] = "node:not-present"
    _rebind_quality(quality, artifact, fixture)
    codes = _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": set()},
        )
    )
    assert {"focus_label_binding", "catalog_seed_membership"} <= codes


def test_review_agreement_is_kappa_not_raw_majority_agreement() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    for index in range(2, 12):
        evidence = _evidence(f"Synthetic insufficient evidence candidate {index}.")
        evidence["id"] = f"evidence:synthetic-{index}"
        artifact["evidence"].append(evidence)
        claim = deepcopy(artifact["claims"][1])
        claim["id"] = f"claim:synthetic-unknown-{index}"
        claim["evidence_ids"] = [evidence["id"]]
        artifact["claims"].append(claim)
        evidence_hash = canonical_json_sha256([evidence])
        label = deepcopy(fixture["collections"][0]["edge_labels"][1])
        label["review_id"] = f"synthetic-review-{index + 1}"
        label["evidence_sha256"] = evidence_hash
        fixture["collections"][0]["edge_labels"].append(label)
    artifact["meta"]["candidate_universe"]["candidate_count"] = 12
    fixture["collections"][0]["candidate_universe"]["candidate_count"] = 12
    for label in fixture["collections"][0]["edge_labels"][1:3]:
        label["reviews"][1]["gold_family"] = "genealogy"
        label["reviews"][1]["gold_relation"] = "extends"
        label["reviews"][1]["evidence_support"] = "supports"
    quality = _quality(artifact, fixture)
    row = quality["collections"][0]
    row["claim_decision_count"] = 12
    row["decision_counts"]["unknown"] = 11
    row["review"]["agreement"] = 3 / 7
    _rebind_quality(quality, artifact, fixture)
    codes = _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )
    assert "review_agreement_gate" in codes


def test_review_agreement_rejects_undefined_single_category_kappa() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    for review in fixture["collections"][0]["edge_labels"][1]["reviews"]:
        review["gold_family"] = "genealogy"
        review["gold_relation"] = "extends"
        review["evidence_support"] = "supports"
    quality = _quality(artifact, fixture)
    _rebind_quality(quality, artifact, fixture)
    assert "review_agreement_undefined" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )


def test_ready_quality_binds_generation_review_and_as_of_timeline() -> None:
    artifact = _artifact()
    fixture = _fixture(artifact)
    quality = _quality(artifact, fixture)
    quality["as_of"] = "2026-09-05T00:04:30Z"
    assert "review_timeline_binding" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )


def test_artifact_dag_validation_is_iterative_for_long_chains() -> None:
    artifact = _artifact()
    artifact["links"] = []
    artifact["evidence"] = []
    artifact["nodes"] = [artifact["nodes"][0]]
    artifact["claims"] = []
    for index in range(1, 1_501):
        artifact["nodes"].append(
            {
                "id": f"node:chain-{index}",
                "title": f"Synthetic Chain {index}",
                "first_published_at": "2026-01-01T00:00:00Z",
                "is_focus": False,
                "seed_paper_id": None,
                "aliases": [["arxiv", f"2601.{index:05d}"]],
            }
        )
        evidence = _evidence(f"Synthetic chain evidence {index}.")
        evidence["id"] = f"evidence:chain-{index}"
        evidence["source_work_id"] = f"synthetic-chain-source-{index}"
        evidence["cited_work_id"] = artifact["nodes"][index - 1]["id"]
        evidence["citing_work_id"] = artifact["nodes"][index]["id"]
        artifact["evidence"].append(evidence)
        artifact["claims"].append(
            {
                "id": f"claim:chain-{index}",
                "src": artifact["nodes"][index - 1]["id"],
                "dst": artifact["nodes"][index]["id"],
                "claim_family": "genealogy",
                "relation": "extends",
                "decision": "accepted",
                "trust_tier": "tentative",
                "raw_score": None,
                "calibrated_probability": None,
                "calibration_id": None,
                "evidence_ids": [evidence["id"]],
                "rationale": "Synthetic chain relation.",
                "classification": {
                    "method": "human_review",
                    "provider": None,
                    "model": None,
                    "prompt_version": None,
                    "schema_version": "synthetic-v1",
                },
                "reason_codes": [],
                "review_binding": None,
            }
        )
    artifact["meta"]["candidate_universe"]["candidate_count"] = 1_500
    assert validate_lineage_artifact_v2(artifact) == []


@pytest.mark.parametrize(
    "adjudication_update",
    [
        {"citation_valid": False},
        {"evidence_support": "conflicts"},
        {"gold_relation": "successor"},
        {"gold_family": None, "gold_relation": None},
    ],
)
def test_adjudication_mismatch(adjudication_update):
    artifact = _artifact()
    fixture = _fixture(artifact)
    fixture["collections"][0]["edge_labels"][0]["adjudication"].update(adjudication_update)
    codes = _codes(validate_lineage_audit_fixtures_v2(fixture))
    assert "adjudication_confirmation_mismatch" in codes
    quality = _quality(artifact, fixture)
    assert "adjudication_confirmation_mismatch" in _codes(
        validate_lineage_quality_v2(
            quality,
            artifacts={"theme:synthetic-pilot": artifact},
            fixtures={"theme:synthetic-pilot": fixture},
            catalog_ids={"theme:synthetic-pilot": {PAPER_ID}},
        )
    )
    row = quality["collections"][0]
    with pytest.raises(ValueError, match="adjudication_confirmation_mismatch"):
        build_lineage_quality_v2(
            as_of=quality["as_of"],
            artifact=artifact,
            fixture=fixture,
            collection_id=row["collection_id"],
            slug=row["slug"],
            label=row["label"],
            path=row["path"],
            release_profile=row["release_profile"],
            calibration=row["calibration"],
            review=row["review"],
            checks=row["checks"],
            catalog_ids={PAPER_ID},
        )


def test_positive_successor_in_review_only():
    fixture = _fixture(_artifact())
    fixture["collections"][0]["edge_labels"][0]["reviews"][1]["gold_relation"] = "successor"
    # adjudication remains untouched with gold_relation='extends'
    codes = _codes(validate_lineage_audit_fixtures_v2(fixture))
    assert codes == set()
