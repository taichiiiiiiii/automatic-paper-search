"""Bounded, SSRF-safe PDF fetching for trusted slide source records.

The public boundary accepts a resolver-produced object, not a URL.  Network
dependencies are explicit so tests can prove that no live DNS or HTTP request
is made.  The default transport connects to a validated IP address directly,
while retaining the validated hostname for TLS SNI, certificate checks, and
the HTTP Host header.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import re
import socket
import ssl
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from queue import Empty, Queue
from typing import BinaryIO, Protocol, TypeAlias
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

from paperpilot.identity import IdentityError, make_paper_id, normalize_alias
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_FETCH_FAILED,
    PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
    PAPER_SLIDE_PDF_INVALID,
    PAPER_SLIDE_SOURCE_RESTRICTED,
    PAPER_SLIDE_SOURCE_UNTRUSTED,
)
from paperpilot.paper_slides.resolver import ResolvedPDFSource

MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_REDIRECTS = 3
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 20.0
DEFAULT_TOTAL_TIMEOUT = 60.0
READ_CHUNK_BYTES = 64 * 1024
MAX_RESPONSE_HEADERS = 128
MAX_HEADER_NAME_BYTES = 128
MAX_HEADER_VALUE_BYTES = 8 * 1024
MAX_TOTAL_HEADER_BYTES = 64 * 1024
MAX_CONCURRENT_DNS_LOOKUPS = 4

_ADAPTER_HOSTS: Mapping[str, frozenset[str]] = {
    "arxiv": frozenset({"arxiv.org"}),
    "openreview": frozenset({"openreview.net"}),
    "acl_anthology": frozenset({"aclanthology.org"}),
    "cvf": frozenset({"openaccess.thecvf.com"}),
}
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_DECIMAL_RE = re.compile(r"^[0-9]+$")
_CVF_COLLECTION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$")
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_METADATA_ADDRESSES = frozenset(
    {
        ipaddress.ip_address("100.100.100.200"),
        ipaddress.ip_address("168.63.129.16"),
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("192.0.0.192"),
        ipaddress.ip_address("fd00:ec2::254"),
    }
)
_DNS_LOOKUP_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_DNS_LOOKUPS)


class _DNSLookupSaturatedError(RuntimeError):
    pass


TrustedPdfSource: TypeAlias = ResolvedPDFSource


class DNSResolver(Protocol):
    """Resolve every address for a hostname without connecting to it."""

    def resolve(self, hostname: str, port: int, *, timeout: float) -> Sequence[str]: ...


class PinnedTransport(Protocol):
    """HTTPS transport that connects only to ``request.ip_address``."""

    supports_ip_pinning: bool

    def request(self, request: PinnedRequest) -> PinnedResponse: ...


@dataclass(frozen=True)
class PinnedRequest:
    """A validated origin-form HTTPS request with a DNS-pinned destination."""

    hostname: str
    ip_address: str
    target: str
    headers: Mapping[str, str]
    connect_timeout: float
    read_timeout: float


@dataclass
class PinnedResponse:
    """Small transport-neutral streaming response used by fakes and stdlib HTTP."""

    status: int
    headers: tuple[tuple[str, str], ...]
    stream: BinaryIO = field(repr=False)

    def header_values(self, name: str) -> tuple[str, ...]:
        wanted = name.casefold()
        return tuple(value for key, value in self.headers if key.casefold() == wanted)

    def read(self, amount: int, *, timeout: float) -> bytes:
        del timeout
        return self.stream.read(amount)

    def close(self) -> None:
        self.stream.close()


@dataclass(frozen=True)
class _ValidatedPinnedResponse:
    response: PinnedResponse
    status: int
    headers: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class PdfFetchResult:
    """Successful PDF bytes and non-sensitive integrity metadata."""

    pdf_bytes: bytes = field(repr=False)
    sha256: str
    byte_count: int


class PdfFetchError(RuntimeError):
    """A stable, redacted fetch failure safe for logs and public boundaries."""

    def __init__(self, error_code: str, issue_code: str) -> None:
        self.error_code = error_code
        self.issue_code = issue_code
        super().__init__(f"{error_code}:{issue_code}")


class SystemDNSResolver:
    """Default resolver returning all unique stream-socket answers."""

    def resolve(self, hostname: str, port: int, *, timeout: float) -> tuple[str, ...]:
        slot_pool = _DNS_LOOKUP_SLOTS
        if not slot_pool.acquire(blocking=False):
            raise _DNSLookupSaturatedError
        results: Queue[tuple[bool, object]] = Queue(maxsize=1)

        def run_lookup() -> None:
            try:
                try:
                    answers = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
                except BaseException as exc:
                    results.put((False, exc))
                else:
                    results.put((True, answers))
            finally:
                slot_pool.release()

        # getaddrinfo has no portable timeout.  A daemon isolates that system
        # call so the bounded fetch caller never waits past its total deadline.
        try:
            threading.Thread(target=run_lookup, daemon=True).start()
        except BaseException:
            slot_pool.release()
            raise
        try:
            succeeded, result = results.get(timeout=timeout)
        except Empty:
            raise TimeoutError from None
        if not succeeded:
            assert isinstance(result, BaseException)
            raise result
        assert isinstance(result, list)
        answers = result
        return tuple(dict.fromkeys(answer[4][0] for answer in answers))


class _PinnedHTTPSConnection(http.client.HTTPConnection):
    """HTTPConnection whose socket is pinned but whose TLS identity is not."""

    default_port = 443

    def __init__(
        self,
        hostname: str,
        ip_address: str,
        *,
        connect_timeout: float,
        read_timeout: float,
        context: ssl.SSLContext,
    ) -> None:
        super().__init__(hostname, 443, timeout=connect_timeout)
        self._pinned_ip = ip_address
        self._tls_hostname = hostname
        self._read_timeout = read_timeout
        self._context = context

    def connect(self) -> None:
        address = ipaddress.ip_address(self._pinned_ip)
        family = socket.AF_INET if address.version == 4 else socket.AF_INET6
        raw_socket = socket.socket(family, socket.SOCK_STREAM)
        try:
            raw_socket.settimeout(self.timeout)
            destination = (
                (self._pinned_ip, 443) if family == socket.AF_INET else (self._pinned_ip, 443, 0, 0)
            )
            raw_socket.connect(destination)
            raw_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            raw_socket.settimeout(self._read_timeout)
            self.sock = self._context.wrap_socket(
                raw_socket,
                server_hostname=self._tls_hostname,
            )
        except BaseException:
            raw_socket.close()
            raise


class _HTTPResponseAdapter(PinnedResponse):
    def __init__(
        self,
        response: http.client.HTTPResponse,
        connection: _PinnedHTTPSConnection,
    ) -> None:
        headers = tuple((key, value) for key, value in response.getheaders())
        super().__init__(status=response.status, headers=headers, stream=response)
        self._connection = connection

    def read(self, amount: int, *, timeout: float) -> bytes:
        if self._connection.sock is not None:
            self._connection.sock.settimeout(timeout)
        return self.stream.read(amount)

    def close(self) -> None:
        try:
            self.stream.close()
        finally:
            self._connection.close()


class PinnedTlsTransport:
    """Stdlib HTTPS transport with no proxy, netrc, cookie, or auth integration."""

    supports_ip_pinning = True

    def request(self, request: PinnedRequest) -> PinnedResponse:
        context = ssl.create_default_context()
        connection = _PinnedHTTPSConnection(
            request.hostname,
            request.ip_address,
            connect_timeout=request.connect_timeout,
            read_timeout=request.read_timeout,
            context=context,
        )
        try:
            connection.request(
                "GET",
                request.target,
                body=None,
                headers=dict(request.headers),
                encode_chunked=False,
            )
            return _HTTPResponseAdapter(connection.getresponse(), connection)
        except BaseException:
            connection.close()
            raise


def _fail(error_code: str, issue_code: str) -> PdfFetchError:
    return PdfFetchError(error_code, issue_code)


def _validate_limits(
    *,
    max_bytes: int,
    max_redirects: int,
    connect_timeout: float,
    read_timeout: float,
    total_timeout: float,
) -> None:
    values_are_numbers = all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in (connect_timeout, read_timeout, total_timeout)
    )
    if (
        not isinstance(max_bytes, int)
        or isinstance(max_bytes, bool)
        or not 0 < max_bytes <= MAX_PDF_BYTES
        or not isinstance(max_redirects, int)
        or isinstance(max_redirects, bool)
        or not 0 <= max_redirects <= MAX_REDIRECTS
        or not values_are_numbers
        or not 0 < connect_timeout <= DEFAULT_TOTAL_TIMEOUT
        or not 0 < read_timeout <= DEFAULT_TOTAL_TIMEOUT
        or not 0 < total_timeout <= DEFAULT_TOTAL_TIMEOUT
    ):
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_CONFIG_INVALID")


def _validate_source(source: TrustedPdfSource) -> tuple[str, str, str, str]:
    if type(source) is not ResolvedPDFSource:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_OBJECT_INVALID")
    source_read_failed = False
    try:
        adapter = source.source
        source_id = source.source_id
        paper_id = source.paper_id
        landing_url = source.landing_url
        pdf_url = source.pdf_url
        access = source.access
        license_value = source.license
        license_evidence_url = source.license_evidence_url
    except Exception:
        source_read_failed = True
    if source_read_failed:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_OBJECT_INVALID") from None
    if not all(isinstance(value, str) for value in (adapter, source_id, paper_id, pdf_url, access)):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_OBJECT_INVALID")
    if not isinstance(landing_url, str) or not isinstance(license_value, str):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_OBJECT_INVALID")
    if access == "restricted":
        raise _fail(PAPER_SLIDE_SOURCE_RESTRICTED, "SOURCE_ACCESS_RESTRICTED")
    if access not in {"open_access", "unknown"}:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_ACCESS_INVALID")
    if adapter not in _ADAPTER_HOSTS:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_ADAPTER_UNTRUSTED")
    identity_failed = False
    try:
        normalized_source, normalized_id = normalize_alias(adapter, source_id)
        expected_paper_id = make_paper_id(adapter, source_id)
    except (IdentityError, TypeError, ValueError):
        identity_failed = True
    if identity_failed:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_IDENTITY_INVALID")
    if normalized_source != adapter or normalized_id != source_id or expected_paper_id != paper_id:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_IDENTITY_MISMATCH")
    expected_landing: str
    expected_pdf: str
    if adapter == "arxiv":
        expected_landing = f"https://arxiv.org/abs/{source_id}"
        expected_pdf = f"https://arxiv.org/pdf/{source_id}"
    elif adapter == "openreview":
        expected_landing = f"https://openreview.net/forum?id={source_id}"
        expected_pdf = f"https://openreview.net/pdf?id={source_id}"
    elif adapter == "acl_anthology":
        expected_landing = f"https://aclanthology.org/{source_id}/"
        expected_pdf = f"https://aclanthology.org/{source_id}.pdf"
    else:
        collection = _canonical_cvf_collection(landing_url, pdf_url, source_id)
        expected_landing = (
            f"https://openaccess.thecvf.com/content/{collection}/html/{source_id}.html"
        )
        expected_pdf = f"https://openaccess.thecvf.com/content/{collection}/papers/{source_id}.pdf"
    if (
        landing_url != expected_landing
        or pdf_url != expected_pdf
        or access != "open_access"
        or license_value != "unknown"
        or license_evidence_url is not None
    ):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_PROVENANCE_MISMATCH")
    return adapter, source_id, pdf_url, access


def _canonical_cvf_collection(landing_url: str, pdf_url: str, source_id: str) -> str:
    landing_prefix = "https://openaccess.thecvf.com/content/"
    landing_suffix = f"/html/{source_id}.html"
    pdf_prefix = "https://openaccess.thecvf.com/content/"
    pdf_suffix = f"/papers/{source_id}.pdf"
    if not (
        landing_url.startswith(landing_prefix)
        and landing_url.endswith(landing_suffix)
        and pdf_url.startswith(pdf_prefix)
        and pdf_url.endswith(pdf_suffix)
    ):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_PROVENANCE_MISMATCH")
    landing_collection = landing_url[len(landing_prefix) : -len(landing_suffix)]
    pdf_collection = pdf_url[len(pdf_prefix) : -len(pdf_suffix)]
    if (
        landing_collection != pdf_collection
        or _CVF_COLLECTION_RE.fullmatch(landing_collection) is None
    ):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_PROVENANCE_MISMATCH")
    return landing_collection


def _validated_url(url: str, adapter: str) -> tuple[SplitResult, str, str]:
    if (
        not isinstance(url, str)
        or not url
        or not url.isascii()
        or any(ord(char) <= 0x20 or ord(char) == 0x7F for char in url)
        or "\\" in url
    ):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_INVALID")
    split_failed = False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        split_failed = True
    if split_failed:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_INVALID")
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or "#" in url
    ):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_INVALID")
    hostname = parsed.hostname
    if hostname is None or hostname != hostname.lower():
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_INVALID")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_IP_LITERAL")
    if hostname not in _ADAPTER_HOSTS[adapter]:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_HOST_UNTRUSTED")
    if parsed.netloc not in {hostname, f"{hostname}:443"} or port not in (None, 443):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_PORT_INVALID")
    if port == 443 and not parsed.netloc.endswith(":443"):
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_PORT_INVALID")
    target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    normalized_netloc = hostname if port is None else f"{hostname}:443"
    normalized = urlunsplit(("https", normalized_netloc, parsed.path or "/", parsed.query, ""))
    return parsed, target, normalized


def _validate_source_url_identity(
    parsed: SplitResult,
    adapter: str,
    source_id: str,
    *,
    expected_cvf_path: str | None,
) -> str | None:
    valid = False
    if adapter == "arxiv":
        valid = parsed.path == f"/pdf/{source_id}" and not parsed.query
    elif adapter == "openreview":
        valid = parsed.path == "/pdf" and parsed.query == f"id={source_id}"
    elif adapter == "acl_anthology":
        valid = parsed.path == f"/{source_id}.pdf" and not parsed.query
    elif adapter == "cvf" and not parsed.query:
        segments = parsed.path.split("/")
        valid = (
            len(segments) == 5
            and segments[0] == ""
            and segments[1] == "content"
            and _CVF_COLLECTION_RE.fullmatch(segments[2]) is not None
            and segments[3] == "papers"
            and segments[4] == f"{source_id}.pdf"
        )
        if valid and expected_cvf_path is not None:
            valid = parsed.path == expected_cvf_path
    if not valid:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_IDENTITY_MISMATCH")
    return parsed.path if adapter == "cvf" else None


def _validated_addresses(
    hostname: str,
    resolver: DNSResolver,
    *,
    timeout: float,
) -> tuple[str, ...]:
    lookup_issue: str | None = None
    try:
        raw_answers = resolver.resolve(hostname, 443, timeout=timeout)
        answers = tuple(raw_answers)
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        if isinstance(exc, TimeoutError):
            lookup_issue = "FETCH_TIMEOUT"
        elif isinstance(exc, _DNSLookupSaturatedError):
            lookup_issue = "DNS_LOOKUP_SATURATED"
        else:
            lookup_issue = "DNS_LOOKUP_FAILED"
    if lookup_issue is not None:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, lookup_issue)
    if not answers:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "DNS_LOOKUP_FAILED")
    validated: list[str] = []
    for raw in answers:
        if not isinstance(raw, str) or "%" in raw:
            raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "DNS_ANSWER_INVALID")
        address_failed = False
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            address_failed = True
        if address_failed:
            raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "DNS_ANSWER_INVALID")
        if (
            address in _METADATA_ADDRESSES
            or (
                isinstance(address, ipaddress.IPv6Address)
                and (
                    address.ipv4_mapped is not None
                    or address.sixtofour is not None
                    or address.teredo is not None
                )
            )
            or address.is_loopback
            or address.is_link_local
            or address.is_private
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
            or not address.is_global
        ):
            raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "DNS_ADDRESS_UNTRUSTED")
        canonical = str(address)
        if canonical not in validated:
            validated.append(canonical)
    return tuple(validated)


def _validate_response_shape(response: object) -> _ValidatedPinnedResponse:
    if not isinstance(response, PinnedResponse):
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    try:
        status = response.status
        headers = response.headers
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID") from None
    if type(status) is not int or not 100 <= status <= 599:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    if type(headers) is not tuple or len(headers) > MAX_RESPONSE_HEADERS:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    total_bytes = 0
    for item in headers:
        if type(item) is not tuple or len(item) != 2:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
        name, value = item
        if (
            type(name) is not str
            or type(value) is not str
            or not name.isascii()
            or not value.isascii()
            or _HEADER_NAME_RE.fullmatch(name) is None
            or len(name) > MAX_HEADER_NAME_BYTES
            or len(value) > MAX_HEADER_VALUE_BYTES
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
        ):
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
        total_bytes += len(name) + len(value)
        if total_bytes > MAX_TOTAL_HEADER_BYTES:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    return _ValidatedPinnedResponse(response=response, status=status, headers=headers)


def _single_header(response: _ValidatedPinnedResponse, name: str) -> str | None:
    values_failed = False
    try:
        values = response.response.header_values(name)
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        values_failed = True
    if values_failed:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    expected = tuple(value for key, value in response.headers if key.casefold() == name.casefold())
    if type(values) is not tuple or values != expected:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
    if len(values) > 1:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "RESPONSE_HEADER_AMBIGUOUS")
    return values[0].strip() if values else None


def _validate_pdf_headers(response: _ValidatedPinnedResponse, max_bytes: int) -> int | None:
    content_type = _single_header(response, "Content-Type")
    if (
        content_type is None
        or content_type.split(";", 1)[0].strip().casefold() != "application/pdf"
    ):
        raise _fail(PAPER_SLIDE_PDF_INVALID, "CONTENT_TYPE_INVALID")
    content_encoding = _single_header(response, "Content-Encoding")
    if content_encoding is not None and content_encoding.casefold() != "identity":
        raise _fail(PAPER_SLIDE_PDF_INVALID, "CONTENT_ENCODING_INVALID")
    content_length = _single_header(response, "Content-Length")
    transfer_encoding = _single_header(response, "Transfer-Encoding")
    if content_length is not None:
        if not _DECIMAL_RE.fullmatch(content_length):
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "CONTENT_LENGTH_INVALID")
        if len(content_length) > len(str(max_bytes)):
            raise _fail(
                PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
                "CONTENT_LENGTH_LIMIT_EXCEEDED",
            )
        declared_length = int(content_length)
        if declared_length > max_bytes:
            raise _fail(
                PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
                "CONTENT_LENGTH_LIMIT_EXCEEDED",
            )
        if transfer_encoding is not None:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "RESPONSE_LENGTH_AMBIGUOUS")
    if transfer_encoding is not None and transfer_encoding.casefold() != "chunked":
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSFER_ENCODING_INVALID")
    return declared_length if content_length is not None else None


def _read_pdf(
    response: PinnedResponse,
    *,
    max_bytes: int,
    expected_length: int | None,
    read_timeout: float,
    deadline: float,
    clock: Callable[[], float],
) -> PdfFetchResult:
    body = bytearray()
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_TIMEOUT")
        read_issue: str | None = None
        try:
            chunk = response.read(
                min(READ_CHUNK_BYTES, max_bytes + 1 - len(body)),
                timeout=min(read_timeout, remaining),
            )
        except BaseException as exc:
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            if isinstance(exc, (TimeoutError, socket.timeout)):
                read_issue = "FETCH_TIMEOUT"
            else:
                read_issue = "TRANSPORT_READ_FAILED"
        if read_issue is not None:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, read_issue)
        if not isinstance(chunk, bytes):
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_RESPONSE_INVALID")
        if clock() > deadline:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_TIMEOUT")
        if not chunk:
            break
        body.extend(chunk)
        if len(body) > max_bytes:
            raise _fail(PAPER_SLIDE_FETCH_LIMIT_EXCEEDED, "BODY_LIMIT_EXCEEDED")
        if expected_length is not None and len(body) > expected_length:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "CONTENT_LENGTH_MISMATCH")
        if len(body) >= 5 and body[:5] != b"%PDF-":
            raise _fail(PAPER_SLIDE_PDF_INVALID, "PDF_MAGIC_INVALID")
    if len(body) < 5 or body[:5] != b"%PDF-":
        raise _fail(PAPER_SLIDE_PDF_INVALID, "PDF_MAGIC_INVALID")
    if expected_length is not None and len(body) != expected_length:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "CONTENT_LENGTH_MISMATCH")
    pdf_bytes = bytes(body)
    return PdfFetchResult(
        pdf_bytes=pdf_bytes,
        sha256=hashlib.sha256(pdf_bytes).hexdigest(),
        byte_count=len(pdf_bytes),
    )


def _fetch_pdf_boundary(
    resolved_source: TrustedPdfSource,
    *,
    dns_resolver: DNSResolver | None = None,
    transport: PinnedTransport | None = None,
    max_bytes: int = MAX_PDF_BYTES,
    max_redirects: int = MAX_REDIRECTS,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    read_timeout: float = DEFAULT_READ_TIMEOUT,
    total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
    _clock: Callable[[], float] = time.monotonic,
) -> PdfFetchResult:
    """Fetch one trusted resolver result through a DNS-pinned HTTPS boundary."""

    _validate_limits(
        max_bytes=max_bytes,
        max_redirects=max_redirects,
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        total_timeout=total_timeout,
    )
    adapter, source_id, current_url, _access = _validate_source(resolved_source)
    active_resolver = dns_resolver if dns_resolver is not None else SystemDNSResolver()
    active_transport = transport if transport is not None else PinnedTlsTransport()
    if getattr(active_transport, "supports_ip_pinning", False) is not True:
        raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "TRANSPORT_PINNING_REQUIRED")

    deadline = _clock() + total_timeout
    dns_cache: dict[str, tuple[str, ...]] = {}
    visited: set[str] = set()
    redirects = 0
    expected_cvf_path: str | None = None

    while True:
        if deadline - _clock() <= 0:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_TIMEOUT")
        parsed, target, normalized = _validated_url(current_url, adapter)
        validated_cvf_path = _validate_source_url_identity(
            parsed,
            adapter,
            source_id,
            expected_cvf_path=expected_cvf_path,
        )
        if expected_cvf_path is None and validated_cvf_path is not None:
            expected_cvf_path = validated_cvf_path
        if normalized in visited:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "REDIRECT_LOOP")
        visited.add(normalized)
        hostname = parsed.hostname
        assert hostname is not None
        if hostname not in dns_cache:
            dns_cache[hostname] = _validated_addresses(
                hostname,
                active_resolver,
                timeout=deadline - _clock(),
            )
        remaining = deadline - _clock()
        if remaining <= 0:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_TIMEOUT")
        request = PinnedRequest(
            hostname=hostname,
            ip_address=dns_cache[hostname][0],
            target=target,
            headers={
                "Accept": "application/pdf",
                "Accept-Encoding": "identity",
                "Host": hostname,
            },
            connect_timeout=min(connect_timeout, remaining),
            read_timeout=min(read_timeout, remaining),
        )
        response: object
        transport_issue: str | None = None
        try:
            response = active_transport.request(request)
        except BaseException as exc:
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            if isinstance(exc, (TimeoutError, socket.timeout)):
                transport_issue = "FETCH_TIMEOUT"
            else:
                transport_issue = "TRANSPORT_FAILED"
        if transport_issue is not None:
            raise _fail(PAPER_SLIDE_FETCH_FAILED, transport_issue)
        try:
            validated_response = _validate_response_shape(response)
            if deadline - _clock() <= 0:
                raise _fail(PAPER_SLIDE_FETCH_FAILED, "FETCH_TIMEOUT")
            if validated_response.status in _REDIRECT_STATUSES:
                location = _single_header(validated_response, "Location")
                if (
                    location is None
                    or not location
                    or not location.isascii()
                    or any(ord(char) <= 0x20 or ord(char) == 0x7F for char in location)
                ):
                    raise _fail(PAPER_SLIDE_FETCH_FAILED, "REDIRECT_LOCATION_INVALID")
                if "\\" in location or "#" in location:
                    raise _fail(PAPER_SLIDE_SOURCE_UNTRUSTED, "SOURCE_URL_INVALID")
                if redirects >= max_redirects:
                    raise _fail(PAPER_SLIDE_FETCH_FAILED, "REDIRECT_LIMIT_EXCEEDED")
                current_url = urljoin(current_url, location)
                _validated_url(current_url, adapter)
                redirects += 1
                continue
            if validated_response.status != 200:
                raise _fail(PAPER_SLIDE_FETCH_FAILED, "HTTP_STATUS_INVALID")
            expected_length = _validate_pdf_headers(validated_response, max_bytes)
            return _read_pdf(
                validated_response.response,
                max_bytes=max_bytes,
                expected_length=expected_length,
                read_timeout=read_timeout,
                deadline=deadline,
                clock=_clock,
            )
        finally:
            _close_response(response, preserve_primary=sys.exc_info()[0] is not None)


def fetch_pdf(
    resolved_source: TrustedPdfSource,
    *,
    dns_resolver: DNSResolver | None = None,
    transport: PinnedTransport | None = None,
    max_bytes: int = MAX_PDF_BYTES,
    max_redirects: int = MAX_REDIRECTS,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    read_timeout: float = DEFAULT_READ_TIMEOUT,
    total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
    _clock: Callable[[], float] = time.monotonic,
) -> PdfFetchResult:
    """Fetch one trusted resolver result through a redacted public boundary."""

    failure_pair: tuple[str, str] | None = None
    try:
        return _fetch_pdf_boundary(
            resolved_source,
            dns_resolver=dns_resolver,
            transport=transport,
            max_bytes=max_bytes,
            max_redirects=max_redirects,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
            total_timeout=total_timeout,
            _clock=_clock,
        )
    except PdfFetchError as caught:
        failure_pair = (caught.error_code, caught.issue_code)
    except Exception:
        failure_pair = (PAPER_SLIDE_FETCH_FAILED, "FETCH_INTERNAL_FAILURE")

    # Raise only after leaving the handler so no sensitive exception is kept as
    # an implicit context on the fresh public error.
    assert failure_pair is not None
    raise _fail(*failure_pair)


def _close_response(response: object, *, preserve_primary: bool) -> None:
    close_failed = False
    try:
        close = response.close  # type: ignore[attr-defined]
        if not callable(close):
            raise TypeError
        close()
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        close_failed = True
    if close_failed and not preserve_primary:
        raise _fail(PAPER_SLIDE_FETCH_FAILED, "TRANSPORT_CLOSE_FAILED")


__all__ = [
    "DEFAULT_CONNECT_TIMEOUT",
    "DEFAULT_READ_TIMEOUT",
    "DEFAULT_TOTAL_TIMEOUT",
    "MAX_PDF_BYTES",
    "MAX_REDIRECTS",
    "DNSResolver",
    "PdfFetchError",
    "PdfFetchResult",
    "PinnedRequest",
    "PinnedResponse",
    "PinnedTlsTransport",
    "PinnedTransport",
    "SystemDNSResolver",
    "TrustedPdfSource",
    "fetch_pdf",
]
