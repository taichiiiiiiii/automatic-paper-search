"""Independent synthetic prepare-to-intake checks; never real human approvals."""

from __future__ import annotations

import json
import socket
import subprocess
from pathlib import Path

import pytest

from paperpilot.lineage_pilot import review_intake
from paperpilot.lineage_pilot.review_intake import (
    ReviewIntakeError,
    ingest_blind_review_answers,
)
from paperpilot.replay import sha256_bytes
from paperpilot.tests.test_lineage_review_prep import (
    _prepare,
    _unknown_without_evidence_inputs,
)


def _synthetic_answer(original: bytes, slot: str) -> bytes:
    document = json.loads(original)
    for candidate in document["candidates"]:
        candidate["response"] = {
            "reviewer_id": f"synthetic-reviewer-{slot}",
            "blind_to_model": True,
            "blind_to_peer": True,
            "citation_valid": False,
            "gold_family": None,
            "gold_relation": None,
            "evidence_support": "insufficient",
            "notes": "Synthetic test response; no human reviewed any real paper.",
            "reviewed_at": "2026-09-05T02:00:00Z",
        }
    return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")


def test_unknown_without_evidence_survives_prepare_and_both_synthetic_answers() -> None:
    original = _prepare(_unknown_without_evidence_inputs())
    a_bytes = _synthetic_answer(original.files["reviewer-a.json"], "a")
    b_bytes = _synthetic_answer(original.files["reviewer-b.json"], "b")
    first = ingest_blind_review_answers(
        original,
        answered_reviewer_a_bytes=a_bytes,
        answered_reviewer_b_bytes=b_bytes,
        incorporated_at="2026-09-05T03:00:00Z",
    )
    second = ingest_blind_review_answers(
        original,
        answered_reviewer_a_bytes=a_bytes,
        answered_reviewer_b_bytes=b_bytes,
        incorporated_at="2026-09-05T03:00:00Z",
    )
    assert first == second
    assert first.status == "complete"
    assert first.candidate_count == first.dual_reviewed_count == 1
    assert not first.pending_review_ids and not first.disagreement_review_ids
    assert sha256_bytes(first.result_bytes) == first.result_sha256
    for exact_input in (a_bytes, b_bytes, original.files["coordinator.json"]):
        assert sha256_bytes(exact_input).encode() in first.result_bytes
    result = json.loads(first.result_bytes)
    for field in (
        "audit_fixture_authorized",
        "artifact_update_authorized",
        "quality_authorized",
        "publication_authorized",
    ):
        assert result[field] is False
    assert result["review_identity_boundary"] == (
        "self_declared_reviewers_and_blinding_not_authenticated"
    )
    assert b'"machine_claim"' not in first.result_bytes


def test_intake_rejects_answer_copy_that_changes_integer_to_equal_boolean() -> None:
    original = _prepare()
    answer = json.loads(_synthetic_answer(original.files["reviewer-a.json"], "a"))
    assert answer["candidate_count"] == 1
    answer["candidate_count"] = True
    with pytest.raises(ReviewIntakeError):
        ingest_blind_review_answers(
            original,
            answered_reviewer_a_bytes=json.dumps(answer).encode("utf-8"),
            answered_reviewer_b_bytes=None,
            incorporated_at="2026-09-05T03:00:00Z",
        )


def test_prepare_to_intake_performs_no_filesystem_network_or_process_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = _prepare()
    a_bytes = _synthetic_answer(original.files["reviewer-a.json"], "a")
    b_bytes = _synthetic_answer(original.files["reviewer-b.json"], "b")

    def unexpected_io(*args, **kwargs):
        pytest.fail("Pure answer intake attempted external I/O")

    with monkeypatch.context() as guarded:
        guarded.setattr("builtins.open", unexpected_io)
        guarded.setattr(Path, "open", unexpected_io)
        guarded.setattr(socket, "socket", unexpected_io)
        guarded.setattr(subprocess, "Popen", unexpected_io)
        result = ingest_blind_review_answers(
            original,
            answered_reviewer_a_bytes=a_bytes,
            answered_reviewer_b_bytes=b_bytes,
            incorporated_at="2026-09-05T03:00:00Z",
        )
    assert result.status == "complete"


@pytest.mark.parametrize(
    "shape", ["root", "keys", "candidates_type", "candidate_count", "candidate_row"]
)
def test_answer_shape_is_rejected_before_recursive_validation(
    shape: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = _prepare()
    answer = json.loads(_synthetic_answer(original.files["reviewer-a.json"], "a"))
    if shape == "root":
        answer = [answer]
    elif shape == "keys":
        answer["unexpected"] = []
    elif shape == "candidates_type":
        answer["candidates"] = {}
    elif shape == "candidate_row":
        answer["candidates"][0] = []
    else:
        answer["candidates"] *= 257

    def unexpected_traversal(*args, **kwargs):
        pytest.fail("Invalid outer shape must be rejected before depth/canonical traversal")

    monkeypatch.setattr(review_intake, "_validate_depth", unexpected_traversal)
    with pytest.raises(ReviewIntakeError, match=r"^answer_shape$"):
        ingest_blind_review_answers(
            original,
            answered_reviewer_a_bytes=json.dumps(answer).encode("utf-8"),
            answered_reviewer_b_bytes=None,
            incorporated_at="2026-09-05T03:00:00Z",
        )
