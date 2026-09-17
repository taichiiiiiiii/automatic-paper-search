from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from types import MappingProxyType
from typing import Any

import jsonschema
import pytest

from paperpilot.identity import make_paper_id
from paperpilot.lineage_pilot.review_prep import (
    MAX_SOURCE_SNAPSHOT_BYTES,
    PrivateReviewBundle,
    PrivateReviewError,
    prepare_blind_review,
    validated_private_review_files,
)
from paperpilot.replay import (
    canonical_json_bytes,
    canonical_json_sha256,
    strict_json_loads,
)

PAPER_ID = make_paper_id("arxiv", "2501.00001")
CONFERENCE = "synthetic-pilot"
COLLECTION_ID = f"deep:{CONFERENCE}:paper:{PAPER_ID}"
SOURCE_REF = "source-snapshot:primary-v1"


def _inputs() -> dict[str, Any]:
    source_bytes = canonical_json_bytes({"source": "synthetic primary snapshot"})
    candidate = {
        "schema_version": "lineage-candidate-universe-v1",
        "snapshot_ref": "candidate-snapshot:synthetic-v1",
        "collection_id": COLLECTION_ID,
        "release_id": "synthetic-release-v1",
        "selection_method": "synthetic-pinned-v1",
        "candidates": [
            {
                "candidate_id": "claim:machine-candidate",
                "src": "node:parent",
                "dst": "node:child",
                "evidence_ids": ["evidence:primary"],
            }
        ],
    }
    candidate_bytes = canonical_json_bytes(candidate)
    excerpt = "The child explicitly extends the parent mechanism."
    evidence = {
        "id": "evidence:primary",
        "source": "synthetic-primary",
        "kind": "paper-text",
        "source_work_id": "synthetic-child",
        "cited_work_id": "node:parent",
        "citing_work_id": "node:child",
        "url": "https://example.invalid/child",
        "locator": {
            "page": 2,
            "section": "Method",
            "reference_marker": "[1]",
            "sentence_ordinal": 1,
            "paragraph_ordinal": 1,
        },
        "excerpt": excerpt,
        "excerpt_sha256": hashlib.sha256(excerpt.encode()).hexdigest(),
        "input_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "retrieved_at": "2026-09-05T00:00:00Z",
        "snapshot_ref": SOURCE_REF,
    }
    artifact = {
        "schema_version": "lineage-artifact-v2",
        "release_id": candidate["release_id"],
        "root": "node:parent",
        "nodes": [
            {
                "id": "node:parent",
                "title": "Synthetic Parent",
                "first_published_at": "2025-01-01",
                "is_focus": True,
                "seed_paper_id": PAPER_ID,
                "aliases": [["arxiv", "2501.00001"]],
            },
            {
                "id": "node:child",
                "title": "Synthetic Child",
                "first_published_at": "2026-01-01",
                "is_focus": False,
                "seed_paper_id": None,
                "aliases": [["arxiv", "2601.00001"]],
            },
        ],
        "links": [
            {
                "id": "link:citation",
                "src": "node:child",
                "dst": "node:parent",
                "type": "citation",
                "evidence_ids": [evidence["id"]],
            }
        ],
        "evidence": [evidence],
        "claims": [
            {
                "id": "claim:machine-candidate",
                "src": "node:parent",
                "dst": "node:child",
                "claim_family": "genealogy",
                "relation": "extends",
                "decision": "accepted",
                "trust_tier": "tentative",
                "raw_score": 0.82,
                "calibrated_probability": None,
                "calibration_id": None,
                "evidence_ids": [evidence["id"]],
                "rationale": "Machine-only proposal that reviewers must not see.",
                "classification": {
                    "method": "llm",
                    "provider": "synthetic-provider",
                    "model": "synthetic-model",
                    "prompt_version": "synthetic-prompt-v1",
                    "schema_version": "synthetic-classifier-v1",
                },
                "reason_codes": [],
                "review_binding": None,
            }
        ],
        "clusters": [],
        "meta": {
            "kind": "deep",
            "producer": {"name": "synthetic-producer", "version": "1"},
            "generated_at": "2026-09-05T00:00:00Z",
            "candidate_universe": {
                "snapshot_ref": candidate["snapshot_ref"],
                "input_sha256": hashlib.sha256(candidate_bytes).hexdigest(),
                "selection_method": candidate["selection_method"],
                "candidate_count": 1,
            },
        },
    }
    catalog = [
        {
            "paper_id": PAPER_ID,
            "source": "arxiv",
            "source_id": "2501.00001",
            "arxiv_url": "https://arxiv.org/abs/2501.00001v1",
            "title": "Synthetic Parent",
            "authors": ["Synthetic Author"],
            "tags": ["synthetic"],
            "abstract": "Synthetic catalog abstract.",
        }
    ]
    return {
        "artifact": artifact,
        "artifact_bytes": canonical_json_bytes(artifact),
        "catalog": catalog,
        "catalog_bytes": canonical_json_bytes(catalog),
        "candidate": candidate,
        "candidate_snapshot_bytes": candidate_bytes,
        "source_snapshots": {SOURCE_REF: source_bytes},
    }


def _prepare(
    values: dict[str, Any] | None = None, *, conference: str = CONFERENCE
) -> PrivateReviewBundle:
    values = values or _inputs()
    return prepare_blind_review(
        artifact_bytes=values["artifact_bytes"],
        catalog_bytes=values["catalog_bytes"],
        candidate_snapshot_bytes=values["candidate_snapshot_bytes"],
        source_snapshots=values["source_snapshots"],
        conference=conference,
        paper_id=PAPER_ID,
        fixture_id="pilot-fixture-v1",
        created_at="2026-09-05T01:00:00Z",
    )


def _unknown_without_evidence_inputs() -> dict[str, Any]:
    values = _inputs()
    claim = values["artifact"]["claims"][0]
    claim.update(
        {
            "relation": None,
            "decision": "unknown",
            "raw_score": None,
            "evidence_ids": [],
            "rationale": "",
            "reason_codes": ["source_unavailable"],
        }
    )
    values["artifact"]["evidence"] = []
    values["artifact"]["links"] = []
    values["candidate"]["candidates"][0]["evidence_ids"] = []
    values["candidate_snapshot_bytes"] = canonical_json_bytes(values["candidate"])
    values["artifact"]["meta"]["candidate_universe"]["input_sha256"] = hashlib.sha256(
        values["candidate_snapshot_bytes"]
    ).hexdigest()
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    values["source_snapshots"] = {}
    return values


def _json_object(payload: bytes) -> dict[str, Any]:
    value = strict_json_loads(payload)
    assert isinstance(value, dict)
    return value


def _pack(bundle: PrivateReviewBundle, slot: str) -> dict[str, Any]:
    return _json_object(bundle.files[f"reviewer-{slot}.json"])


def test_prepares_deterministic_immutable_pending_bytes() -> None:
    values = _inputs()
    originals = copy.deepcopy(values)
    first = _prepare(values)
    second = _prepare(_inputs())

    assert values == originals
    assert isinstance(first.files, MappingProxyType)
    assert dict(first.files) == dict(second.files)
    assert set(first.files) == {"coordinator.json", "reviewer-a.json", "reviewer-b.json"}
    for payload in first.files.values():
        assert type(payload) is bytes
        assert payload.endswith(b"\n") and not payload.endswith(b"\n\n")
    with pytest.raises(TypeError):
        first.files["extra.json"] = b"{}\n"  # type: ignore[index]


def test_validated_files_requires_factory_brand_and_rechecks_hashes() -> None:
    bundle = _prepare()
    assert dict(validated_private_review_files(bundle)) == dict(bundle.files)
    forged = PrivateReviewBundle(
        files=bundle.files,
        coordinator_sha256=bundle.coordinator_sha256,
        reviewer_pack_sha256s=bundle.reviewer_pack_sha256s,
    )
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        validated_private_review_files(forged)

    object.__setattr__(bundle, "coordinator_sha256", "0" * 64)
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        validated_private_review_files(bundle)


def test_validated_files_rejects_replaced_containers_without_using_them() -> None:
    class HostileMapping(dict[str, bytes]):
        def __iter__(self):
            raise AssertionError("must not inspect a replaced mapping")

        def get(self, key, default=None):
            raise AssertionError("must not inspect a replaced mapping")

    for field, replacement in (
        ("files", None),
        ("files", {}),
        ("files", MappingProxyType(HostileMapping())),
        ("reviewer_pack_sha256s", None),
        ("reviewer_pack_sha256s", {}),
    ):
        bundle = _prepare()
        object.__setattr__(bundle, field, replacement)
        with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
            validated_private_review_files(bundle)

    forged = PrivateReviewBundle(
        files={},
        coordinator_sha256="0" * 64,
        reviewer_pack_sha256s={},
    )
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        validated_private_review_files(forged)


def test_blind_packs_are_schema_valid_equal_and_pending() -> None:
    bundle = _prepare()
    schema = strict_json_loads(
        (
            Path(__file__).resolve().parents[2] / "schemas/lineage-blind-review-pack-v1.schema.json"
        ).read_bytes()
    )
    a = _pack(bundle, "a")
    b = _pack(bundle, "b")
    jsonschema.Draft202012Validator(schema).validate(a)
    jsonschema.Draft202012Validator(schema).validate(b)

    comparable_a = {
        key: value for key, value in a.items() if key not in {"pack_id", "reviewer_slot"}
    }
    comparable_b = {
        key: value for key, value in b.items() if key not in {"pack_id", "reviewer_slot"}
    }
    assert comparable_a == comparable_b
    assert a["status"] == b["status"] == "pending"
    assert (
        a["evidence_boundary"]
        == "local_snapshot_hash_only_source_identity_and_excerpt_membership_unverified"
    )
    assert a["candidate_count"] == len(a["candidates"]) == 1
    candidate = a["candidates"][0]
    assert candidate["src"]["node_id"] == "node:parent"
    assert candidate["dst"]["node_id"] == "node:child"
    assert candidate["evidence"][0]["cited_work_id"] == "node:parent"
    assert candidate["evidence"][0]["citing_work_id"] == "node:child"
    assert set(candidate["response"].values()) == {None}


def test_conference_slug_bound_keeps_generated_pack_schema_valid() -> None:
    conference = "a" * 40
    values = _inputs()
    collection_id = f"deep:{conference}:paper:{PAPER_ID}"
    values["candidate"]["collection_id"] = collection_id
    values["candidate_snapshot_bytes"] = canonical_json_bytes(values["candidate"])
    values["artifact"]["meta"]["candidate_universe"]["input_sha256"] = hashlib.sha256(
        values["candidate_snapshot_bytes"]
    ).hexdigest()
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])

    bundle = _prepare(values, conference=conference)
    schema = strict_json_loads(
        (
            Path(__file__).resolve().parents[2] / "schemas/lineage-blind-review-pack-v1.schema.json"
        ).read_bytes()
    )
    jsonschema.Draft202012Validator(schema).validate(_pack(bundle, "a"))

    with pytest.raises(PrivateReviewError, match=r"^conference_invalid$"):
        _prepare(conference="a" * 41)


def test_unknown_without_evidence_remains_in_population_without_fake_source() -> None:
    bundle = _prepare(_unknown_without_evidence_inputs())
    pack = _pack(bundle, "a")
    assert pack["candidate_count"] == 1
    assert pack["candidates"][0]["evidence"] == []
    assert pack["candidates"][0]["evidence_sha256"] == canonical_json_sha256([])
    coordinator = _json_object(bundle.files["coordinator.json"])
    assert coordinator["bindings"]["source_snapshots"] == []
    assert coordinator["candidates"][0]["machine_claim"]["decision"] == "unknown"


def test_blind_pack_does_not_leak_machine_or_population_metadata() -> None:
    pack = _pack(_prepare(), "a")
    candidate = pack["candidates"][0]
    forbidden = {
        "candidate_id",
        "claim_id",
        "claim_family",
        "relation",
        "decision",
        "trust_tier",
        "raw_score",
        "calibrated_probability",
        "calibration_id",
        "rationale",
        "classification",
        "reason_codes",
        "review_binding",
        "selection_method",
    }

    def keys(value: object) -> set[str]:
        if isinstance(value, dict):
            return set(value) | set().union(*(keys(item) for item in value.values()))
        if isinstance(value, list):
            return set().union(*(keys(item) for item in value))
        return set()

    # Response field names are human answer slots, not leaked machine values.
    assert not (
        keys({key: value for key, value in candidate.items() if key != "response"}) & forbidden
    )
    assert "selection_method" not in keys(pack)
    raw = canonical_json_bytes(pack)
    assert b"synthetic-model" not in raw
    assert b"Machine-only proposal" not in raw
    assert _inputs()["source_snapshots"][SOURCE_REF] not in raw


def test_coordinator_retains_exact_machine_and_hash_bindings() -> None:
    values = _inputs()
    bundle = _prepare(values)
    coordinator = _json_object(bundle.files["coordinator.json"])
    assert coordinator["status"] == "pending"
    claim = coordinator["candidates"][0]["machine_claim"]
    assert claim == values["artifact"]["claims"][0]
    assert coordinator["candidate_universe"]["candidate_count"] == 1
    assert (
        coordinator["bindings"]["candidate_snapshot_sha256"]
        == hashlib.sha256(values["candidate_snapshot_bytes"]).hexdigest()
    )
    assert hashlib.sha256(bundle.files["coordinator.json"]).hexdigest() == bundle.coordinator_sha256
    for slot, digest in bundle.reviewer_pack_sha256s.items():
        assert hashlib.sha256(bundle.files[f"reviewer-{slot}.json"]).hexdigest() == digest


def test_catalog_may_be_pretty_json_and_binds_its_exact_raw_bytes() -> None:
    values = _inputs()
    pretty = (json.dumps(values["catalog"], ensure_ascii=False, indent=2) + "\n").encode()
    values["catalog_bytes"] = pretty
    bundle = _prepare(values)
    coordinator = _json_object(bundle.files["coordinator.json"])
    assert coordinator["bindings"]["catalog_sha256"] == hashlib.sha256(pretty).hexdigest()


def test_selected_catalog_native_identity_and_focus_alias_are_bound() -> None:
    values = _inputs()
    values["catalog"][0]["source_id"] = "2501.00002"
    values["catalog_bytes"] = canonical_json_bytes(values["catalog"])
    with pytest.raises(PrivateReviewError, match=r"^catalog_identity_mismatch$"):
        _prepare(values)

    values = _inputs()
    values["artifact"]["nodes"][0]["aliases"] = [["arxiv", "2501.00002"]]
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    with pytest.raises(PrivateReviewError, match=r"^focus_catalog_alias_mismatch$"):
        _prepare(values)


@pytest.mark.parametrize("mode", ["changed", "missing", "unused", "oversized"])
def test_source_snapshots_are_exact_complete_and_bounded(mode: str) -> None:
    values = _inputs()
    snapshots = dict(values["source_snapshots"])
    if mode == "changed":
        snapshots[SOURCE_REF] += b"x"
        code = "source_snapshot_hash_mismatch"
    elif mode == "missing":
        snapshots.clear()
        code = "source_snapshot_missing"
    elif mode == "unused":
        snapshots["source-snapshot:unused"] = b"unused"
        code = "source_snapshot_unused"
    else:
        snapshots[SOURCE_REF] = b"x" * (MAX_SOURCE_SNAPSHOT_BYTES + 1)
        code = "source_snapshot_size"
    values["source_snapshots"] = snapshots
    with pytest.raises(PrivateReviewError, match=rf"^{code}$"):
        _prepare(values)


def test_duplicate_source_snapshot_items_are_rejected() -> None:
    values = _inputs()
    source_bytes = values["source_snapshots"][SOURCE_REF]

    class DuplicateItems(dict):
        def items(self):
            return [(SOURCE_REF, source_bytes), (SOURCE_REF, source_bytes)]

    values["source_snapshots"] = DuplicateItems()
    with pytest.raises(PrivateReviewError, match=r"^source_snapshot_duplicate$"):
        _prepare(values)


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (lambda a: a["claims"][0].__setitem__("trust_tier", "verified"), "candidate_pre_reviewed"),
        (
            lambda a: a["claims"][0].__setitem__("trust_tier", "corroborated"),
            "candidate_pre_reviewed",
        ),
        (
            lambda a: a["claims"][0].__setitem__(
                "review_binding",
                {"review_id": "r", "fixture_id": "f", "evidence_sha256": "0" * 64},
            ),
            "candidate_pre_reviewed",
        ),
        (
            lambda a: a["claims"][0]["classification"].__setitem__("method", "human_review"),
            "candidate_pre_reviewed",
        ),
    ],
)
def test_rejects_any_prior_human_or_trusted_state(mutation, code: str) -> None:
    values = _inputs()
    mutation(values["artifact"])
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    with pytest.raises(PrivateReviewError, match=rf"^{code}$"):
        _prepare(values)


def test_candidate_snapshot_requires_full_exact_bijection() -> None:
    values = _inputs()
    values["candidate"]["candidates"][0]["dst"] = "node:parent"
    values["candidate_snapshot_bytes"] = canonical_json_bytes(values["candidate"])
    values["artifact"]["meta"]["candidate_universe"]["input_sha256"] = hashlib.sha256(
        values["candidate_snapshot_bytes"]
    ).hexdigest()
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    with pytest.raises(PrivateReviewError, match=r"^candidate_population_mismatch$"):
        _prepare(values)


def test_rejects_noncanonical_duplicate_json_and_focus_mismatch() -> None:
    values = _inputs()
    values["artifact_bytes"] = values["artifact_bytes"][:-1]
    with pytest.raises(PrivateReviewError, match=r"^artifact_noncanonical$"):
        _prepare(values)

    values = _inputs()
    values["candidate_snapshot_bytes"] = b'{"schema_version":"x","schema_version":"y"}\n'
    with pytest.raises(PrivateReviewError, match=r"^candidate_snapshot_invalid$"):
        _prepare(values)

    values = _inputs()
    values["catalog"][0]["paper_id"] = "2" * 40
    values["catalog_bytes"] = canonical_json_bytes(values["catalog"])
    with pytest.raises(PrivateReviewError, match=r"^paper_absent_from_catalog$"):
        _prepare(values)


@pytest.mark.parametrize("nodes", [None, 1, {"node:bad": {}}])
def test_malformed_nodes_are_normalized_to_private_error(nodes: object) -> None:
    values = _inputs()
    values["artifact"]["nodes"] = nodes
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    with pytest.raises(PrivateReviewError) as caught:
        _prepare(values)
    assert caught.value.code.startswith("artifact_")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.invalid/child",
        "https://user:password@example.invalid/child",
        "https://example.invalid/child\nsecret",
    ],
)
def test_rejects_non_private_safe_evidence_urls(url: str) -> None:
    values = _inputs()
    values["artifact"]["evidence"][0]["url"] = url
    values["artifact_bytes"] = canonical_json_bytes(values["artifact"])
    with pytest.raises(PrivateReviewError, match=r"^evidence_url_unsafe$"):
        _prepare(values)


def test_evidence_hash_uses_complete_original_records_in_id_order() -> None:
    values = _inputs()
    bundle = _prepare(values)
    coordinator = _json_object(bundle.files["coordinator.json"])
    expected = canonical_json_sha256(values["artifact"]["evidence"])
    assert coordinator["candidates"][0]["evidence_sha256"] == expected
