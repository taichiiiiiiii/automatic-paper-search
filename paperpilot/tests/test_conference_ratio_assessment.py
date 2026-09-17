"""Pure assessment boundaries and non-authorizing report contract."""

import json
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import pytest

from paperpilot.conference_watch import baseline
from paperpilot.conference_watch.fingerprint import source_fingerprint
from paperpilot.conference_watch.models import NormalizedPaper, SourceSnapshot
from paperpilot.identity.source_ids import make_paper_id
from paperpilot.replay import canonical_json_bytes
from paperpilot.tests.test_conference_watch_baseline import _case


def _snapshot(edition, count):
    rows = tuple(
        NormalizedPaper(
            source="openreview",
            source_id=f"Current{i}",
            paper_id=make_paper_id("openreview", f"Current{i}"),
            title=f"Private title {i}",
            authors=("Private Author",),
            abstract="Private abstract",
            landing_url=f"https://openreview.net/forum?id=Current{i}",
            pdf_url=f"https://openreview.net/pdf?id=Current{i}",
            decision_label="poster",
        )
        for i in range(count)
    )
    return SourceSnapshot(
        schema_version="conference-source-snapshot-v1",
        edition_id=edition.edition_id,
        adapter=edition.adapter,
        adapter_version="1",
        source_id=edition.source_id,
        rows=rows,
        source_fingerprint=source_fingerprint(
            adapter_version="1",
            edition_id=edition.edition_id,
            source_id=edition.source_id,
            rows=rows,
        ),
        unknown_decisions=(),
        duplicate_title_count=0,
        request_count=1,
        page_count=1,
        response_bytes=100,
    )


def _assess(count=2, minimum=1, low=0.7, high=1.5, changes=None):
    registry, edition, state, catalog = _case()
    gate = replace(
        edition.count_gate,
        minimum_absolute=minimum,
        previous_edition_min_ratio=low,
        previous_edition_max_ratio=high,
    )
    edition = replace(edition, count_gate=gate)
    registry = replace(registry, venues=(replace(registry.venues[0], count_gate=gate),))
    snapshot = replace(_snapshot(edition, count), **(changes or {}))
    return baseline.assess_previous_edition_ratio(
        registry, edition, snapshot, state, previous_catalog_bytes=catalog
    )


@pytest.mark.parametrize(
    ("count", "minimum", "status"),
    [
        (1, 1, "passed"),
        (3, 1, "passed"),
        (4, 1, "above_maximum"),
        (1, 2, "below_minimum"),
        (3, 4, "below_minimum"),
    ],
)
def test_inclusive_bounds_and_absolute_minimum(count, minimum, status):
    result = _assess(count, minimum)
    assert result.status == status
    assert result.effective_minimum == minimum
    assert result.effective_maximum == 3
    assert result.current_count == count


def test_noninteger_ceil_and_binary_float_compatibility():
    assert _assess(high=1.1).effective_maximum == 3
    assert _assess(low=0.9999999999999999).effective_minimum == 1


def test_deterministic_frozen_private_report():
    result = _assess()
    assert result == _assess()
    with pytest.raises(FrozenInstanceError):
        result.status = "above_maximum"
    report = json.loads(result.report_bytes)
    assert result.report_bytes == canonical_json_bytes(report)
    assert report["scope"] == "local_assessment_only"
    assert len(report["authority"]) == 6
    assert all(value is False for value in report["authority"].values())
    assert b"Private" not in result.report_bytes
    assert b"Current0" not in result.report_bytes


@pytest.mark.parametrize(
    "changes",
    [
        {"source_fingerprint": "0" * 64},
        {"rows": ()},
        {"rows": []},
        {"request_count": True},
        {"duplicate_title_count": 1},
        {"unknown_decisions": (("private", 1),)},
        {"source_id": "Wrong.cc/2026/Conference"},
    ],
)
def test_invalid_snapshot_has_fixed_error(changes):
    with pytest.raises(baseline.PreviousEditionRatioAssessmentError) as exc:
        _assess(changes=changes)
    assert str(exc.value) == "CONF_BASELINE_SNAPSHOT_INVALID"


def test_no_io(monkeypatch):
    expected = _assess()

    def forbidden(*args, **kwargs):
        pytest.fail("assessment performed I/O")

    with monkeypatch.context() as scoped:
        for name in ("builtins.open", "io.open", "os.open", "socket.socket", "subprocess.Popen"):
            scoped.setattr(name, forbidden)
        assert _assess() == expected


def test_package_exports_and_closed_schema():
    import jsonschema

    import paperpilot.conference_watch as package

    assert package.assess_previous_edition_ratio is baseline.assess_previous_edition_ratio
    assert package.PreviousEditionRatioAssessment is baseline.PreviousEditionRatioAssessment
    schema = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "schemas"
            / "conference-baseline-assessment-v1.schema.json"
        ).read_text()
    )
    validator = jsonschema.Draft202012Validator(schema)
    for count in (1, 2, 4):
        report = json.loads(_assess(count, minimum=2).report_bytes)
        validator.validate(report)
        for key in report:
            missing = {name: value for name, value in report.items() if name != key}
            assert not validator.is_valid(missing)
        assert not validator.is_valid({**report, "private": "leak"})
        for key in report["authority"]:
            changed = {**report, "authority": {**report["authority"], key: True}}
            assert not validator.is_valid(changed)


def test_missing_snapshot_attribute_is_sanitized():
    registry, edition, state, catalog = _case()
    snapshot = _snapshot(edition, 2)
    object.__delattr__(snapshot, "rows")
    with pytest.raises(baseline.PreviousEditionRatioAssessmentError) as exc:
        baseline.assess_previous_edition_ratio(
            registry, edition, snapshot, state, previous_catalog_bytes=catalog
        )
    assert str(exc.value) == "CONF_BASELINE_SNAPSHOT_INVALID"


def test_same_title_ids_remain_distinct_and_inputs_are_unchanged():
    registry, edition, state, catalog = _case()
    snapshot = _snapshot(edition, 2)
    rows = tuple(replace(row, title="Same private title") for row in snapshot.rows)
    snapshot = replace(
        snapshot,
        rows=rows,
        duplicate_title_count=1,
        source_fingerprint=source_fingerprint(
            adapter_version="1",
            edition_id=edition.edition_id,
            source_id=edition.source_id,
            rows=rows,
        ),
    )
    before = repr((registry, edition, snapshot, state, catalog))
    result = baseline.assess_previous_edition_ratio(
        registry, edition, snapshot, state, previous_catalog_bytes=catalog
    )
    assert result.current_count == 2
    assert repr((registry, edition, snapshot, state, catalog)) == before
    assert (
        baseline.assess_previous_edition_ratio(
            registry,
            edition,
            replace(snapshot, rows=tuple(reversed(rows))),
            state,
            previous_catalog_bytes=catalog,
        )
        == result
    )


@pytest.mark.parametrize("position", range(4))
def test_public_api_rejects_wrong_outer_types(position):
    registry, edition, state, catalog = _case()
    values = [registry, edition, _snapshot(edition, 2), state]
    values[position] = None
    with pytest.raises(baseline.PreviousEditionRatioAssessmentError) as exc:
        baseline.assess_previous_edition_ratio(*values, previous_catalog_bytes=catalog)
    expected = "SNAPSHOT_INVALID" if position == 2 else "INPUT_INVALID"
    assert str(exc.value) == "CONF_BASELINE_" + expected
