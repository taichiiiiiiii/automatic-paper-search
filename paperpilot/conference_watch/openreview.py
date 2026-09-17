"""Strict OpenReview v2 adapter for complete, read-only source snapshots."""

from __future__ import annotations

import ipaddress
import json
import re
import time
from collections import Counter
from collections.abc import Callable
from typing import Any, Protocol
from urllib.parse import urlencode, urlsplit

from paperpilot.identity.source_ids import IdentityError, make_paper_id
from paperpilot.paper_slides.fetch import (
    DNSResolver,
    PinnedRequest,
    PinnedResponse,
    PinnedTlsTransport,
    PinnedTransport,
    SystemDNSResolver,
)

from .fingerprint import source_fingerprint
from .models import (
    DetectionKind,
    DetectionResult,
    Edition,
    ErrorCode,
    FetchLimits,
    NormalizedPaper,
    SourceSnapshot,
)

OPENREVIEW_API_URL = "https://api2.openreview.net/notes"
OPENREVIEW_API_HOST = "api2.openreview.net"
OPENREVIEW_FORUM_URL = "https://openreview.net/forum?id="
OPENREVIEW_PDF_URL = "https://openreview.net/pdf?id="
ADAPTER_NAME = "openreview-v2"
ADAPTER_VERSION = "1"

_NOTE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_WORD_RE = re.compile(r"[a-z0-9_-]+")


class ResponseLike(Protocol):
    status_code: int
    content: bytes
    request_count: int

    def json(self) -> Any: ...


class _BufferedResponse:
    """Minimal response whose body was read under the transport byte ceiling."""

    def __init__(self, status_code: int, content: bytes = b"", *, request_count: int) -> None:
        self.status_code = status_code
        self.content = content
        self.request_count = request_count

    def json(self) -> Any:
        return json.loads(self.content)


class StrictTransport(Protocol):
    def get(
        self,
        url: str,
        *,
        params: dict[str, Any],
        limits: FetchLimits,
        deadline: float,
    ) -> ResponseLike: ...


class TransportError(RuntimeError):
    """A sanitized transport failure carrying no URL, body, or headers."""

    def __init__(self, code: ErrorCode):
        super().__init__(code.value)
        self.code = code


class _RetryablePageError(RuntimeError):
    """A response-body transport failure safe to retry from byte zero."""

    def __init__(self, code: ErrorCode):
        super().__init__(code.value)
        self.code = code


def _is_public_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return address.is_global


def validate_fixed_endpoint(
    url: str,
) -> tuple[str, str]:
    """Require the exact HTTPS API authority and return host plus origin target."""

    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR) from exc
    if (
        parts.scheme != "https"
        or (parts.hostname or "").lower() != OPENREVIEW_API_HOST
        or parts.username is not None
        or parts.password is not None
        or port not in {None, 443}
        or parts.path != "/notes"
        or parts.query
        or parts.fragment
    ):
        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
    return OPENREVIEW_API_HOST, parts.path


class SecurePinnedTransport:
    """DNS-pinned TLS transport with bounded retries, reads, and no redirects."""

    supports_ip_pinning = True

    def __init__(
        self,
        *,
        resolver: DNSResolver | None = None,
        transport: PinnedTransport | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._resolver = resolver or SystemDNSResolver()
        self._transport = transport or PinnedTlsTransport()
        if getattr(self._transport, "supports_ip_pinning", False) is not True:
            raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        self._monotonic = monotonic
        self._sleep = sleep

    def get(
        self,
        url: str,
        *,
        params: dict[str, Any],
        limits: FetchLimits,
        deadline: float,
    ) -> ResponseLike:
        hostname, path = validate_fixed_endpoint(url)
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise TransportError(ErrorCode.SOURCE_TIMEOUT)
        try:
            resolved = self._resolver.resolve(
                hostname,
                443,
                timeout=min(limits.connect_timeout_seconds, remaining),
            )
            addresses = tuple(dict.fromkeys(str(item) for item in resolved))
            if not addresses or not all(_is_public_address(item) for item in addresses):
                raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        except TimeoutError as exc:
            raise TransportError(ErrorCode.SOURCE_TIMEOUT) from exc
        except TransportError:
            raise
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            raise TransportError(ErrorCode.SOURCE_HTTP_ERROR) from exc

        target = f"{path}?{urlencode(params)}"
        requests_made = 0
        for attempt in range(limits.max_retries + 1):
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                raise TransportError(ErrorCode.SOURCE_TIMEOUT)
            request = PinnedRequest(
                hostname=hostname,
                ip_address=addresses[0],
                target=target,
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "identity",
                    "Host": hostname,
                },
                connect_timeout=min(limits.connect_timeout_seconds, remaining),
                read_timeout=min(limits.read_timeout_seconds, remaining),
            )
            response: PinnedResponse
            try:
                requests_made += 1
                response_object = self._transport.request(request)
                if not isinstance(response_object, PinnedResponse):
                    raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
                response = response_object
            except TimeoutError as exc:
                if attempt >= limits.max_retries:
                    raise TransportError(ErrorCode.SOURCE_TIMEOUT) from exc
                self._bounded_sleep(0.25 * (2**attempt), deadline)
                continue
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                if attempt >= limits.max_retries:
                    raise TransportError(ErrorCode.SOURCE_HTTP_ERROR) from exc
                self._bounded_sleep(0.25 * (2**attempt), deadline)
                continue

            retryable_read: _RetryablePageError | None = None
            try:
                status = response.status
                if type(status) is not int or not 100 <= status <= 599:
                    raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
                if 300 <= status < 400:
                    raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
                if status == 429:
                    if attempt >= limits.max_retries:
                        raise TransportError(ErrorCode.SOURCE_RATE_LIMITED)
                    self._bounded_sleep(2**attempt, deadline)
                    continue
                if 500 <= status < 600:
                    if attempt >= limits.max_retries:
                        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
                    self._bounded_sleep(2**attempt, deadline)
                    continue
                if status != 200:
                    return _BufferedResponse(status, request_count=requests_made)
                length = self._content_length(response)
                if length is not None and length > limits.max_response_bytes:
                    raise TransportError(ErrorCode.SOURCE_PARTIAL)
                body = bytearray()
                while True:
                    remaining = deadline - self._monotonic()
                    if remaining <= 0:
                        raise TransportError(ErrorCode.SOURCE_TIMEOUT)
                    try:
                        chunk = response.read(
                            min(64 * 1024, limits.max_response_bytes + 1 - len(body)),
                            timeout=min(limits.read_timeout_seconds, remaining),
                        )
                    except TimeoutError as exc:
                        raise _RetryablePageError(ErrorCode.SOURCE_TIMEOUT) from exc
                    except (KeyboardInterrupt, SystemExit):
                        raise
                    except OSError as exc:
                        raise _RetryablePageError(ErrorCode.SOURCE_HTTP_ERROR) from exc
                    except BaseException as exc:
                        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR) from exc
                    if not isinstance(chunk, bytes):
                        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
                    if self._monotonic() > deadline:
                        raise TransportError(ErrorCode.SOURCE_TIMEOUT)
                    if not chunk:
                        break
                    body.extend(chunk)
                    if len(body) > limits.max_response_bytes:
                        raise TransportError(ErrorCode.SOURCE_PARTIAL)
                if length is not None and len(body) != length:
                    raise TransportError(ErrorCode.SOURCE_PARTIAL)
                return _BufferedResponse(200, bytes(body), request_count=requests_made)
            except _RetryablePageError as exc:
                retryable_read = exc
            finally:
                try:
                    response.close()
                except (KeyboardInterrupt, SystemExit):
                    raise
                except BaseException as exc:
                    raise TransportError(ErrorCode.SOURCE_HTTP_ERROR) from exc
            if retryable_read is not None:
                if attempt >= limits.max_retries:
                    raise TransportError(retryable_read.code) from retryable_read
                self._bounded_sleep(0.25 * (2**attempt), deadline)
                continue
        raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)  # pragma: no cover

    @staticmethod
    def _content_length(response: PinnedResponse) -> int | None:
        headers = response.headers
        if type(headers) is not tuple or len(headers) > 128:
            raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        lengths: list[str] = []
        for item in headers:
            if type(item) is not tuple or len(item) != 2:
                raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
            name, value = item
            if type(name) is not str or type(value) is not str:
                raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
            if len(name) > 256 or len(value) > 8192 or "\n" in value or "\r" in value:
                raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
            if name.casefold() == "content-length":
                lengths.append(value.strip())
            if name.casefold() == "content-encoding" and value.strip().casefold() != "identity":
                raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        if len(lengths) > 1:
            raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        if not lengths:
            return None
        if not lengths[0].isascii() or not lengths[0].isdigit():
            raise TransportError(ErrorCode.SOURCE_HTTP_ERROR)
        return int(lengths[0])

    def _bounded_sleep(self, seconds: float, deadline: float) -> None:
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise TransportError(ErrorCode.SOURCE_TIMEOUT)
        self._sleep(min(seconds, remaining))


def _content_value(content: dict[str, Any], key: str) -> Any:
    node = content.get(key)
    if not isinstance(node, dict) or "value" not in node:
        return None
    return node["value"]


def _normalized_text(value: Any, *, required: bool, maximum: int = 100_000) -> str:
    if not isinstance(value, str):
        if required:
            raise ValueError("required text is missing")
        return ""
    normalized = " ".join(value.split())
    if (required and not normalized) or len(normalized) > maximum:
        raise ValueError("text field is empty or oversized")
    return normalized


def _normalize_decision(label: str, accepted: tuple[str, ...]) -> str | None:
    tokens = set(_WORD_RE.findall(label.casefold()))
    matches = [candidate for candidate in accepted if candidate.casefold() in tokens]
    if len(matches) > 1:
        raise ValueError("decision label matches multiple configured decisions")
    return matches[0] if matches else None


def _normalize_note(note: Any, edition: Edition) -> tuple[NormalizedPaper, str | None]:
    if not isinstance(note, dict):
        raise ValueError("note must be an object")
    note_id = note.get("id")
    if not isinstance(note_id, str) or not _NOTE_ID_RE.fullmatch(note_id):
        raise IdentityError("OpenReview note ID is missing or invalid")
    content = note.get("content")
    if not isinstance(content, dict):
        raise ValueError("note content must be an object")
    venue_id = _content_value(content, "venueid")
    if venue_id != edition.source_id:
        raise IdentityError("OpenReview note venueid does not match the edition")
    title = _normalized_text(_content_value(content, "title"), required=True, maximum=10_000)
    raw_authors = _content_value(content, "authors")
    if not isinstance(raw_authors, list) or not raw_authors:
        raise IdentityError("OpenReview authors must be a non-empty array")
    authors = tuple(
        _normalized_text(author, required=True, maximum=1_000) for author in raw_authors
    )
    abstract = _normalized_text(
        _content_value(content, "abstract"), required=False, maximum=100_000
    )
    decision_label = _normalized_text(
        _content_value(content, "venue"), required=True, maximum=1_000
    )
    decision = _normalize_decision(decision_label, edition.tracks.accepted_decision_labels)
    return (
        NormalizedPaper(
            source="openreview",
            source_id=note_id,
            paper_id=make_paper_id("openreview", note_id),
            title=title,
            authors=authors,
            abstract=abstract,
            landing_url=f"{OPENREVIEW_FORUM_URL}{note_id}",
            pdf_url=f"{OPENREVIEW_PDF_URL}{note_id}",
            decision_label=decision_label,
        ),
        decision,
    )


class OpenReviewV2Adapter:
    """Fetch every accepted page or return a typed result without any rows."""

    name = ADAPTER_NAME
    version = ADAPTER_VERSION

    def __init__(
        self,
        transport: StrictTransport | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport or SecurePinnedTransport(monotonic=monotonic)
        self._monotonic = monotonic

    def probe(self, edition: Edition, limits: FetchLimits = FetchLimits()) -> DetectionResult:
        """Perform the same complete retrieval used by ``collect``."""

        return self._retrieve(edition, limits)

    def collect(self, edition: Edition, limits: FetchLimits = FetchLimits()) -> DetectionResult:
        """Return an immutable snapshot only after all pages and rows validate."""

        return self._retrieve(edition, limits)

    def _retrieve(self, edition: Edition, limits: FetchLimits) -> DetectionResult:
        if edition.adapter != self.name:
            return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.REGISTRY_INVALID)
        started = self._monotonic()
        deadline = started + limits.job_deadline_seconds
        notes: list[Any] = []
        response_bytes = 0
        requests_made = 0
        pages_fetched = 0
        expected_count: int | None = None
        completed = False

        for page in range(limits.max_pages):
            if self._monotonic() >= deadline:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
            try:
                request_deadline = min(deadline, self._monotonic() + limits.request_timeout_seconds)
                response = self._transport.get(
                    OPENREVIEW_API_URL,
                    params={
                        "content.venueid": edition.source_id,
                        "limit": limits.page_size,
                        "offset": page * limits.page_size,
                        "count": "true",
                    },
                    limits=limits,
                    deadline=request_deadline,
                )
            except TransportError as exc:
                return DetectionResult(DetectionKind.ERROR, error_code=exc.code)
            if self._monotonic() >= request_deadline:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
            if (
                isinstance(response.request_count, bool)
                or not isinstance(response.request_count, int)
                or not 1 <= response.request_count <= limits.max_retries + 1
            ):
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_HTTP_ERROR)
            requests_made += response.request_count
            pages_fetched += 1
            if response.status_code == 404:
                return DetectionResult(
                    DetectionKind.UNAVAILABLE, error_code=ErrorCode.SOURCE_UNAVAILABLE
                )
            if response.status_code == 429:
                return DetectionResult(
                    DetectionKind.ERROR, error_code=ErrorCode.SOURCE_RATE_LIMITED
                )
            if response.status_code != 200:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_HTTP_ERROR)

            if type(response.content) is not bytes:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR)
            body_bytes = response.content
            response_bytes += len(body_bytes)
            if response_bytes > limits.max_response_bytes:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
            try:
                body = response.json()
            except (TypeError, ValueError, json.JSONDecodeError):
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR)
            if not isinstance(body, dict) or not isinstance(body.get("notes"), list):
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR)
            raw_count = body.get("count")
            if raw_count is not None:
                if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 0:
                    return DetectionResult(
                        DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR
                    )
                if expected_count is None:
                    expected_count = raw_count
                elif raw_count != expected_count:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
                if raw_count > limits.max_notes:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
            batch = body["notes"]
            if len(batch) > limits.page_size:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR)
            notes.extend(batch)
            if len(notes) > limits.max_notes:
                return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)

            if expected_count is not None:
                if len(notes) > expected_count:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
                if len(notes) == expected_count:
                    completed = True
                    break
                if len(batch) < limits.page_size:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
            elif len(batch) < limits.page_size:
                completed = True
                break

        if not completed:
            return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARTIAL)
        if not notes:
            return DetectionResult(
                DetectionKind.UNAVAILABLE, error_code=ErrorCode.SOURCE_UNAVAILABLE
            )

        rows: list[NormalizedPaper] = []
        unknown = Counter[str]()
        seen_ids: set[str] = set()
        seen_paper_ids: set[str] = set()
        seen_urls: set[str] = set()
        try:
            for note in notes:
                if self._monotonic() >= deadline:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
                row, decision = _normalize_note(note, edition)
                if row.source_id in seen_ids or row.paper_id in seen_paper_ids:
                    return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.DUPLICATE_ID)
                if row.landing_url in seen_urls:
                    return DetectionResult(
                        DetectionKind.ERROR, error_code=ErrorCode.IDENTITY_CONFLICT
                    )
                seen_ids.add(row.source_id)
                seen_paper_ids.add(row.paper_id)
                seen_urls.add(row.landing_url)
                rows.append(row)
                if decision is None:
                    unknown[row.decision_label.casefold()] += 1
        except IdentityError:
            return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.IDENTITY_MISSING)
        except (TypeError, ValueError):
            return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_PARSE_ERROR)

        immutable_rows = tuple(sorted(rows, key=lambda row: row.source_id))
        if self._monotonic() >= deadline:
            return DetectionResult(DetectionKind.ERROR, error_code=ErrorCode.SOURCE_TIMEOUT)
        fingerprint = source_fingerprint(
            adapter_version=self.version,
            edition_id=edition.edition_id,
            source_id=edition.source_id,
            rows=immutable_rows,
        )
        snapshot = SourceSnapshot(
            schema_version="conference-source-snapshot-v1",
            edition_id=edition.edition_id,
            adapter=self.name,
            adapter_version=self.version,
            source_id=edition.source_id,
            rows=immutable_rows,
            source_fingerprint=fingerprint,
            unknown_decisions=tuple(sorted(unknown.items())),
            duplicate_title_count=sum(
                count - 1
                for count in Counter(row.title for row in immutable_rows).values()
                if count > 1
            ),
            request_count=requests_made,
            page_count=pages_fetched,
            response_bytes=response_bytes,
        )
        return DetectionResult(DetectionKind.SNAPSHOT, snapshot=snapshot)
