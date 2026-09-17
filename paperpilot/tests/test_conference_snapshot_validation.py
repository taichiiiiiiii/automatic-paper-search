"""Independent acceptance checks for the shared, non-authorizing snapshot seam."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Any, cast

import pytest

from paperpilot.conference_watch import candidate
from paperpilot.conference_watch.candidate import CandidateErrorCode, CandidateValidationError
from paperpilot.conference_watch.models import CountGate, ReadinessPhase
from paperpilot.tests.test_conference_watch_candidate import _edition, _ready, _snapshot


def _validate(edition, snapshot):
    validator = getattr(candidate, "_validate_candidate_snapshot", None)
    assert callable(validator), "The shared snapshot validation seam has not been implemented"
    return validator(edition, snapshot)


def test_shared_snapshot_validation_preserves_projection_and_inputs():
    edition, snapshot = _edition(), _snapshot()
    original = (edition, snapshot, snapshot.rows)
    rows, unknown, duplicate_count = _validate(edition, snapshot)
    built = candidate.build_catalog_candidate(edition, _ready(snapshot), snapshot)
    assert rows == built.rows
    assert unknown == snapshot.unknown_decisions
    assert duplicate_count == snapshot.duplicate_title_count
    assert (edition, snapshot, snapshot.rows) == original
    assert _validate(edition, replace(snapshot, rows=tuple(reversed(snapshot.rows)))) == (
        rows,
        unknown,
        duplicate_count,
    )


def test_snapshot_validation_does_not_grant_minimum_or_readiness():
    snapshot = _snapshot()
    edition = replace(_edition(), count_gate=CountGate(4, 0.7, 1.5))
    rows, _, _ = _validate(edition, snapshot)
    assert len(rows) == 3
    with pytest.raises(CandidateValidationError) as exc:
        candidate.build_catalog_candidate(edition, _ready(snapshot), snapshot)
    assert str(exc.value) == "CONF_CANDIDATE_READINESS_INVALID:readiness.count"
    with pytest.raises(CandidateValidationError) as exc:
        candidate.build_catalog_candidate(
            _edition(), replace(_ready(snapshot), phase=ReadinessPhase.UNAVAILABLE), snapshot
        )
    assert str(exc.value) == "CONF_CANDIDATE_READINESS_INVALID:readiness.state"


@pytest.mark.parametrize("field", ["edition", "snapshot"])
@pytest.mark.parametrize("value", [None, object(), {}, 1])
def test_shared_snapshot_type_gate_is_sanitized(field, value):
    edition, snapshot = _edition(), _snapshot()
    if field == "edition":
        edition = value
    else:
        snapshot = value
    with pytest.raises(CandidateValidationError) as exc:
        _validate(edition, snapshot)
    assert str(exc.value) == "CONF_VALIDATION_FAILED:candidate.input"


@pytest.mark.parametrize(
    ("changes", "code", "field"),
    [
        ({"schema_version": "wrong"}, CandidateErrorCode.CANDIDATE_MISMATCH, "snapshot.header"),
        (
            {"source_id": "OTHER.cc/2026/Conference"},
            CandidateErrorCode.CANDIDATE_MISMATCH,
            "snapshot.header",
        ),
        ({"rows": []}, CandidateErrorCode.VALIDATION_FAILED, "snapshot.rows"),
        ({"request_count": True}, CandidateErrorCode.VALIDATION_FAILED, "snapshot.request_count"),
        ({"page_count": 26}, CandidateErrorCode.VALIDATION_FAILED, "snapshot.page_count"),
        (
            {"response_bytes": 128 * 1024 * 1024 + 1},
            CandidateErrorCode.VALIDATION_FAILED,
            "snapshot.response_bytes",
        ),
        ({"unknown_decisions": ()}, CandidateErrorCode.CANDIDATE_MISMATCH, "snapshot.statistics"),
        (
            {"duplicate_title_count": 1},
            CandidateErrorCode.CANDIDATE_MISMATCH,
            "snapshot.statistics",
        ),
        (
            {"source_fingerprint": "0" * 64},
            CandidateErrorCode.CANDIDATE_MISMATCH,
            "snapshot.fingerprint",
        ),
    ],
)
def test_shared_snapshot_keeps_existing_error_codes_and_fields(changes, code, field):
    snapshot = replace(_snapshot(), **changes)
    with pytest.raises(CandidateValidationError) as exc:
        _validate(_edition(), snapshot)
    assert exc.value.code is code
    assert exc.value.field == field
    assert str(exc.value) == f"{code.value}:{field}"


def test_shared_snapshot_revalidates_identity_before_fingerprint():
    snapshot = _snapshot()
    first = replace(snapshot.rows[0], pdf_url="https://example.invalid/private-paper")
    snapshot = replace(snapshot, rows=(first, *snapshot.rows[1:]), source_fingerprint="0" * 64)
    with pytest.raises(CandidateValidationError) as exc:
        _validate(_edition(), snapshot)
    assert str(exc.value) == "CONF_IDENTITY_CONFLICT:snapshot.row_identity"


def test_shared_snapshot_sanitizes_fingerprint_failure(monkeypatch):
    snapshot = _snapshot()

    def failing_fingerprint(**kwargs):
        raise ValueError("private upstream material")

    monkeypatch.setattr(candidate, "source_fingerprint", failing_fingerprint)
    with pytest.raises(CandidateValidationError) as exc:
        _validate(_edition(), snapshot)
    assert str(exc.value) == "CONF_VALIDATION_FAILED:snapshot.fingerprint"


def test_candidate_calls_shared_validator_once_and_keeps_outer_type_gate(monkeypatch):
    edition, snapshot = _edition(), _snapshot()
    state = _ready(snapshot)
    validator = getattr(candidate, "_validate_candidate_snapshot", None)
    assert callable(validator)
    calls = []

    def counted(*args):
        calls.append(args)
        return validator(*args)

    monkeypatch.setattr(candidate, "_validate_candidate_snapshot", counted)
    candidate.build_catalog_candidate(edition, state, snapshot)
    assert calls == [(edition, snapshot)]
    with pytest.raises(CandidateValidationError) as exc:
        candidate.build_catalog_candidate(edition, cast(Any, None), snapshot)
    assert str(exc.value) == "CONF_VALIDATION_FAILED:candidate.input"
    assert len(calls) == 1


def test_shared_snapshot_rejects_dataclass_subclasses():
    edition, snapshot = _edition(), _snapshot()
    for original, other in ((edition, snapshot), (snapshot, edition)):
        subclass = type("Derived", (type(original),), {})
        derived = subclass(**vars(original))
        args = (derived, other) if original is edition else (other, derived)
        with pytest.raises(CandidateValidationError) as exc:
            _validate(*args)
        assert str(exc.value) == "CONF_VALIDATION_FAILED:candidate.input"


def test_shared_snapshot_does_not_use_io_or_readiness(monkeypatch):
    edition, snapshot = _edition(), _snapshot()

    def forbidden(*args, **kwargs):
        pytest.fail("Shared snapshot validation must remain pure and independent of readiness")

    with monkeypatch.context() as scoped:
        scoped.setattr("builtins.open", forbidden)
        scoped.setattr("io.open", forbidden)
        scoped.setattr("os.open", forbidden)
        scoped.setattr("socket.socket", forbidden)
        scoped.setattr("subprocess.Popen", forbidden)
        scoped.setattr(candidate, "_validate_readiness", forbidden)
        assert len(_validate(edition, snapshot)[0]) == 3


def test_candidate_five_transport_payloads_match_pre_refactor_golden():
    snapshot = _snapshot()
    built = candidate.build_catalog_candidate(_edition(), _ready(snapshot), snapshot)
    expected = {
        "catalog_rows_bytes": "c9a4c1c4c6255ae2878aa4f9ba85d1b55b5e471ddeedcd4d7f62e270fc3db499",
        "details_bytes": "daa8737fe1a00442010fad2cad761a865aa931eb34801c55134eec61f253a870",
        "summary_csv_bytes": "aed8dc3642a205d807d35c11777436890bfaf5605fb42b3bcc6d0552c9aec0aa",
        "source_quality_bytes": "4cdda5a121f9e8c01a5643c7eb797e8b8b4f90eed911489c112060d32c4fa43d",
        "run_binding_bytes": "63793c142136eded6c0fc0174e113858fa36233a66180f355297a6eca455a741",
    }
    assert {key: hashlib.sha256(getattr(built, key)).hexdigest() for key in expected} == expected
    quality = json.loads(built.source_quality_bytes)
    assert quality["gates"]["previous_edition_ratio"] == "not_checked"
    binding = json.loads(built.run_binding_bytes)
    for flag in (
        "trusted_persistent_state_proof",
        "promotion_authorized",
        "publication_authorized",
    ):
        assert binding[flag] is False
