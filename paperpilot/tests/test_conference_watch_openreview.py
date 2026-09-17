from __future__ import annotations

import copy
import io
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from paperpilot.conference_watch.models import DetectionKind, ErrorCode, FetchLimits
from paperpilot.conference_watch.openreview import (
    OPENREVIEW_API_URL,
    OpenReviewV2Adapter,
    SecurePinnedTransport,
    TransportError,
    validate_fixed_endpoint,
)
from paperpilot.conference_watch.registry import load_registry, plan_editions
from paperpilot.paper_slides.fetch import PinnedResponse

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = (
    ROOT / "paperpilot" / "tests" / "fixtures" / "conference-watch" / "openreview-iclr-2026.json"
)
REGISTRY = ROOT / "paperpilot" / "data" / "conference-sources-v1.yaml"


class FakeResponse:
    def __init__(
        self, status_code=200, body=None, *, content=None, json_error=False, request_count=1
    ):
        self.status_code = status_code
        self._body = body
        self.content = (
            content
            if content is not None
            else json.dumps(body, separators=(",", ":")).encode("utf-8")
        )
        self._json_error = json_error
        self.request_count = request_count

    def json(self):
        if self._json_error:
            raise ValueError("invalid fixture JSON")
        return self._body


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, *, params, limits, deadline):
        self.calls.append((url, params, deadline))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def _edition():
    registry = load_registry(REGISTRY)
    registry = replace(registry, venues=(replace(registry.venues[0], enabled=True),))
    return plan_editions(
        registry,
        datetime(2026, 4, 1, tzinfo=timezone.utc),
    )[0]


def _pages():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["pages"]


def _adapter(pages, *, monotonic=lambda: 0.0):
    transport = FakeTransport([FakeResponse(body=page) for page in pages])
    return OpenReviewV2Adapter(transport, monotonic=monotonic), transport


def test_strict_adapter_collects_all_pages_and_normalizes_every_row():
    adapter, transport = _adapter(_pages())
    result = adapter.collect(_edition(), FetchLimits(page_size=2))
    assert result.kind is DetectionKind.SNAPSHOT
    snapshot = result.snapshot
    assert snapshot is not None
    assert snapshot.accepted_count == 3
    assert [row.source_id for row in snapshot.rows] == ["paperA1", "paperB2", "paperC3"]
    assert all(row.source == "openreview" and len(row.paper_id) == 40 for row in snapshot.rows)
    assert snapshot.rows[1].title == "A Poster Paper"
    assert snapshot.rows[0].authors == ("Alice",)
    assert snapshot.rows[0].landing_url == "https://openreview.net/forum?id=paperA1"
    assert snapshot.rows[0].pdf_url == "https://openreview.net/pdf?id=paperA1"
    assert snapshot.unknown_decisions == (("iclr 2026 accept", 1),)
    assert snapshot.duplicate_title_count == 0
    assert [call[1]["offset"] for call in transport.calls] == [0, 2]
    assert [call[2] for call in transport.calls] == [60.0, 60.0]


def test_probe_and_collect_share_deterministic_order_independent_fingerprint():
    pages = _pages()
    adapter_a, _ = _adapter(pages)
    first = adapter_a.probe(_edition(), FetchLimits(page_size=2))
    reversed_notes = copy.deepcopy(pages)
    reversed_notes[0]["notes"].reverse()
    adapter_b, _ = _adapter(reversed_notes)
    second = adapter_b.collect(_edition(), FetchLimits(page_size=2))
    assert first.snapshot is not None and second.snapshot is not None
    assert first.snapshot.source_fingerprint == second.snapshot.source_fingerprint

    changed = copy.deepcopy(pages)
    changed[0]["notes"][0]["content"]["title"]["value"] = "Changed"
    adapter_c, _ = _adapter(changed)
    third = adapter_c.collect(_edition(), FetchLimits(page_size=2))
    assert third.snapshot is not None
    assert third.snapshot.source_fingerprint != first.snapshot.source_fingerprint


def test_snapshot_metrics_distinguish_pages_from_retry_http_attempts():
    pages = _pages()
    transport = FakeTransport(
        [
            FakeResponse(body=pages[0], request_count=2),
            FakeResponse(body=pages[1], request_count=1),
        ]
    )
    result = OpenReviewV2Adapter(transport, monotonic=lambda: 0.0).collect(
        _edition(), FetchLimits(page_size=2)
    )
    assert result.snapshot is not None
    assert result.snapshot.page_count == 2
    assert result.snapshot.request_count == 3


def test_duplicate_titles_are_reported_but_native_ids_are_not_merged():
    pages = _pages()
    pages[0]["notes"][1]["content"]["title"]["value"] = "A Poster Paper"
    adapter, _ = _adapter(pages)
    result = adapter.collect(_edition(), FetchLimits(page_size=2))
    assert result.snapshot is not None
    assert result.snapshot.accepted_count == 3
    assert result.snapshot.duplicate_title_count == 1


@pytest.mark.parametrize(
    ("mutator", "code"),
    [
        (lambda pages: pages[1]["notes"][0].update(id="paperA1"), ErrorCode.DUPLICATE_ID),
        (
            lambda pages: pages[0]["notes"][0]["content"]["venueid"].update(
                value="ICLR.cc/2026/Conference/Withdrawn_Submission"
            ),
            ErrorCode.IDENTITY_MISSING,
        ),
        (
            lambda pages: pages[0]["notes"][0]["content"]["authors"].update(value=[]),
            ErrorCode.IDENTITY_MISSING,
        ),
        (
            lambda pages: pages[0]["notes"][0]["content"]["title"].update(value=""),
            ErrorCode.SOURCE_PARSE_ERROR,
        ),
    ],
)
def test_invalid_or_conflicting_row_fails_the_entire_snapshot(mutator, code):
    pages = _pages()
    mutator(pages)
    adapter, _ = _adapter(pages)
    result = adapter.collect(_edition(), FetchLimits(page_size=2))
    assert result.kind is DetectionKind.ERROR
    assert result.snapshot is None
    assert result.error_code is code


def test_mid_pagination_failure_never_returns_partial_rows():
    pages = _pages()
    transport = FakeTransport(
        [FakeResponse(body=pages[0]), TransportError(ErrorCode.SOURCE_TIMEOUT)]
    )
    result = OpenReviewV2Adapter(transport, monotonic=lambda: 0.0).collect(
        _edition(), FetchLimits(page_size=2)
    )
    assert result.kind is DetectionKind.ERROR
    assert result.snapshot is None
    assert result.error_code is ErrorCode.SOURCE_TIMEOUT


def test_count_drift_short_page_max_page_and_byte_limit_fail_closed():
    pages = _pages()
    drift = copy.deepcopy(pages)
    drift[1]["count"] = 4
    adapter, _ = _adapter(drift)
    assert (
        adapter.collect(_edition(), FetchLimits(page_size=2)).error_code is ErrorCode.SOURCE_PARTIAL
    )

    full = {"notes": pages[0]["notes"]}
    adapter, _ = _adapter([full])
    assert (
        adapter.collect(_edition(), FetchLimits(page_size=2, max_pages=1)).error_code
        is ErrorCode.SOURCE_PARTIAL
    )

    oversized = FakeTransport([FakeResponse(body={"count": 0, "notes": []}, content=b"x" * 11)])
    result = OpenReviewV2Adapter(oversized, monotonic=lambda: 0.0).collect(
        _edition(), FetchLimits(max_response_bytes=10)
    )
    assert result.error_code is ErrorCode.SOURCE_PARTIAL


def test_unavailable_empty_malformed_and_deadline_are_typed_without_rows():
    for response, expected_kind, expected_code in [
        (FakeResponse(404, {}), DetectionKind.UNAVAILABLE, ErrorCode.SOURCE_UNAVAILABLE),
        (
            FakeResponse(200, {"count": 0, "notes": []}),
            DetectionKind.UNAVAILABLE,
            ErrorCode.SOURCE_UNAVAILABLE,
        ),
        (FakeResponse(200, {}, json_error=True), DetectionKind.ERROR, ErrorCode.SOURCE_PARSE_ERROR),
    ]:
        result = OpenReviewV2Adapter(FakeTransport([response]), monotonic=lambda: 0.0).collect(
            _edition()
        )
        assert result.kind is expected_kind
        assert result.snapshot is None
        assert result.error_code is expected_code

    times = iter([0.0, 2.0])
    result = OpenReviewV2Adapter(FakeTransport([]), monotonic=lambda: next(times)).collect(
        _edition(), FetchLimits(job_deadline_seconds=1)
    )
    assert result.error_code is ErrorCode.SOURCE_TIMEOUT


class Resolver:
    def __init__(self, *addresses):
        self.addresses = addresses

    def resolve(self, hostname, port, *, timeout):
        return self.addresses


class PinnedFake:
    supports_ip_pinning = True

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def request(self, request):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class FailingReadResponse(PinnedResponse):
    def __init__(self, error):
        super().__init__(200, (), io.BytesIO(b"discard-me"))
        self.error = error

    def read(self, amount, *, timeout):
        raise self.error


def test_endpoint_policy_rejects_arbitrary_authority_and_private_resolution():
    validate_fixed_endpoint(OPENREVIEW_API_URL)
    for url in [
        "http://api2.openreview.net/notes",
        "https://user@api2.openreview.net/notes",
        "https://api2.openreview.net:444/notes",
        "https://example.com/notes",
        "https://api2.openreview.net/notes?url=http://127.0.0.1",
    ]:
        with pytest.raises(TransportError):
            validate_fixed_endpoint(url)
    transport = SecurePinnedTransport(
        resolver=Resolver("127.0.0.1"), transport=PinnedFake([]), monotonic=lambda: 0.0
    )
    with pytest.raises(TransportError):
        transport.get(OPENREVIEW_API_URL, params={}, limits=FetchLimits(), deadline=10)


def test_secure_transport_pins_ip_rejects_redirects_and_retries_429():
    sleeps = []
    pinned = PinnedFake(
        [
            PinnedResponse(429, (), io.BytesIO()),
            PinnedResponse(200, (("Content-Length", "2"),), io.BytesIO(b"{}")),
        ]
    )
    transport = SecurePinnedTransport(
        resolver=Resolver("93.184.216.34"),
        transport=pinned,
        sleep=sleeps.append,
        monotonic=lambda: 0.0,
    )
    result = transport.get(
        OPENREVIEW_API_URL,
        params={},
        limits=FetchLimits(),
        deadline=10_000,
    )
    assert result.status_code == 200
    assert result.request_count == 2
    assert sleeps == [1]
    assert all(request.ip_address == "93.184.216.34" for request in pinned.requests)
    assert all(request.hostname == "api2.openreview.net" for request in pinned.requests)
    assert all(request.headers["Accept-Encoding"] == "identity" for request in pinned.requests)

    redirecting = SecurePinnedTransport(
        resolver=Resolver("93.184.216.34"),
        transport=PinnedFake([PinnedResponse(302, (), io.BytesIO())]),
        monotonic=lambda: 0.0,
    )
    with pytest.raises(TransportError) as exc:
        redirecting.get(OPENREVIEW_API_URL, params={}, limits=FetchLimits(), deadline=10_000)
    assert exc.value.code is ErrorCode.SOURCE_HTTP_ERROR


def test_secure_transport_retries_connection_timeout_and_clamps_socket_timeouts():
    sleeps = []
    pinned = PinnedFake(
        [
            TimeoutError(),
            PinnedResponse(200, (("Content-Length", "2"),), io.BytesIO(b"{}")),
        ]
    )
    transport = SecurePinnedTransport(
        resolver=Resolver("93.184.216.34"),
        transport=pinned,
        sleep=sleeps.append,
        monotonic=lambda: 0.0,
    )
    result = transport.get(
        OPENREVIEW_API_URL,
        params={},
        limits=FetchLimits(connect_timeout_seconds=10, read_timeout_seconds=30),
        deadline=5,
    )
    assert result.request_count == 2
    assert sleeps == [0.25]
    assert all(request.connect_timeout == 5 for request in pinned.requests)
    assert all(request.read_timeout == 5 for request in pinned.requests)


@pytest.mark.parametrize(
    ("failure", "expected_sleep"),
    [(TimeoutError(), 0.25), (OSError("connection reset"), 0.25)],
)
def test_secure_transport_discards_and_retries_failed_response_body(failure, expected_sleep):
    failed_response = FailingReadResponse(failure)
    pinned = PinnedFake(
        [
            failed_response,
            PinnedResponse(200, (("Content-Length", "2"),), io.BytesIO(b"{}")),
        ]
    )
    sleeps = []
    transport = SecurePinnedTransport(
        resolver=Resolver("93.184.216.34"),
        transport=pinned,
        sleep=sleeps.append,
        monotonic=lambda: 0.0,
    )
    result = transport.get(OPENREVIEW_API_URL, params={}, limits=FetchLimits(), deadline=10)
    assert result.content == b"{}"
    assert result.request_count == 2
    assert failed_response.stream.closed
    assert sleeps == [expected_sleep]


@pytest.mark.parametrize(
    ("headers", "limit", "code"),
    [
        ((("Content-Length", "invalid"),), 128, ErrorCode.SOURCE_HTTP_ERROR),
        ((("Content-Length", "11"),), 10, ErrorCode.SOURCE_PARTIAL),
    ],
)
def test_secure_transport_does_not_retry_malformed_or_oversized_response(headers, limit, code):
    pinned = PinnedFake(
        [
            PinnedResponse(200, headers, io.BytesIO(b"x" * 11)),
            PinnedResponse(200, (("Content-Length", "2"),), io.BytesIO(b"{}")),
        ]
    )
    transport = SecurePinnedTransport(
        resolver=Resolver("93.184.216.34"),
        transport=pinned,
        monotonic=lambda: 0.0,
    )
    with pytest.raises(TransportError) as exc:
        transport.get(
            OPENREVIEW_API_URL,
            params={},
            limits=FetchLimits(max_response_bytes=limit),
            deadline=10,
        )
    assert exc.value.code is code
    assert len(pinned.requests) == 1


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("page_size", True),
        ("page_size", 1.0),
        ("max_pages", 26),
        ("max_notes", 25_001),
        ("max_response_bytes", 128 * 1024 * 1024 + 1),
        ("max_retries", False),
        ("max_retries", 4),
        ("connect_timeout_seconds", 10.001),
        ("read_timeout_seconds", 30.001),
        ("request_timeout_seconds", 60.001),
        ("job_deadline_seconds", 1200.001),
        ("read_timeout_seconds", float("inf")),
        ("request_timeout_seconds", float("nan")),
        ("job_deadline_seconds", True),
    ],
)
def test_fetch_limits_reject_type_confusion_nonfinite_and_contract_widening(field, value):
    with pytest.raises(ValueError):
        FetchLimits(**{field: value})
