"""Synthetic-only tests for private blind-review answer intake."""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

import pytest

from paperpilot.lineage_pilot.review_intake import (
    MAX_ANSWER_BYTES,
    MAX_ANSWER_JSON_DEPTH,
    PrivateReviewIntake,
    ReviewIntakeError,
    ingest_blind_review_answers,
)
from paperpilot.lineage_pilot.review_prep import PrivateReviewBundle, PrivateReviewError
from paperpilot.replay import canonical_json_bytes, strict_json_loads
from paperpilot.tests.test_lineage_review_prep import (
    SOURCE_REF,
    _inputs,
    _prepare,
    _unknown_without_evidence_inputs,
)

INCORPORATED_AT = "2026-09-05T04:00:00Z"


def _object(payload: bytes) -> dict[str, Any]:
    value = strict_json_loads(payload)
    assert isinstance(value, dict)
    return value


def _response(slot: str, **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "reviewer_id": f"synthetic-reviewer-{slot}",
        "blind_to_model": True,
        "blind_to_peer": True,
        "citation_valid": True,
        "gold_family": "genealogy",
        "gold_relation": "extends",
        "evidence_support": "supports",
        "notes": "Synthetic test response only.",
        "reviewed_at": "2026-09-05T02:00:00Z" if slot == "a" else "2026-09-05T03:00:00Z",
    }
    value.update(overrides)
    return value


def _answer_object(
    bundle: PrivateReviewBundle,
    slot: str,
    responses: list[dict[str, object] | None] | None = None,
) -> dict[str, Any]:
    pack = _object(bundle.files[f"reviewer-{slot}.json"])
    candidates = pack["candidates"]
    assert isinstance(candidates, list)
    if responses is None:
        responses = [_response(slot) for _ in candidates]
    assert len(responses) == len(candidates)
    for candidate, response in zip(candidates, responses, strict=True):
        assert isinstance(candidate, dict)
        if response is not None:
            candidate["response"] = response
    return pack


def _answer_bytes(
    bundle: PrivateReviewBundle,
    slot: str,
    responses: list[dict[str, object] | None] | None = None,
    *,
    pretty: bool = False,
) -> bytes:
    value = _answer_object(bundle, slot, responses)
    if pretty:
        value = dict(reversed(tuple(value.items())))
        return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    payload: bytes = canonical_json_bytes(value)
    return payload


def _ingest(
    bundle: PrivateReviewBundle,
    *,
    a: bytes | None = None,
    b: bytes | None = None,
    incorporated_at: str = INCORPORATED_AT,
) -> PrivateReviewIntake:
    return ingest_blind_review_answers(
        bundle,
        answered_reviewer_a_bytes=a,
        answered_reviewer_b_bytes=b,
        incorporated_at=incorporated_at,
    )


def _two_candidate_bundle() -> PrivateReviewBundle:
    values = _inputs()
    artifact = values["artifact"]
    candidate = values["candidate"]

    child = copy.deepcopy(artifact["nodes"][1])
    child.update(
        {
            "id": "node:child-two",
            "title": "Synthetic Child Two",
            "aliases": [["arxiv", "2601.00002"]],
        }
    )
    artifact["nodes"].append(child)

    evidence = copy.deepcopy(artifact["evidence"][0])
    evidence.update(
        {
            "id": "evidence:secondary",
            "source_work_id": "synthetic-child-two",
            "citing_work_id": "node:child-two",
            "url": "https://example.invalid/child-two",
        }
    )
    artifact["evidence"].append(evidence)
    artifact["links"].append(
        {
            "id": "link:citation-two",
            "src": "node:child-two",
            "dst": "node:parent",
            "type": "citation",
            "evidence_ids": ["evidence:secondary"],
        }
    )
    claim = copy.deepcopy(artifact["claims"][0])
    claim.update(
        {
            "id": "claim:machine-candidate-two",
            "dst": "node:child-two",
            "evidence_ids": ["evidence:secondary"],
        }
    )
    artifact["claims"].append(claim)
    candidate["candidates"].append(
        {
            "candidate_id": "claim:machine-candidate-two",
            "src": "node:parent",
            "dst": "node:child-two",
            "evidence_ids": ["evidence:secondary"],
        }
    )
    values["candidate_snapshot_bytes"] = canonical_json_bytes(candidate)
    artifact["meta"]["candidate_universe"]["candidate_count"] = 2
    artifact["meta"]["candidate_universe"]["input_sha256"] = hashlib.sha256(
        values["candidate_snapshot_bytes"]
    ).hexdigest()
    values["artifact_bytes"] = canonical_json_bytes(artifact)
    return _prepare(values)


def _result(intake: PrivateReviewIntake) -> dict[str, Any]:
    return _object(intake.result_bytes)


def test_complete_agreement_is_private_deterministic_and_bound() -> None:
    bundle = _prepare()
    originals = dict(bundle.files)
    a = _answer_bytes(bundle, "a", pretty=True)
    b = _answer_bytes(bundle, "b", pretty=True)

    first = _ingest(bundle, a=a, b=b)
    second = _ingest(bundle, a=a, b=b)

    assert first == second
    assert first.status == "complete"
    assert first.candidate_count == first.dual_reviewed_count == 1
    assert first.pending_review_ids == first.disagreement_review_ids == ()
    assert first.result_sha256 == hashlib.sha256(first.result_bytes).hexdigest()
    assert dict(bundle.files) == originals
    result = _result(first)
    assert result["schema_version"] == "lineage-private-review-intake-v1"
    assert result["scope"] == "coordinator_only"
    assert result["status"] == "complete"
    assert result["review_identity_boundary"] == (
        "self_declared_reviewers_and_blinding_not_authenticated"
    )
    assert (
        result["bindings"]["coordinator_sha256"]
        == hashlib.sha256(bundle.files["coordinator.json"]).hexdigest()
    )
    assert result["bindings"]["answered_packs"][0]["sha256"] == hashlib.sha256(a).hexdigest()
    assert result["bindings"]["answered_packs"][1]["sha256"] == hashlib.sha256(b).hexdigest()
    assert result["bindings"]["source_snapshots"][0]["snapshot_ref"] == SOURCE_REF
    for field in (
        "audit_fixture_authorized",
        "artifact_update_authorized",
        "quality_authorized",
        "publication_authorized",
    ):
        assert result[field] is False
    assert b"synthetic-model" not in first.result_bytes
    assert b"The child explicitly extends" not in first.result_bytes


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("citation_valid", False),
        ("gold_family", "comparison"),
        ("gold_relation", "successor"),
        ("evidence_support", "insufficient"),
    ],
)
def test_each_gold_field_disagreement_requires_adjudication(field: str, value: object) -> None:
    bundle = _prepare()
    b_response = _response("b")
    if field == "gold_family":
        b_response.update(gold_family=value, gold_relation="contrasts")
    else:
        b_response[field] = value
    intake = _ingest(
        bundle,
        a=_answer_bytes(bundle, "a"),
        b=_answer_bytes(bundle, "b", [b_response]),
    )
    assert intake.status == "disagreement"
    assert intake.dual_reviewed_count == 1
    assert len(intake.disagreement_review_ids) == 1
    result = _result(intake)
    assert result["audit_fixture_authorized"] is False
    assert "adjudication" not in result


def test_notes_and_timestamps_do_not_create_disagreement() -> None:
    bundle = _prepare()
    intake = _ingest(
        bundle,
        a=_answer_bytes(bundle, "a"),
        b=_answer_bytes(
            bundle,
            "b",
            [_response("b", notes="Different synthetic note.", reviewed_at="2026-09-05T03:30:00Z")],
        ),
    )
    assert intake.status == "complete"
    assert intake.disagreement_review_ids == ()


def test_missing_or_all_null_answers_remain_pending() -> None:
    bundle = _prepare()
    only_a = _ingest(bundle, a=_answer_bytes(bundle, "a"), b=None)
    assert only_a.status == "pending"
    assert only_a.dual_reviewed_count == 0
    assert len(only_a.pending_review_ids) == 1
    result = _result(only_a)
    assert result["bindings"]["answered_packs"][1]["sha256"] is None
    assert result["candidates"][0]["responses"]["b"] is None

    untouched_b = bundle.files["reviewer-b.json"]
    pending = _ingest(bundle, a=_answer_bytes(bundle, "a"), b=untouched_b)
    assert pending.status == "pending"
    assert pending.pending_review_ids == only_a.pending_review_ids
    assert (
        _result(pending)["bindings"]["answered_packs"][1]["sha256"]
        == hashlib.sha256(untouched_b).hexdigest()
    )


def test_pending_precedes_existing_disagreement_for_mixed_candidates() -> None:
    bundle = _two_candidate_bundle()
    a_responses = [_response("a"), None]
    b_responses = [_response("b", citation_valid=False), None]
    intake = _ingest(
        bundle,
        a=_answer_bytes(bundle, "a", a_responses),
        b=_answer_bytes(bundle, "b", b_responses),
    )
    assert intake.status == "pending"
    assert intake.candidate_count == 2
    assert intake.dual_reviewed_count == 1
    assert len(intake.pending_review_ids) == 1
    assert len(intake.disagreement_review_ids) == 1


def test_null_gold_insufficient_and_unknown_without_evidence_are_retained() -> None:
    bundle = _prepare(_unknown_without_evidence_inputs())
    a = _response("a", gold_family=None, gold_relation=None, evidence_support="insufficient")
    b = _response("b", gold_family=None, gold_relation=None, evidence_support="insufficient")
    intake = _ingest(
        bundle,
        a=_answer_bytes(bundle, "a", [a]),
        b=_answer_bytes(bundle, "b", [b]),
    )
    assert intake.status == "complete"
    assert intake.candidate_count == 1
    candidate = _result(intake)["candidates"][0]
    assert candidate["evidence_sha256"] == hashlib.sha256(b"[]\n").hexdigest()
    assert candidate["responses"]["a"]["gold_relation"] is None


def test_partial_response_is_rejected_not_treated_as_pending() -> None:
    bundle = _prepare()
    partial: dict[str, object] = {key: None for key in _response("a")}
    partial["reviewer_id"] = "synthetic-reviewer-a"
    with pytest.raises(ReviewIntakeError, match=r"^response_invalid$"):
        _ingest(bundle, a=_answer_bytes(bundle, "a", [partial]))


@pytest.mark.parametrize(
    ("changes", "incorporated_at"),
    [
        ({"blind_to_model": False}, INCORPORATED_AT),
        ({"blind_to_peer": 1}, INCORPORATED_AT),
        ({"citation_valid": 1}, INCORPORATED_AT),
        ({"reviewer_id": "bad reviewer@example.com"}, INCORPORATED_AT),
        ({"gold_family": "genealogy", "gold_relation": "contrasts"}, INCORPORATED_AT),
        ({"gold_family": "other", "gold_relation": "extends"}, INCORPORATED_AT),
        ({"gold_family": [], "gold_relation": "extends"}, INCORPORATED_AT),
        ({"gold_family": "genealogy", "gold_relation": {}}, INCORPORATED_AT),
        ({"evidence_support": "maybe"}, INCORPORATED_AT),
        ({"notes": "bad\x00note"}, INCORPORATED_AT),
        ({"notes": "x" * 4_001}, INCORPORATED_AT),
        ({"reviewed_at": "2026-09-05T00:59:59Z"}, INCORPORATED_AT),
        ({"reviewed_at": "2026-09-05T04:00:01Z"}, INCORPORATED_AT),
        ({"reviewed_at": "2026-09-05T02:00:00"}, INCORPORATED_AT),
    ],
)
def test_invalid_typed_response_is_rejected(
    changes: dict[str, object], incorporated_at: str
) -> None:
    bundle = _prepare()
    with pytest.raises(ReviewIntakeError):
        _ingest(
            bundle,
            a=_answer_bytes(bundle, "a", [_response("a", **changes)]),
            incorporated_at=incorporated_at,
        )


def test_reviewer_identity_must_be_consistent_and_distinct() -> None:
    bundle = _prepare()
    with pytest.raises(ReviewIntakeError, match=r"^reviewer_independence_invalid$"):
        _ingest(
            bundle,
            a=_answer_bytes(bundle, "a"),
            b=_answer_bytes(
                bundle,
                "b",
                [_response("b", reviewer_id="synthetic-reviewer-a")],
            ),
        )

    two = _two_candidate_bundle()
    with pytest.raises(ReviewIntakeError, match=r"^reviewer_panel_invalid$"):
        _ingest(
            two,
            a=_answer_bytes(
                two,
                "a",
                [_response("a"), _response("a", reviewer_id="synthetic-reviewer-other")],
            ),
        )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.__setitem__("status", "complete"),
        lambda value: value.__setitem__("extra", None),
        lambda value: value["candidates"][0]["src"].__setitem__("node_id", "node:other"),
        lambda value: value["candidates"][0]["evidence"][0].__setitem__("excerpt", "changed"),
        lambda value: value["candidates"][0].__setitem__("review_id", "review:" + "0" * 64),
        lambda value: value["candidates"].pop(),
        lambda value: value["candidates"].append(copy.deepcopy(value["candidates"][0])),
        lambda value: value["candidates"][0].__setitem__("extra", None),
        lambda value: value["candidates"][0]["response"].__setitem__("extra", None),
    ],
)
def test_only_response_fields_may_change(mutation) -> None:
    bundle = _prepare()
    answer = _answer_object(bundle, "a")
    mutation(answer)
    with pytest.raises(ReviewIntakeError):
        _ingest(bundle, a=canonical_json_bytes(answer))


def test_reviewer_slots_cannot_be_swapped() -> None:
    bundle = _prepare()
    with pytest.raises(ReviewIntakeError, match=r"^answer_binding_mismatch$"):
        _ingest(bundle, a=_answer_bytes(bundle, "b"))


@pytest.mark.parametrize(
    "payload",
    [
        b'{"x":1,"x":2}',
        b'{"x":NaN}',
        b"\xef\xbb\xbf{}",
        "{}".encode("utf-16"),
    ],
)
def test_malformed_answer_json_is_safely_rejected(payload: bytes) -> None:
    with pytest.raises(ReviewIntakeError, match=r"^answer_invalid$"):
        _ingest(_prepare(), a=payload)


def test_surrogate_in_well_shaped_answer_is_safely_rejected() -> None:
    bundle = _prepare()
    answer = _answer_object(bundle, "a", [_response("a", notes="\ud800")])
    with pytest.raises(ReviewIntakeError, match=r"^answer_invalid$"):
        _ingest(bundle, a=json.dumps(answer, ensure_ascii=True).encode("utf-8"))


def test_depth_and_size_bounds_are_enforced() -> None:
    nested: object = None
    for _ in range(MAX_ANSWER_JSON_DEPTH + 1):
        nested = [nested]
    bundle = _prepare()
    answer = _answer_object(bundle, "a", [_response("a", notes=nested)])
    deep = json.dumps(answer).encode("utf-8")
    with pytest.raises(ReviewIntakeError, match=r"^answer_depth$"):
        _ingest(bundle, a=deep)
    with pytest.raises(ReviewIntakeError, match=r"^answer_size$"):
        _ingest(_prepare(), a=b"x" * (MAX_ANSWER_BYTES + 1))


@pytest.mark.parametrize(
    "incorporated_at",
    ["2026-09-05T00:59:59Z", "2026-09-05T04:00:00", "9999-12-31T23:59:59-23:59"],
)
def test_invalid_incorporation_time_is_rejected(incorporated_at: str) -> None:
    with pytest.raises(ReviewIntakeError, match=r"^incorporated_at_invalid$"):
        _ingest(_prepare(), incorporated_at=incorporated_at)


def test_factory_brand_is_checked_before_any_answer_input() -> None:
    bundle = _prepare()
    forged = PrivateReviewBundle(
        files=bundle.files,
        coordinator_sha256=bundle.coordinator_sha256,
        reviewer_pack_sha256s=bundle.reviewer_pack_sha256s,
    )
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        _ingest(forged, a=b"not json")

    copied = copy.copy(bundle)
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        _ingest(copied, a=b"not json")

    tampered = _prepare()
    object.__setattr__(tampered, "files", None)
    with pytest.raises(PrivateReviewError, match=r"^review_bundle_invalid$"):
        _ingest(tampered, a=b"not json")
