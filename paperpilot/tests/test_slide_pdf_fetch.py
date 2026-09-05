from __future__ import annotations

import hashlib
import io
import socket
import threading
from collections.abc import Sequence
from dataclasses import replace
from typing import cast
from urllib.parse import parse_qs, urlsplit

import pytest

import paperpilot.paper_slides.fetch as fetch_module
from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_FETCH_FAILED,
    PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
    PAPER_SLIDE_PDF_INVALID,
    PAPER_SLIDE_SOURCE_RESTRICTED,
    PAPER_SLIDE_SOURCE_UNTRUSTED,
)
from paperpilot.paper_slides.fetch import (
    MAX_REDIRECTS,
    PdfFetchError,
    PinnedRequest,
    PinnedResponse,
    PinnedTransport,
    TrustedPdfSource,
    fetch_pdf,
)
from paperpilot.paper_slides.resolver import AccessKind, ResolvedPDFSource, SourceName

PUBLIC_V4 = "93.184.216.34"
PDF = b"%PDF-1.7\nfixture"


def Source(  # noqa: N802 - compact trusted-source factory for security cases
    source: SourceName = "arxiv",
    pdf_url: str = "https://arxiv.org/pdf/2601.01234",
    access: AccessKind = "open_access",
    *,
    source_id: str | None = None,
) -> ResolvedPDFSource:
    parts = urlsplit(pdf_url)
    if source_id is None:
        if source == "arxiv" and parts.path.startswith("/pdf/"):
            source_id = parts.path.removeprefix("/pdf/")
        elif source == "openreview":
            source_id = parse_qs(parts.query).get("id", ["2601.01234"])[0]
        elif source in {"acl_anthology", "cvf"}:
            source_id = parts.path.rsplit("/", 1)[-1].removesuffix(".pdf")
        else:
            source_id = "2601.01234"
    if source == "arxiv":
        landing_url = f"https://arxiv.org/abs/{source_id}"
    elif source == "openreview":
        landing_url = f"https://openreview.net/forum?id={source_id}"
    elif source == "acl_anthology":
        landing_url = f"https://aclanthology.org/{source_id}/"
    else:
        collection = parts.path.split("/")[2]
        landing_url = f"https://openaccess.thecvf.com/content/{collection}/html/{source_id}.html"
    return ResolvedPDFSource(
        paper_id=make_paper_id(source, source_id),
        source=source,
        source_id=source_id,
        landing_url=landing_url,
        pdf_url=pdf_url,
        access=access,
        license="unknown",
        license_evidence_url=None,
    )


class FakeDNS:
    def __init__(self, answers: Sequence[str] | Sequence[Sequence[str]]) -> None:
        if answers and isinstance(answers[0], str):
            self._answers = [tuple(cast(Sequence[str], answers))]
        else:
            self._answers = [tuple(item) for item in answers]
        self.calls: list[tuple[str, int]] = []

    def resolve(self, hostname: str, port: int, *, timeout: float) -> tuple[str, ...]:
        assert timeout > 0
        self.calls.append((hostname, port))
        index = min(len(self.calls) - 1, len(self._answers) - 1)
        return self._answers[index]


class FakeTransport:
    supports_ip_pinning = True

    def __init__(self, responses: Sequence[PinnedResponse]) -> None:
        self.responses = list(responses)
        self.requests: list[PinnedRequest] = []

    def request(self, request: PinnedRequest) -> PinnedResponse:
        self.requests.append(request)
        lowered = {name.casefold() for name in request.headers}
        assert "authorization" not in lowered
        assert "proxy-authorization" not in lowered
        assert "cookie" not in lowered
        assert request.headers == {
            "Accept": "application/pdf",
            "Accept-Encoding": "identity",
            "Host": request.hostname,
        }
        if not self.responses:
            raise AssertionError("unexpected transport request")
        return self.responses.pop(0)


def response(
    body: bytes = PDF,
    *,
    status: int = 200,
    headers: Sequence[tuple[str, str]] | None = None,
) -> PinnedResponse:
    default_headers = (("Content-Type", "application/pdf"),)
    return PinnedResponse(status, tuple(headers or default_headers), io.BytesIO(body))


@pytest.fixture(autouse=True)
def no_live_network_or_ambient_credentials(monkeypatch: pytest.MonkeyPatch):
    calls = {"dns": 0, "connect": 0, "socket": 0}

    def forbidden_dns(*args: object, **kwargs: object) -> object:
        del args, kwargs
        calls["dns"] += 1
        raise AssertionError("live DNS is forbidden")

    def forbidden_connect(*args: object, **kwargs: object) -> object:
        del args, kwargs
        calls["connect"] += 1
        raise AssertionError("live network is forbidden")

    def forbidden_socket(*args: object, **kwargs: object) -> object:
        del args, kwargs
        calls["socket"] += 1
        raise AssertionError("live socket is forbidden")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden_dns)
    monkeypatch.setattr(socket, "create_connection", forbidden_connect)
    monkeypatch.setattr(socket, "socket", forbidden_socket)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:8080")
    monkeypatch.setenv("NETRC", "/definitely/not/a/netrc")
    yield
    assert calls == {"dns": 0, "connect": 0, "socket": 0}


def assert_error(
    expected_error: str,
    expected_issue: str,
    function,
) -> PdfFetchError:
    with pytest.raises(PdfFetchError) as captured:
        function()
    error = cast(PdfFetchError, captured.value)
    assert error.error_code == expected_error
    assert error.issue_code == expected_issue
    assert str(error) == f"{expected_error}:{expected_issue}"
    assert error.__cause__ is None
    assert error.__context__ is None
    return error


def test_fetch_returns_redacted_result_and_uses_pinned_ip() -> None:
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport((response(),))

    result = fetch_pdf(Source(), dns_resolver=dns, transport=transport)

    assert result.pdf_bytes == PDF
    assert result.byte_count == len(PDF)
    assert result.sha256 == hashlib.sha256(PDF).hexdigest()
    assert "fixture" not in repr(result)
    assert dns.calls == [("arxiv.org", 443)]
    assert transport.requests[0].ip_address == PUBLIC_V4
    assert transport.requests[0].hostname == "arxiv.org"
    assert transport.requests[0].target == "/pdf/2601.01234"
    assert transport.requests[0].connect_timeout <= 10.0
    assert transport.requests[0].read_timeout <= 20.0


@pytest.mark.parametrize(
    ("source_name", "url", "host"),
    (
        ("arxiv", "https://arxiv.org/pdf/2601.01234", "arxiv.org"),
        ("openreview", "https://openreview.net/pdf?id=x", "openreview.net"),
        ("acl_anthology", "https://aclanthology.org/x.pdf", "aclanthology.org"),
        ("cvf", "https://openaccess.thecvf.com/content/x/papers/x.pdf", "openaccess.thecvf.com"),
    ),
)
def test_exact_adapter_host_policy(source_name: str, url: str, host: str) -> None:
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport((response(),))

    fetch_pdf(Source(source_name, url), dns_resolver=dns, transport=transport)

    assert dns.calls == [(host, 443)]
    assert transport.requests[0].hostname == host


@pytest.mark.parametrize(
    ("url", "issue"),
    (
        ("http://arxiv.org/pdf/2601.01234", "SOURCE_URL_INVALID"),
        ("https://user@arxiv.org/pdf/2601.01234", "SOURCE_URL_INVALID"),
        ("https://arxiv.org:444/pdf/2601.01234", "SOURCE_PORT_INVALID"),
        ("https://arxiv.org:/pdf/2601.01234", "SOURCE_PORT_INVALID"),
        ("https://127.0.0.1/pdf/2601.01234", "SOURCE_IP_LITERAL"),
        ("https://arxiv.org/pdf/2601.01234#fragment", "SOURCE_URL_INVALID"),
        ("https://arxiv.org/pdf/2601.01234#", "SOURCE_URL_INVALID"),
        ("https://arxiv.org\\@127.0.0.1/pdf/2601.01234", "SOURCE_URL_INVALID"),
    ),
)
def test_invalid_redirect_url_forms_are_rejected(url: str, issue: str) -> None:
    dns = FakeDNS((PUBLIC_V4,))
    redirect = response(status=302, headers=(("Location", url),))
    transport = FakeTransport((redirect,))

    error = assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        issue,
        lambda: fetch_pdf(Source(), dns_resolver=dns, transport=transport),
    )

    assert url not in str(error)
    assert dns.calls == [("arxiv.org", 443)]
    assert len(transport.requests) == 1
    assert redirect.stream.closed


def test_suffix_confusion_is_rejected_exactly() -> None:
    dns = FakeDNS((PUBLIC_V4,))
    redirect = response(
        status=302,
        headers=(("Location", "https://arxiv.org.attacker.invalid/paper.pdf"),),
    )
    transport = FakeTransport((redirect,))

    error = assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_HOST_UNTRUSTED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=dns,
            transport=transport,
        ),
    )

    assert "attacker" not in str(error)
    assert dns.calls == [("arxiv.org", 443)]
    assert len(transport.requests) == 1
    assert redirect.stream.closed


@pytest.mark.parametrize(
    "trusted_source",
    (
        Source("arxiv", "https://arxiv.org/pdf/other", source_id="2601.01234"),
        Source(
            "openreview",
            "https://openreview.net/pdf?id=other",
            source_id="AbC_123-x",
        ),
        Source(
            "acl_anthology",
            "https://aclanthology.org/other.pdf",
            source_id="2025.acl-long.153",
        ),
        Source(
            "cvf",
            "https://openaccess.thecvf.com/content/CVPR2025/papers/other.pdf",
            source_id="Paper_CVPR_2025_paper",
        ),
    ),
)
def test_forged_same_host_source_id_is_rejected_before_dns(
    trusted_source: ResolvedPDFSource,
) -> None:
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport(())

    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_PROVENANCE_MISMATCH",
        lambda: fetch_pdf(trusted_source, dns_resolver=dns, transport=transport),
    )

    assert dns.calls == []
    assert transport.requests == []


@pytest.mark.parametrize(
    "forged_source",
    (
        replace(Source(), landing_url="https://arxiv.org/abs/2601.99999"),
        replace(Source(), access="unknown"),
        replace(Source(), license="MIT"),
        replace(Source(), license_evidence_url="https://arxiv.org/license"),
    ),
)
def test_complete_resolver_provenance_is_revalidated(
    forged_source: ResolvedPDFSource,
) -> None:
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport(())

    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_PROVENANCE_MISMATCH",
        lambda: fetch_pdf(forged_source, dns_resolver=dns, transport=transport),
    )

    assert dns.calls == []
    assert transport.requests == []


def test_cvf_landing_and_pdf_must_bind_the_same_collection() -> None:
    source_id = "Paper_CVPR_2025_paper"
    trusted = Source(
        "cvf",
        f"https://openaccess.thecvf.com/content/CVPR2025/papers/{source_id}.pdf",
    )
    forged = replace(
        trusted,
        landing_url=(f"https://openaccess.thecvf.com/content/ICCV2025/html/{source_id}.html"),
    )
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport(())

    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_PROVENANCE_MISMATCH",
        lambda: fetch_pdf(forged, dns_resolver=dns, transport=transport),
    )

    assert dns.calls == []
    assert transport.requests == []


@pytest.mark.parametrize(
    "address",
    (
        "127.0.0.1",
        "10.0.0.1",
        "169.254.2.3",
        "224.0.0.1",
        "192.0.2.1",
        "0.0.0.0",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:93.184.216.34",
        "2002:5db8:d822::",
        "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    ),
)
def test_non_public_dns_classes_are_rejected(address: str) -> None:
    transport = FakeTransport(())
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "DNS_ADDRESS_UNTRUSTED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((address,)),
            transport=transport,
        ),
    )
    assert transport.requests == []


@pytest.mark.parametrize("address", ("100.100.100.200", "168.63.129.16", "169.254.169.254"))
def test_metadata_addresses_are_rejected(address: str) -> None:
    transport = FakeTransport(())
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "DNS_ADDRESS_UNTRUSTED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((address,)),
            transport=transport,
        ),
    )
    assert transport.requests == []


def test_one_private_answer_rejects_the_entire_mixed_dns_set() -> None:
    transport = FakeTransport(())
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "DNS_ADDRESS_UNTRUSTED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4, "10.0.0.9")),
            transport=transport,
        ),
    )
    assert transport.requests == []


def test_dns_rebind_is_prevented_by_cache_and_pinned_request() -> None:
    dns = FakeDNS(((PUBLIC_V4,), ("127.0.0.1",)))
    first = response(
        status=302,
        headers=(("Location", "https://arxiv.org:443/pdf/2601.01234"),),
    )
    second = response()
    transport = FakeTransport((first, second))

    fetch_pdf(Source(), dns_resolver=dns, transport=transport)

    assert dns.calls == [("arxiv.org", 443)]
    assert [item.ip_address for item in transport.requests] == [PUBLIC_V4, PUBLIC_V4]
    assert first.stream.closed
    assert second.stream.closed


def test_transport_without_real_pinning_boundary_fails_closed() -> None:
    class UnpinnedTransport(FakeTransport):
        supports_ip_pinning = False

    dns = FakeDNS((PUBLIC_V4,))
    transport = UnpinnedTransport(())
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "TRANSPORT_PINNING_REQUIRED",
        lambda: fetch_pdf(Source(), dns_resolver=dns, transport=transport),
    )
    assert dns.calls == []


def test_transport_pinning_capability_exception_is_redacted_at_public_boundary() -> None:
    class ExplodingPinningTransport:
        @property
        def supports_ip_pinning(self) -> bool:
            raise RuntimeError("secret capability marker")

        def request(self, request: PinnedRequest) -> PinnedResponse:
            del request
            raise AssertionError("request must not be reached")

    dns = FakeDNS((PUBLIC_V4,))
    error = assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "FETCH_INTERNAL_FAILURE",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=dns,
            transport=cast(PinnedTransport, ExplodingPinningTransport()),
        ),
    )

    assert "secret" not in str(error)
    assert dns.calls == []


@pytest.mark.parametrize("attribute", ("status", "headers"))
def test_response_attribute_exception_is_stable_and_redacted(attribute: str) -> None:
    class ExplodingResponse(PinnedResponse):
        def __getattribute__(self, name: str):
            if name == attribute:
                raise RuntimeError("secret response marker")
            return super().__getattribute__(name)

    item = ExplodingResponse(
        200,
        (("Content-Type", "application/pdf"),),
        io.BytesIO(PDF),
    )
    error = assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "TRANSPORT_RESPONSE_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )

    assert "secret" not in str(error)
    assert item.stream.closed


@pytest.mark.parametrize("exception_type", (KeyboardInterrupt, SystemExit))
def test_public_boundary_preserves_process_control_exceptions(
    exception_type: type[BaseException],
) -> None:
    class InterruptingTransport:
        @property
        def supports_ip_pinning(self) -> bool:
            raise exception_type

        def request(self, request: PinnedRequest) -> PinnedResponse:
            del request
            raise AssertionError("request must not be reached")

    with pytest.raises(exception_type):
        fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=cast(PinnedTransport, InterruptingTransport()),
        )


@pytest.mark.parametrize(
    ("operation", "exception_type"),
    (
        ("header_values", KeyboardInterrupt),
        ("read", SystemExit),
        ("close", KeyboardInterrupt),
    ),
)
def test_response_operations_preserve_process_control_exceptions(
    operation: str,
    exception_type: type[BaseException],
) -> None:
    class InterruptingResponse(PinnedResponse):
        def header_values(self, name: str) -> tuple[str, ...]:
            if operation == "header_values":
                raise exception_type
            return super().header_values(name)

        def read(self, amount: int, *, timeout: float) -> bytes:
            if operation == "read":
                raise exception_type
            return super().read(amount, timeout=timeout)

        def close(self) -> None:
            if operation == "close":
                raise exception_type
            super().close()

    item = InterruptingResponse(
        200,
        (("Content-Type", "application/pdf"),),
        io.BytesIO(PDF),
    )
    with pytest.raises(exception_type):
        fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        )


def test_redirect_to_ip_literal_is_rejected_and_location_redacted() -> None:
    redirect = response(
        status=302,
        headers=(("Location", "https://169.254.169.254/latest/secret"),),
    )
    transport = FakeTransport((redirect,))

    error = assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_IP_LITERAL",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=transport,
        ),
    )

    assert "169.254" not in str(error)
    assert "secret" not in str(error)
    assert redirect.stream.closed


def test_redirect_to_other_adapter_host_is_rejected() -> None:
    redirect = response(
        status=302,
        headers=(("Location", "https://openreview.net/pdf?id=secret"),),
    )
    transport = FakeTransport((redirect,))
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_HOST_UNTRUSTED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=transport,
        ),
    )
    assert redirect.stream.closed


@pytest.mark.parametrize(
    ("trusted_source", "location"),
    (
        (Source(), "/pdf/2601.99999"),
        (
            Source(
                "openreview",
                "https://openreview.net/pdf?id=AbC_123-x",
            ),
            "/pdf?id=changed",
        ),
        (
            Source(
                "acl_anthology",
                "https://aclanthology.org/2025.acl-long.153.pdf",
            ),
            "/2025.acl-long.999.pdf",
        ),
        (
            Source(
                "cvf",
                "https://openaccess.thecvf.com/content/CVPR2025/papers/Paper_CVPR_2025_paper.pdf",
            ),
            "/content/CVPR2025/papers/Other_CVPR_2025_paper.pdf",
        ),
    ),
)
def test_redirect_cannot_switch_paper_identity(
    trusted_source: ResolvedPDFSource,
    location: str,
) -> None:
    redirect = response(status=302, headers=(("Location", location),))
    transport = FakeTransport((redirect,))
    dns = FakeDNS((PUBLIC_V4,))

    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_URL_IDENTITY_MISMATCH",
        lambda: fetch_pdf(trusted_source, dns_resolver=dns, transport=transport),
    )

    assert len(transport.requests) == 1
    assert redirect.stream.closed


def test_redirect_loop_is_bounded_and_every_response_is_closed() -> None:
    first = response(
        status=302,
        headers=(("Location", "https://arxiv.org:443/pdf/2601.01234"),),
    )
    second = response(status=302, headers=(("Location", "https://arxiv.org/pdf/2601.01234"),))
    transport = FakeTransport((first, second))

    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "REDIRECT_LOOP",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=transport,
        ),
    )

    assert len(transport.requests) == 2
    assert first.stream.closed
    assert second.stream.closed


def test_configured_redirect_hop_limit_is_enforced() -> None:
    assert MAX_REDIRECTS == 3
    redirect = response(
        status=302,
        headers=(("Location", "https://arxiv.org:443/pdf/2601.01234"),),
    )
    transport = FakeTransport((redirect,))

    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "REDIRECT_LIMIT_EXCEEDED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=transport,
            max_redirects=0,
        ),
    )

    assert len(transport.requests) == 1
    assert redirect.stream.closed


@pytest.mark.parametrize(
    "item",
    (
        PinnedResponse(True, (), io.BytesIO()),
        PinnedResponse(99, (), io.BytesIO()),
        PinnedResponse(600, (), io.BytesIO()),
        PinnedResponse(200, [("Content-Type", "application/pdf")], io.BytesIO()),  # type: ignore[arg-type]
        PinnedResponse(200, (("Bad Header", "value"),), io.BytesIO()),
        PinnedResponse(200, (("X-Test", "line\nbreak"),), io.BytesIO()),
        PinnedResponse(
            200,
            tuple((f"X-{index}", "v") for index in range(129)),
            io.BytesIO(),
        ),
        PinnedResponse(200, (("X-Test", "v" * 8193),), io.BytesIO()),
    ),
)
def test_malformed_response_status_and_headers_are_bounded(item: PinnedResponse) -> None:
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "TRANSPORT_RESPONSE_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert item.stream.closed


def test_malformed_header_and_read_behaviors_are_redacted() -> None:
    class ExplodingHeaders(PinnedResponse):
        def header_values(self, name: str) -> tuple[str, ...]:
            del name
            raise ValueError("sensitive header detail")

    class ExplodingRead(PinnedResponse):
        def read(self, amount: int, *, timeout: float) -> bytes:
            del amount, timeout
            raise ValueError("sensitive body detail")

    bad_headers = ExplodingHeaders(
        200,
        (("Content-Type", "application/pdf"),),
        io.BytesIO(PDF),
    )
    bad_read = ExplodingRead(
        200,
        (("Content-Type", "application/pdf"),),
        io.BytesIO(PDF),
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "TRANSPORT_RESPONSE_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((bad_headers,)),
        ),
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "TRANSPORT_READ_FAILED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((bad_read,)),
        ),
    )
    assert bad_headers.stream.closed
    assert bad_read.stream.closed


def test_non_200_and_missing_redirect_location_are_stable_and_closed() -> None:
    forbidden = response(status=403)
    missing_location = response(status=302, headers=(("X-Secret", "private"),))

    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "HTTP_STATUS_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((forbidden,)),
        ),
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "REDIRECT_LOCATION_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((missing_location,)),
        ),
    )
    assert forbidden.stream.closed
    assert missing_location.stream.closed


def test_dns_and_transport_timeouts_are_stable() -> None:
    class TimeoutDNS:
        def resolve(self, hostname: str, port: int, *, timeout: float) -> tuple[str, ...]:
            del hostname, port, timeout
            raise TimeoutError("sensitive DNS detail")

    class TimeoutTransport(FakeTransport):
        def request(self, request: PinnedRequest) -> PinnedResponse:
            del request
            raise TimeoutError("sensitive socket detail")

    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "FETCH_TIMEOUT",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=TimeoutDNS(),
            transport=FakeTransport(()),
        ),
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "FETCH_TIMEOUT",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=TimeoutTransport(()),
        ),
    )


def test_timed_out_system_dns_threads_are_process_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    lookup_calls = 0

    def blocked_getaddrinfo(*args: object, **kwargs: object) -> list[tuple[object, ...]]:
        nonlocal lookup_calls
        del args, kwargs
        lookup_calls += 1
        entered.set()
        try:
            assert release.wait(2)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_V4, 443))]
        finally:
            finished.set()

    monkeypatch.setattr(fetch_module, "_DNS_LOOKUP_SLOTS", threading.BoundedSemaphore(1))
    monkeypatch.setattr(socket, "getaddrinfo", blocked_getaddrinfo)

    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "FETCH_TIMEOUT",
        lambda: fetch_pdf(
            Source(),
            transport=FakeTransport(()),
            total_timeout=0.01,
        ),
    )
    assert entered.is_set()
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "DNS_LOOKUP_SATURATED",
        lambda: fetch_pdf(Source(), transport=FakeTransport(())),
    )
    assert lookup_calls == 1

    release.set()
    assert finished.wait(2)


def test_close_failure_is_redacted() -> None:
    class FailingClose(io.BytesIO):
        def close(self) -> None:
            raise ValueError("sensitive close detail")

    item = PinnedResponse(
        status=200,
        headers=(("Content-Type", "application/pdf"),),
        stream=FailingClose(PDF),
    )
    error = assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "TRANSPORT_CLOSE_FAILED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert "sensitive" not in str(error)
    assert "secret" not in str(error)


def test_primary_failure_wins_when_close_also_fails() -> None:
    class FailingClose(io.BytesIO):
        def close(self) -> None:
            raise ValueError("sensitive close detail")

    item = PinnedResponse(status=403, headers=(), stream=FailingClose(b"secret body"))
    error = assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "HTTP_STATUS_INVALID",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert "sensitive" not in str(error)
    assert "secret" not in str(error)


def test_content_length_over_limit_fails_without_reading_body() -> None:
    item = response(
        headers=(
            ("Content-Type", "application/pdf"),
            ("Content-Length", "17"),
        )
    )
    transport = FakeTransport((item,))

    assert_error(
        PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
        "CONTENT_LENGTH_LIMIT_EXCEEDED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=transport,
            max_bytes=16,
        ),
    )
    assert item.stream.closed


def test_content_length_lie_still_hits_stream_limit() -> None:
    item = response(
        b"%PDF-" + b"x" * 20,
        headers=(
            ("Content-Type", "application/pdf"),
            ("Content-Length", "6"),
        ),
    )
    assert_error(
        PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
        "BODY_LIMIT_EXCEEDED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
            max_bytes=16,
        ),
    )
    assert item.stream.closed


def test_content_length_larger_than_actual_body_is_rejected() -> None:
    item = response(
        headers=(
            ("Content-Type", "application/pdf"),
            ("Content-Length", str(len(PDF) + 1)),
        )
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "CONTENT_LENGTH_MISMATCH",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert item.stream.closed


def test_duplicate_security_header_is_rejected() -> None:
    item = response(
        headers=(
            ("Content-Type", "application/pdf"),
            ("content-type", "application/pdf"),
        )
    )
    assert_error(
        PAPER_SLIDE_FETCH_FAILED,
        "RESPONSE_HEADER_AMBIGUOUS",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert item.stream.closed


def test_stream_without_content_length_is_bounded() -> None:
    item = response(b"%PDF-" + b"x" * 20)
    assert_error(
        PAPER_SLIDE_FETCH_LIMIT_EXCEEDED,
        "BODY_LIMIT_EXCEEDED",
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
            max_bytes=16,
        ),
    )
    assert item.stream.closed


@pytest.mark.parametrize(
    ("headers", "body", "issue"),
    (
        ((("Content-Type", "text/html"),), PDF, "CONTENT_TYPE_INVALID"),
        ((("Content-Type", "application/pdf"),), b"not a PDF", "PDF_MAGIC_INVALID"),
        (
            (
                ("Content-Type", "application/pdf"),
                ("Content-Encoding", "gzip"),
            ),
            PDF,
            "CONTENT_ENCODING_INVALID",
        ),
    ),
)
def test_non_pdf_or_encoded_body_is_rejected(
    headers: Sequence[tuple[str, str]], body: bytes, issue: str
) -> None:
    item = response(body, headers=headers)
    assert_error(
        PAPER_SLIDE_PDF_INVALID,
        issue,
        lambda: fetch_pdf(
            Source(),
            dns_resolver=FakeDNS((PUBLIC_V4,)),
            transport=FakeTransport((item,)),
        ),
    )
    assert item.stream.closed


def test_restricted_and_arbitrary_url_inputs_never_reach_dependencies() -> None:
    dns = FakeDNS((PUBLIC_V4,))
    transport = FakeTransport(())
    assert_error(
        PAPER_SLIDE_SOURCE_RESTRICTED,
        "SOURCE_ACCESS_RESTRICTED",
        lambda: fetch_pdf(
            Source(access="restricted"),
            dns_resolver=dns,
            transport=transport,
        ),
    )
    assert_error(
        PAPER_SLIDE_SOURCE_UNTRUSTED,
        "SOURCE_OBJECT_INVALID",
        lambda: fetch_pdf(
            cast(TrustedPdfSource, "https://arxiv.org/pdf/client-controlled"),
            dns_resolver=dns,
            transport=transport,
        ),
    )
    assert dns.calls == []
    assert transport.requests == []
