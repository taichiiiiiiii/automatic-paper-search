import pytest

from paperpilot.conference_watch.models import DetectionKind, DetectionResult, ErrorCode
from paperpilot.conference_watch.stability import observation_from_detection
from paperpilot.tests.test_conference_watch_stability import T0, _edition, _result, _row


@pytest.mark.parametrize(
    "value",
    [True, False, 1.0, "1", -1, 25_001, 10**10_000],
    ids=["true", "false", "float", "str", "neg", "over_max", "huge_int"],
)
@pytest.mark.parametrize(
    "result",
    [
        _result(),
        DetectionResult(DetectionKind.UNAVAILABLE, error_code=ErrorCode.SOURCE_UNAVAILABLE),
        DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT),
    ],
)
def test_invalid_previous_edition_count(value, result):
    with pytest.raises(ValueError, match=r"^previous_edition_count_invalid$"):
        observation_from_detection(
            _edition(), result, observed_at=T0, run_id="run-count", previous_edition_count=value
        )


@pytest.mark.parametrize(
    "value,expected_status,expected_error_code",
    [
        (None, "stabilizing", None),
        (0, "anomaly", ErrorCode.COUNT_ABOVE_MAXIMUM),
        (25_000, "partial", ErrorCode.COUNT_BELOW_MINIMUM),
        (2, "stabilizing", None),
    ],
)
def test_valid_previous_edition_count(value, expected_status, expected_error_code):
    obs = observation_from_detection(
        _edition(), _result(), observed_at=T0, run_id="run-count", previous_edition_count=value
    )
    assert obs.status.value == expected_status
    assert obs.error_code == expected_error_code


def test_previous_two_and_four_rows() -> None:
    import copy

    edition = _edition()
    result = _result(_row("a"), _row("b"), _row("c"), _row("d"))
    edition_before = copy.deepcopy(edition)
    result_before = copy.deepcopy(result)
    obs = observation_from_detection(
        edition, result, observed_at=T0, run_id="run-count", previous_edition_count=2
    )
    assert edition == edition_before
    assert result == result_before
    assert obs.status.value == "anomaly"
    assert obs.error_code == ErrorCode.COUNT_ABOVE_MAXIMUM


def test_reject_int_subclass() -> None:
    class Count(int):
        pass

    edition = _edition()
    result = _result(_row("a"))
    with pytest.raises(ValueError, match=r"^previous_edition_count_invalid$"):
        observation_from_detection(
            edition, result, observed_at=T0, run_id="run-subclass", previous_edition_count=Count(2)
        )
