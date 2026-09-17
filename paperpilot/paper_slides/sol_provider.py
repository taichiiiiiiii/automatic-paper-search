"""Closed OpenAI Responses adapter for the local PaperPilot Sol pilot.

The adapter accepts only generator-owned :class:`SlidePromptRequest` objects,
constructs a fixed Structured Outputs request, and returns only validated JSON
plus hashed request metadata. It has no retry, redirect, proxy, netrc, streaming,
background, tool, or fallback path.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import socket
import ssl
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, NoReturn, Protocol, TypeGuard

from paperpilot.paper_slides.contract import PAPER_SLIDE_PROVIDER_FAILED
from paperpilot.paper_slides.fetch import DNSResolver, SystemDNSResolver
from paperpilot.paper_slides.generate import ProviderJsonResponse, provider_request_sha256
from paperpilot.paper_slides.generator_budget import ProviderIdentity
from paperpilot.paper_slides.generator_contract import MAX_PROVIDER_PAYLOAD_BYTES
from paperpilot.paper_slides.generator_prompt import (
    CHUNK_SUMMARY_OUTPUT_CONTRACT,
    DECK_CONTENT_OUTPUT_CONTRACT,
    SlidePromptRequest,
    canonical_prompt_data_bytes,
)
from paperpilot.replay import canonical_json_bytes, strict_json_loads

SOL_ENDPOINT = "https://api.openai.com/v1/responses"
SOL_HOST = "api.openai.com"
SOL_PATH = "/v1/responses"
SOL_MODEL = "gpt-5.6-sol"
SOL_ADAPTER_VERSION = "openai-responses-sol-v1"
SOL_IDENTITY = ProviderIdentity("openai", SOL_MODEL, SOL_ADAPTER_VERSION)

MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_RESPONSE_HEADERS = 128
MAX_TOTAL_HEADER_BYTES = 64 * 1024
MAX_TIMEOUT_MS = 180_000
MAX_OUTPUT_TOKENS = 4_000
READ_CHUNK_BYTES = 64 * 1024
TOKEN_ESTIMATE_OVERHEAD = 512

_JSON_CONTENT_TYPE = "application/json"
_CLAIM_IDS = tuple(f"k{number:02d}" for number in range(1, 13))
_CLAIM_KINDS = ("problem", "method", "evidence", "limitation", "conclusion")
_SLIDE_KINDS = (
    "title",
    "problem",
    "method",
    "evidence",
    "limitations",
    "conclusion",
    "context",
)


class SolProviderError(RuntimeError):
    """Stable adapter failure that never contains credentials or provider prose."""

    def __init__(self, issue_code: str) -> None:
        self.error_code = PAPER_SLIDE_PROVIDER_FAILED
        self.issue_code = issue_code
        super().__init__(f"{self.error_code}:{issue_code}")


def _fail(issue_code: str) -> NoReturn:
    raise SolProviderError(issue_code) from None


@dataclass(frozen=True, slots=True)
class SolHttpResponse:
    """Bounded transport response; the body is deliberately hidden from repr."""

    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes = field(repr=False)


class SolHttpTransport(Protocol):
    """One-shot POST transport injected for deterministic adapter tests."""

    def post(
        self, body: bytes, *, headers: Mapping[str, str], timeout_ms: int
    ) -> SolHttpResponse: ...


class _PinnedPostConnection(http.client.HTTPConnection):
    default_port = 443

    def __init__(
        self,
        ip_address: str,
        *,
        deadline: float,
        monotonic: Callable[[], float],
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(SOL_HOST, 443, timeout=None)
        self._ip_address = ip_address
        self._deadline = deadline
        self._monotonic = monotonic
        self._context = context

    def _remaining(self) -> float:
        remaining = self._deadline - self._monotonic()
        if remaining <= 0:
            _fail("provider_timeout")
        return remaining

    def connect(self) -> None:
        address = ipaddress.ip_address(self._ip_address)
        family = socket.AF_INET if address.version == 4 else socket.AF_INET6
        raw_socket = socket.socket(family, socket.SOCK_STREAM)
        try:
            raw_socket.settimeout(min(10.0, self._remaining()))
            destination: tuple[Any, ...] = (
                (self._ip_address, 443)
                if family == socket.AF_INET
                else (self._ip_address, 443, 0, 0)
            )
            raw_socket.connect(destination)
            raw_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            raw_socket.settimeout(self._remaining())
            self.sock = self._context.wrap_socket(raw_socket, server_hostname=SOL_HOST)
        except BaseException:
            raw_socket.close()
            raise

    def send(self, data: Any) -> None:
        """Refresh the total deadline before each blocking header/body write."""

        if self.sock is None:
            self.connect()
        if self.sock is None:
            _fail("transport_failed")
        self.sock.settimeout(self._remaining())
        super().send(data)


class StdlibSolTransport:
    """DNS-pinned stdlib POST with bounded reads and no ambient HTTP settings."""

    def __init__(
        self,
        *,
        resolver: DNSResolver | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._resolver = resolver or SystemDNSResolver()
        self._monotonic = monotonic

    def post(self, body: bytes, *, headers: Mapping[str, str], timeout_ms: int) -> SolHttpResponse:
        if (
            type(body) is not bytes
            or not body
            or len(body) > MAX_REQUEST_BYTES
            or type(timeout_ms) is not int
            or not 1 <= timeout_ms <= MAX_TIMEOUT_MS
            or type(headers) is not dict
        ):
            _fail("transport_request_invalid")
        checked_headers = self._headers(headers)
        if int(checked_headers["Content-Length"]) != len(body):
            _fail("transport_request_invalid")
        deadline = self._monotonic() + timeout_ms / 1_000
        connection: _PinnedPostConnection | None = None
        response: http.client.HTTPResponse | None = None
        try:
            remaining = self._remaining(deadline)
            addresses = self._resolver.resolve(SOL_HOST, 443, timeout=min(10.0, remaining))
            pinned = self._public_addresses(addresses)
            context = ssl.create_default_context()
            connection = _PinnedPostConnection(
                pinned[0],
                deadline=deadline,
                monotonic=self._monotonic,
                context=context,
            )
            connection.connect()
            connection.request(
                "POST",
                SOL_PATH,
                body=body,
                headers=checked_headers,
                encode_chunked=False,
            )
            if connection.sock is not None:
                connection.sock.settimeout(self._remaining(deadline))
            response = connection.getresponse()
            response_headers = tuple((name, value) for name, value in response.getheaders())
            content_length = self._validate_response_headers(response_headers)
            if content_length is not None and content_length > MAX_RESPONSE_BYTES:
                _fail("response_oversize")
            payload = bytearray()
            while True:
                if connection.sock is not None:
                    connection.sock.settimeout(self._remaining(deadline))
                chunk = response.read(min(READ_CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - len(payload)))
                if type(chunk) is not bytes:
                    _fail("transport_response_invalid")
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > MAX_RESPONSE_BYTES:
                    _fail("response_oversize")
            if content_length is not None and content_length != len(payload):
                _fail("transport_response_invalid")
            self._remaining(deadline)
            return SolHttpResponse(response.status, response_headers, bytes(payload))
        except (KeyboardInterrupt, SystemExit, SolProviderError):
            raise
        except TimeoutError:
            _fail("provider_timeout")
        except BaseException:
            _fail("transport_failed")
        finally:
            if response is not None:
                with suppress(Exception):
                    response.close()
            if connection is not None:
                with suppress(Exception):
                    connection.close()

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            _fail("provider_timeout")
        return remaining

    @staticmethod
    def _public_addresses(values: Sequence[str]) -> tuple[str, ...]:
        try:
            result = tuple(dict.fromkeys(str(value) for value in values))
            if not result or not all(ipaddress.ip_address(value).is_global for value in result):
                _fail("transport_failed")
            return result
        except SolProviderError:
            raise
        except BaseException:
            _fail("transport_failed")

    @staticmethod
    def _headers(headers: Mapping[str, str]) -> dict[str, str]:
        expected = {
            "Accept",
            "Accept-Encoding",
            "Authorization",
            "Content-Length",
            "Content-Type",
            "Host",
        }
        if set(headers) != expected:
            _fail("transport_request_invalid")
        result: dict[str, str] = {}
        for name, value in headers.items():
            if (
                type(name) is not str
                or type(value) is not str
                or not name
                or not value
                or len(name) > 128
                or len(value) > 8_192
                or "\r" in name
                or "\n" in name
                or "\r" in value
                or "\n" in value
            ):
                _fail("transport_request_invalid")
            result[name] = value
        if (
            result["Accept"] != _JSON_CONTENT_TYPE
            or result["Accept-Encoding"] != "identity"
            or result["Content-Type"] != _JSON_CONTENT_TYPE
            or result["Host"] != SOL_HOST
            or not result["Content-Length"].isascii()
            or not result["Content-Length"].isdigit()
        ):
            _fail("transport_request_invalid")
        return result

    @staticmethod
    def _validate_response_headers(headers: tuple[tuple[str, str], ...]) -> int | None:
        if type(headers) is not tuple or len(headers) > MAX_RESPONSE_HEADERS:
            _fail("transport_response_invalid")
        total = 0
        lengths: list[str] = []
        encodings: list[str] = []
        for item in headers:
            if type(item) is not tuple or len(item) != 2:
                _fail("transport_response_invalid")
            name, value = item
            if (
                type(name) is not str
                or type(value) is not str
                or len(name) > 128
                or len(value) > 8_192
                or "\r" in name
                or "\n" in name
                or "\r" in value
                or "\n" in value
            ):
                _fail("transport_response_invalid")
            total += len(name.encode("utf-8")) + len(value.encode("utf-8"))
            if total > MAX_TOTAL_HEADER_BYTES:
                _fail("transport_response_invalid")
            if name.casefold() == "content-length":
                lengths.append(value.strip())
            elif name.casefold() == "content-encoding":
                encodings.append(value.strip().casefold())
        if len(lengths) > 1 or len(encodings) > 1:
            _fail("transport_response_invalid")
        if encodings and encodings[0] != "identity":
            _fail("transport_response_invalid")
        if not lengths:
            return None
        if not lengths[0].isascii() or not lengths[0].isdigit():
            _fail("transport_response_invalid")
        return int(lengths[0])


def _record_ids(request: SlidePromptRequest) -> tuple[str, ...]:
    if request.untrusted_records:
        return tuple(record.record_id for record in request.untrusted_records)
    return tuple(
        dict.fromkeys(record_id for claim in request.prior_claims for record_id in claim.record_ids)
    )


def _statement_schema(record_ids: tuple[str, ...]) -> dict[str, object]:
    return {
        "type": "object",
        "properties": {
            "text": {"type": "string", "minLength": 1, "maxLength": 2_000},
            "record_ids": {
                "type": "array",
                "items": {"type": "string", "enum": list(record_ids)},
                "minItems": 1,
                "maxItems": len(record_ids),
            },
        },
        "required": ["text", "record_ids"],
        "additionalProperties": False,
    }


def _slide_schema(record_ids: tuple[str, ...]) -> dict[str, object]:
    statement = _statement_schema(record_ids)
    variants: list[dict[str, object]] = [
        {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "const": "title"},
                "title": {"type": "string", "const": "title"},
                "bullets": {"type": "array", "items": statement, "maxItems": 0},
                "speaker_notes": {"type": "array", "items": statement, "maxItems": 0},
            },
            "required": ["kind", "title", "bullets", "speaker_notes"],
            "additionalProperties": False,
        }
    ]
    for kind in _SLIDE_KINDS:
        if kind == "title":
            continue
        variants.append(
            {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "const": kind},
                    "title": {"type": "string", "const": kind},
                    "bullets": {
                        "type": "array",
                        "items": statement,
                        "minItems": 1,
                        "maxItems": 12,
                    },
                    "speaker_notes": {
                        "type": "array",
                        "items": statement,
                        "maxItems": 8,
                    },
                },
                "required": ["kind", "title", "bullets", "speaker_notes"],
                "additionalProperties": False,
            }
        )
    return {"anyOf": variants}


def _structured_schema(request: SlidePromptRequest) -> tuple[str, dict[str, object]]:
    record_ids = _record_ids(request)
    if not record_ids:
        _fail("provider_request_invalid")
    if request.output_contract == CHUNK_SUMMARY_OUTPUT_CONTRACT:
        schema = {
            "type": "object",
            "properties": {
                "schema_version": {"type": "string", "const": CHUNK_SUMMARY_OUTPUT_CONTRACT},
                "claims": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "claim_id": {"type": "string", "enum": list(_CLAIM_IDS)},
                            "claim_kind": {"type": "string", "enum": list(_CLAIM_KINDS)},
                            "text": {"type": "string", "minLength": 1, "maxLength": 1_000},
                            "record_ids": {
                                "type": "array",
                                "items": {"type": "string", "enum": list(record_ids)},
                                "minItems": 1,
                                "maxItems": len(record_ids),
                            },
                        },
                        "required": ["claim_id", "claim_kind", "text", "record_ids"],
                        "additionalProperties": False,
                    },
                    "minItems": 1,
                    "maxItems": 12,
                },
            },
            "required": ["schema_version", "claims"],
            "additionalProperties": False,
        }
        return "paper_slide_chunk_summary", schema
    if request.output_contract == DECK_CONTENT_OUTPUT_CONTRACT:
        abstract_only = record_ids == ("abstract",)
        schema = {
            "type": "object",
            "properties": {
                "schema_version": {"type": "string", "const": DECK_CONTENT_OUTPUT_CONTRACT},
                "slides": {
                    "type": "array",
                    "items": _slide_schema(record_ids),
                    "minItems": 4 if abstract_only else 6,
                    "maxItems": 6 if abstract_only else 10,
                },
                "limitations": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1, "maxLength": 2_000},
                    "maxItems": 0,
                },
            },
            "required": ["schema_version", "slides", "limitations"],
            "additionalProperties": False,
        }
        return "paper_slide_deck_content", schema
    _fail("provider_request_invalid")


def _wire_request(request: SlidePromptRequest, max_output_tokens: int) -> bytes:
    try:
        prompt_data = canonical_prompt_data_bytes(request).decode("utf-8", errors="strict")
        name, schema = _structured_schema(request)
        body: bytes = canonical_json_bytes(
            {
                "background": False,
                "input": [
                    {
                        "role": "system",
                        "content": [{"type": "input_text", "text": request.system_instruction}],
                    },
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": prompt_data}],
                    },
                ],
                "max_output_tokens": max_output_tokens,
                "model": SOL_MODEL,
                "prompt_cache_options": {"mode": "explicit"},
                "reasoning": {"effort": "medium"},
                "service_tier": "default",
                "store": False,
                "stream": False,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": name,
                        "schema": schema,
                        "strict": True,
                    }
                },
                "tools": [],
                "truncation": "disabled",
            },
        )
    except (KeyboardInterrupt, SystemExit, SolProviderError):
        raise
    except BaseException:
        _fail("provider_request_invalid")
    if not body or len(body) > MAX_REQUEST_BYTES:
        _fail("request_oversize")
    return body


def _exact_nonnegative_int(value: object) -> int:
    if type(value) is not int or value < 0 or value > 2**63 - 1:
        _fail("provider_usage_invalid")
    return value


def _validated_headers(response: SolHttpResponse) -> None:
    StdlibSolTransport._validate_response_headers(response.headers)
    content_types = [
        value.strip().casefold()
        for name, value in response.headers
        if name.casefold() == "content-type"
    ]
    if len(content_types) != 1 or content_types[0].split(";", 1)[0] != _JSON_CONTENT_TYPE:
        _fail("provider_response_invalid")


def _safe_provider_id(value: object) -> TypeGuard[str]:
    return bool(
        type(value) is str
        and 1 <= len(value) <= 256
        and value.isascii()
        and all(0x21 <= ord(character) <= 0x7E for character in value)
    )


def _valid_reasoning_item(value: dict[str, object]) -> bool:
    allowed = {"encrypted_content", "id", "type", "summary", "status"}
    status = value.get("status")
    encrypted_content = value.get("encrypted_content")
    return bool(
        set(value).issubset(allowed)
        and {"id", "type", "summary"}.issubset(value)
        and value.get("type") == "reasoning"
        and _safe_provider_id(value.get("id"))
        and value.get("summary") == []
        and ("encrypted_content" not in value or type(encrypted_content) is str)
        and ("status" not in value or status is None or status == "completed")
    )


def _parse_response(
    response: SolHttpResponse, *, max_output_tokens: int
) -> tuple[bytes, int, int, str]:
    if type(response) is not SolHttpResponse:
        _fail("transport_response_invalid")
    if type(response.status) is not int or not 100 <= response.status <= 599:
        _fail("transport_response_invalid")
    if 300 <= response.status < 400:
        _fail("provider_redirect_rejected")
    if response.status == 429:
        _fail("provider_rate_limited")
    if 500 <= response.status < 600:
        _fail("provider_server_error")
    if response.status != 200:
        _fail("provider_http_error")
    _validated_headers(response)
    if (
        type(response.body) is not bytes
        or not response.body
        or len(response.body) > MAX_RESPONSE_BYTES
    ):
        _fail("response_oversize")
    try:
        value = strict_json_loads(response.body)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        _fail("provider_response_invalid")
    if type(value) is not dict:
        _fail("provider_response_invalid")
    if (
        value.get("status") != "completed"
        or value.get("incomplete_details") is not None
        or value.get("error") is not None
        or value.get("model") != SOL_MODEL
    ):
        _fail("provider_response_invalid")
    output = value.get("output")
    if type(output) is not list or not 1 <= len(output) <= 2:
        _fail("provider_output_invalid")
    message_index = 0
    if len(output) == 2:
        reasoning = output[0]
        if type(reasoning) is not dict or not _valid_reasoning_item(reasoning):
            _fail("provider_output_invalid")
        message_index = 1
    if type(output[message_index]) is not dict:
        _fail("provider_output_invalid")
    message = output[message_index]
    if (
        message.get("type") != "message"
        or message.get("role") != "assistant"
        or message.get("status") != "completed"
    ):
        _fail("provider_output_invalid")
    content = message.get("content")
    if type(content) is not list or len(content) != 1 or type(content[0]) is not dict:
        _fail("provider_output_invalid")
    item = content[0]
    text_value = item.get("text")
    if item.get("type") != "output_text" or type(text_value) is not str:
        _fail("provider_output_invalid")
    try:
        payload = text_value.encode("utf-8", errors="strict")
    except UnicodeError:
        _fail("provider_output_invalid")
    if not payload or len(payload) > MAX_PROVIDER_PAYLOAD_BYTES:
        _fail("provider_output_invalid")
    usage = value.get("usage")
    if type(usage) is not dict:
        _fail("provider_usage_invalid")
    input_tokens = _exact_nonnegative_int(usage.get("input_tokens"))
    output_tokens = _exact_nonnegative_int(usage.get("output_tokens"))
    total_tokens = _exact_nonnegative_int(usage.get("total_tokens"))
    input_details = usage.get("input_tokens_details")
    output_details = usage.get("output_tokens_details")
    if (
        type(input_details) is not dict
        or set(input_details) != {"cache_write_tokens", "cached_tokens"}
        or type(output_details) is not dict
    ):
        _fail("provider_usage_invalid")
    cache_write_tokens = _exact_nonnegative_int(input_details.get("cache_write_tokens"))
    cached_tokens = _exact_nonnegative_int(input_details.get("cached_tokens"))
    reasoning_tokens = _exact_nonnegative_int(output_details.get("reasoning_tokens"))
    if (
        input_tokens + output_tokens != total_tokens
        or cached_tokens > input_tokens
        or cache_write_tokens != 0
        or reasoning_tokens > output_tokens
        or output_tokens > max_output_tokens
    ):
        _fail("provider_usage_invalid")
    response_id = value.get("id")
    if not _safe_provider_id(response_id):
        _fail("provider_response_invalid")
    return payload, input_tokens, output_tokens, hashlib.sha256(response_id.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class SolProvider:
    """Fixed-model local provider; credentials and transport bodies stay private."""

    api_key: str = field(repr=False)
    transport: SolHttpTransport = field(default_factory=StdlibSolTransport, repr=False)

    def __post_init__(self) -> None:
        key = self.api_key
        if (
            type(key) is not str
            or not 1 <= len(key) <= 512
            or not key.isascii()
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in key)
            or not callable(getattr(self.transport, "post", None))
        ):
            _fail("provider_credentials_invalid")

    @property
    def identity(self) -> ProviderIdentity:
        return ProviderIdentity(
            SOL_IDENTITY.provider,
            SOL_IDENTITY.model,
            SOL_IDENTITY.adapter_version,
        )

    def count_tokens(self, request: SlidePromptRequest, *, remaining_wall_ms: int) -> int:
        """Conservatively reserve one token per UTF-8 wire byte plus fixed overhead."""

        if type(remaining_wall_ms) is not int or not 1 <= remaining_wall_ms <= MAX_TIMEOUT_MS:
            _fail("provider_timeout")
        return len(_wire_request(request, MAX_OUTPUT_TOKENS)) + TOKEN_ESTIMATE_OVERHEAD

    def generate_json(
        self,
        request: SlidePromptRequest,
        *,
        max_output_tokens: int,
        remaining_wall_ms: int,
    ) -> ProviderJsonResponse:
        if (
            type(max_output_tokens) is not int
            or not 1 <= max_output_tokens <= MAX_OUTPUT_TOKENS
            or type(remaining_wall_ms) is not int
            or not 1 <= remaining_wall_ms <= MAX_TIMEOUT_MS
        ):
            _fail("provider_request_invalid")
        request_hash = provider_request_sha256(request)
        body = _wire_request(request, max_output_tokens)
        headers = {
            "Accept": _JSON_CONTENT_TYPE,
            "Accept-Encoding": "identity",
            "Authorization": f"Bearer {self.api_key}",
            "Content-Length": str(len(body)),
            "Content-Type": _JSON_CONTENT_TYPE,
            "Host": SOL_HOST,
        }
        try:
            response = self.transport.post(body, headers=headers, timeout_ms=remaining_wall_ms)
        except (KeyboardInterrupt, SystemExit, SolProviderError):
            raise
        except TimeoutError:
            _fail("provider_timeout")
        except BaseException:
            _fail("transport_failed")
        payload, input_tokens, output_tokens, request_id_sha256 = _parse_response(
            response, max_output_tokens=max_output_tokens
        )
        return ProviderJsonResponse(
            identity=self.identity,
            request_sha256=request_hash,
            payload=payload,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            provider_request_id_sha256=request_id_sha256,
        )


__all__ = [
    "MAX_REQUEST_BYTES",
    "MAX_RESPONSE_BYTES",
    "SOL_ADAPTER_VERSION",
    "SOL_ENDPOINT",
    "SOL_HOST",
    "SOL_IDENTITY",
    "SOL_MODEL",
    "SOL_PATH",
    "SolHttpResponse",
    "SolHttpTransport",
    "SolProvider",
    "SolProviderError",
    "StdlibSolTransport",
]
