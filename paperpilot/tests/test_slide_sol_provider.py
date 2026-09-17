"""Closed-wire and fail-safe tests for the real Sol adapter."""

from __future__ import annotations

import copy
import json

import pytest

import paperpilot.paper_slides.sol_provider as sol_provider_module
from paperpilot.paper_slides.generator_prompt import UntrustedPromptRecord, plan_chunk_summary_calls
from paperpilot.paper_slides.sol_provider import (
    MAX_RESPONSE_BYTES,
    SOL_HOST,
    SOL_MODEL,
    SolHttpResponse,
    SolProvider,
    SolProviderError,
    _PinnedPostConnection,
)
from paperpilot.replay import canonical_json_bytes


class FakeTransport:
    def __init__(self, responses: list[object]) -> None:
        self.responses = responses
        self.calls = 0
        self.bodies: list[bytes] = []
        self.headers: list[dict[str, str]] = []
        self.timeouts: list[int] = []

    def post(self, body: bytes, *, headers, timeout_ms: int) -> SolHttpResponse:
        self.calls += 1
        self.bodies.append(body)
        self.headers.append(dict(headers))
        self.timeouts.append(timeout_ms)
        value = self.responses.pop(0)
        if isinstance(value, BaseException):
            raise value
        assert isinstance(value, SolHttpResponse)
        return value


def _request():
    return plan_chunk_summary_calls(
        (UntrustedPromptRecord("abstract", "Grounded abstract evidence. " * 24),),
        language="ja",
    ).calls[0]


def _output_payload() -> bytes:
    return canonical_json_bytes(
        {
            "schema_version": "chunk-summary-v1",
            "claims": [
                {
                    "claim_id": "k01",
                    "claim_kind": "method",
                    "text": "Grounded method claim.",
                    "record_ids": ["abstract"],
                }
            ],
        }
    )


def _response_body(**overrides: object) -> bytes:
    payload: dict[str, object] = {
        "id": "resp_fixture_1",
        "status": "completed",
        "incomplete_details": None,
        "error": None,
        "model": SOL_MODEL,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": _output_payload().decode("utf-8")}],
            }
        ],
        "usage": {
            "input_tokens": 17,
            "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 3},
            "output_tokens": 9,
            "total_tokens": 26,
            "output_tokens_details": {"reasoning_tokens": 4},
        },
    }
    payload.update(overrides)
    return canonical_json_bytes(payload)


def _response(body: bytes | None = None, *, status: int = 200) -> SolHttpResponse:
    value = body if body is not None else _response_body()
    return SolHttpResponse(
        status=status,
        headers=(
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(value))),
        ),
        body=value,
    )


def test_adapter_builds_closed_structured_outputs_wire_and_reports_actual_usage() -> None:
    transport = FakeTransport([_response()])
    provider = SolProvider("unit-test-secret", transport)
    request = _request()

    reservation = provider.count_tokens(request, remaining_wall_ms=10_000)
    result = provider.generate_json(request, max_output_tokens=2_000, remaining_wall_ms=9_000)

    assert transport.calls == 1
    assert result.input_tokens == 17
    assert result.output_tokens == 9
    assert reservation > result.input_tokens
    assert result.payload == _output_payload()
    assert "unit-test-secret" not in repr(provider)
    wire = json.loads(transport.bodies[0])
    assert wire["model"] == SOL_MODEL
    assert wire["prompt_cache_options"] == {"mode": "explicit"}
    assert wire["store"] is False
    assert wire["stream"] is False
    assert wire["background"] is False
    assert wire["tools"] == []
    assert wire["truncation"] == "disabled"
    assert wire["service_tier"] == "default"
    assert wire["reasoning"] == {"effort": "medium"}
    assert wire["text"]["format"]["type"] == "json_schema"
    assert wire["text"]["format"]["strict"] is True
    schema = wire["text"]["format"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert transport.headers[0]["Host"] == SOL_HOST
    assert transport.headers[0]["Accept-Encoding"] == "identity"
    assert transport.headers[0]["Authorization"] == "Bearer unit-test-secret"
    assert transport.timeouts == [9_000]


def test_adapter_accepts_only_bounded_empty_reasoning_metadata_before_message() -> None:
    value = json.loads(_response_body())
    message = value["output"][0]
    value["output"] = [
        {
            "encrypted_content": "opaque-secret-reasoning-metadata",
            "id": "rs_fixture_1",
            "type": "reasoning",
            "summary": [],
            "status": None,
        },
        message,
    ]
    transport = FakeTransport([_response(canonical_json_bytes(value))])

    result = SolProvider("unit-test-secret", transport).generate_json(
        _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
    )

    assert result.payload == _output_payload()
    assert transport.calls == 1
    assert b"opaque-secret-reasoning-metadata" not in result.payload
    assert "opaque-secret-reasoning-metadata" not in repr(result)

    value["output"][0]["summary"] = [{"type": "summary_text", "text": "hidden prose"}]
    transport = FakeTransport([_response(canonical_json_bytes(value))])
    with pytest.raises(SolProviderError, match="provider_output_invalid") as captured:
        SolProvider("unit-test-secret", transport).generate_json(
            _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
        )
    assert "hidden prose" not in str(captured.value)

    value["output"][0]["summary"] = []
    value["output"][0]["status"] = []
    transport = FakeTransport([_response(canonical_json_bytes(value))])
    with pytest.raises(SolProviderError, match="provider_output_invalid"):
        SolProvider("unit-test-secret", transport).generate_json(
            _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
        )

    value["output"][0]["status"] = None
    value["output"][0]["encrypted_content"] = {"opaque": "metadata"}
    transport = FakeTransport([_response(canonical_json_bytes(value))])
    with pytest.raises(SolProviderError, match="provider_output_invalid"):
        SolProvider("unit-test-secret", transport).generate_json(
            _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
        )


@pytest.mark.parametrize(
    ("response", "issue"),
    [
        (_response(status=302), "provider_redirect_rejected"),
        (_response(status=429), "provider_rate_limited"),
        (_response(status=503), "provider_server_error"),
        (
            _response(_response_body(status="incomplete", incomplete_details={"reason": "max"})),
            "provider_response_invalid",
        ),
        (_response(_response_body(model="other-model")), "provider_response_invalid"),
        (
            _response(
                _response_body(output=[{"type": "function_call", "name": "bad", "arguments": "{}"}])
            ),
            "provider_output_invalid",
        ),
        (
            _response(
                _response_body(
                    output=[
                        {
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                            "content": [{"type": "refusal", "refusal": "no"}],
                        }
                    ]
                )
            ),
            "provider_output_invalid",
        ),
        (
            _response(
                _response_body(
                    usage={
                        "input_tokens": True,
                        "output_tokens": 9,
                        "total_tokens": 10,
                        "output_tokens_details": {"reasoning_tokens": 4},
                    }
                )
            ),
            "provider_usage_invalid",
        ),
        (
            SolHttpResponse(
                200,
                (("Content-Type", "application/json"),),
                b"x" * (MAX_RESPONSE_BYTES + 1),
            ),
            "response_oversize",
        ),
    ],
)
def test_adapter_rejects_unsafe_or_incomplete_responses_without_retry(
    response: SolHttpResponse, issue: str
) -> None:
    transport = FakeTransport([response])
    provider = SolProvider("unit-test-secret", transport)

    with pytest.raises(SolProviderError) as captured:
        provider.generate_json(_request(), max_output_tokens=2_000, remaining_wall_ms=9_000)

    assert captured.value.issue_code == issue
    assert transport.calls == 1
    assert "no" not in str(captured.value)


@pytest.mark.parametrize(
    ("failure", "issue"),
    [
        (TimeoutError("raw secret timeout"), "provider_timeout"),
        (OSError("raw body"), "transport_failed"),
    ],
)
def test_adapter_redacts_transport_failures_without_retry(
    failure: BaseException, issue: str
) -> None:
    transport = FakeTransport([failure])
    with pytest.raises(SolProviderError) as captured:
        SolProvider("unit-test-secret", transport).generate_json(
            _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
        )
    assert captured.value.issue_code == issue
    assert transport.calls == 1
    assert "secret" not in str(captured.value)
    assert "raw" not in str(captured.value)


def test_adapter_rejects_invalid_usage_relationships() -> None:
    base = json.loads(_response_body())
    cases = []
    for usage in (
        {
            "input_tokens": 1,
            "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 0},
            "output_tokens": 2,
            "total_tokens": 4,
            "output_tokens_details": {"reasoning_tokens": 0},
        },
        {
            "input_tokens": 1,
            "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 0},
            "output_tokens": 2,
            "total_tokens": 3,
            "output_tokens_details": {"reasoning_tokens": 3},
        },
    ):
        candidate = copy.deepcopy(base)
        candidate["usage"] = usage
        cases.append(_response(canonical_json_bytes(candidate)))
    transport = FakeTransport(cases)
    provider = SolProvider("unit-test-secret", transport)
    for _ in cases.copy():
        with pytest.raises(SolProviderError, match="provider_usage_invalid"):
            provider.generate_json(_request(), max_output_tokens=2_000, remaining_wall_ms=9_000)
    assert transport.calls == 2


@pytest.mark.parametrize(
    "input_details",
    [
        None,
        {"cached_tokens": 0},
        {"cache_write_tokens": 0, "cached_tokens": False},
        {"cache_write_tokens": 1, "cached_tokens": 0},
        {"cache_write_tokens": 0, "cached_tokens": 18},
        {"cache_write_tokens": 0, "cached_tokens": 0, "future": 0},
    ],
)
def test_adapter_rejects_unaccounted_or_malformed_cache_usage(input_details: object) -> None:
    value = json.loads(_response_body())
    value["usage"]["input_tokens_details"] = input_details
    transport = FakeTransport([_response(canonical_json_bytes(value))])

    with pytest.raises(SolProviderError, match="provider_usage_invalid"):
        SolProvider("unit-test-secret", transport).generate_json(
            _request(), max_output_tokens=2_000, remaining_wall_ms=9_000
        )

    assert transport.calls == 1


def test_connection_refreshes_deadline_before_tcp_tls_and_each_write(monkeypatch) -> None:
    now = [0.0]

    class FakeSocket:
        def __init__(self) -> None:
            self.timeouts: list[float] = []
            self.sent: list[bytes] = []
            self.closed = False

        def settimeout(self, value: float) -> None:
            self.timeouts.append(value)

        def connect(self, destination) -> None:
            assert destination == ("93.184.216.34", 443)
            now[0] = 2.0

        def setsockopt(self, *args) -> None:
            assert args

        def sendall(self, data: bytes) -> None:
            self.sent.append(data)

        def close(self) -> None:
            self.closed = True

    class FakeContext:
        def wrap_socket(self, raw_socket, *, server_hostname: str):
            assert raw_socket is raw
            assert server_hostname == SOL_HOST
            now[0] = 5.0
            return raw_socket

    raw = FakeSocket()
    monkeypatch.setattr(sol_provider_module.socket, "socket", lambda *_args: raw)
    connection = _PinnedPostConnection(
        "93.184.216.34",
        deadline=10.0,
        monotonic=lambda: now[0],
        context=FakeContext(),  # type: ignore[arg-type]
    )

    connection.connect()
    connection.send(b"request body")

    assert raw.timeouts == [10.0, 8.0, 5.0]
    assert raw.sent == [b"request body"]
    now[0] = 10.0
    with pytest.raises(SolProviderError, match="provider_timeout"):
        connection.send(b"late body")
    assert raw.sent == [b"request body"]
