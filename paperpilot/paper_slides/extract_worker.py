"""Private stdin/stdout worker for :mod:`paperpilot.paper_slides.isolate`."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from typing import Any, NoReturn

from paperpilot.paper_slides.contract import PAPER_SLIDE_EXTRACTION_FAILED
from paperpilot.paper_slides.extract import (
    MAX_PDF_BYTES,
    PdfExtractionError,
    PdfExtractionOptions,
    PdfExtractionResult,
    extract_pdf,
)
from paperpilot.paper_slides.isolate import RESULT_SCHEMA_VERSION

_RESOURCE_KEYS = {"cpu_seconds", "max_address_space_bytes", "max_open_files"}
_OPTION_KEYS = set(asdict(PdfExtractionOptions()))
_DENIED_AUDIT_EVENTS = frozenset(
    {
        "ctypes.dlopen",
        "ctypes.dlsym",
        "ctypes.dlsym/handle",
        "os.exec",
        "os.fork",
        "os.forkpty",
        "os.posix_spawn",
        "os.spawn",
        "os.system",
        "subprocess.Popen",
    }
)


def _blocked_network(*_args: object, **_kwargs: object) -> NoReturn:
    raise PermissionError("network disabled")


def _install_python_runtime_guards() -> None:
    """Irreversibly deny Python runtime escape APIs for this process.

    Audit hooks cannot be removed through Python once registered. This blocks
    audited socket/DNS operations plus common ctypes/process bypasses, but is
    intentionally not described as a kernel sandbox or seccomp policy.
    """

    denied_events = _DENIED_AUDIT_EVENTS
    denial_error = PermissionError

    def deny_runtime_escape(event: str, _arguments: tuple[object, ...]) -> None:
        if event.startswith("socket.") or event in denied_events:
            raise denial_error("Python runtime operation disabled")

    sys.addaudithook(deny_runtime_escape)


def _disable_python_network() -> None:
    """Monkeypatch Python socket/DNS helpers as a second runtime defense."""

    import _socket
    import socket

    socket_names = (
        "socket",
        "SocketType",
        "socketpair",
        "fromfd",
        "create_connection",
        "create_server",
        "getaddrinfo",
        "gethostbyname",
        "gethostbyname_ex",
        "gethostbyaddr",
        "getnameinfo",
        "getfqdn",
    )
    low_level_names = (
        "socket",
        "socketpair",
        "getaddrinfo",
        "gethostbyname",
        "gethostbyaddr",
        "getnameinfo",
    )
    for name in socket_names:
        if hasattr(socket, name):
            setattr(socket, name, _blocked_network)
    for name in low_level_names:
        if hasattr(_socket, name):
            setattr(_socket, name, _blocked_network)


def _set_limit(resource_module: Any, name: str, value: int) -> None:
    limit = getattr(resource_module, name)
    _soft, hard = resource_module.getrlimit(limit)
    infinity = resource_module.RLIM_INFINITY
    effective = value if hard == infinity else min(value, hard)
    resource_module.setrlimit(limit, (effective, effective))


def _apply_resource_limits(policy: dict[str, int]) -> None:
    if os.name != "posix":
        raise RuntimeError("unsupported")
    import resource

    if any(
        not hasattr(resource, name)
        for name in (
            "RLIMIT_CPU",
            "RLIMIT_AS",
            "RLIMIT_FSIZE",
            "RLIMIT_CORE",
            "RLIMIT_NOFILE",
        )
    ):
        raise RuntimeError("unsupported")
    _set_limit(resource, "RLIMIT_CPU", policy["cpu_seconds"])
    _set_limit(resource, "RLIMIT_AS", policy["max_address_space_bytes"])
    _set_limit(resource, "RLIMIT_FSIZE", 0)
    _set_limit(resource, "RLIMIT_CORE", 0)
    _set_limit(resource, "RLIMIT_NOFILE", policy["max_open_files"])


def _closed_dict(value: object, expected_keys: set[str]) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("shape")
    if any(
        isinstance(item, bool) or not isinstance(item, int) or item < 1 for item in value.values()
    ):
        raise ValueError("value")
    return value


def _parse_argument(value: str, expected_keys: set[str]) -> dict[str, int]:
    if len(value) > 2048:
        raise ValueError("length")
    parsed = json.loads(value)
    return _closed_dict(parsed, expected_keys)


def _serialize_result(result: PdfExtractionResult) -> dict[str, object]:
    return {
        "pdf_sha256": result.pdf_sha256,
        "page_count": result.page_count,
        "extracted_page_count": result.extracted_page_count,
        "chunks": [
            {
                "chunk_id": chunk.chunk_id,
                "page": chunk.page,
                "text": chunk.text,
                "sha256": chunk.sha256,
                "section_hint": chunk.section_hint,
            }
            for chunk in result.chunks
        ],
        "extractor": result.extractor,
        "options": asdict(result.options),
    }


def _write_response(*, result: object = None, error: object = None) -> None:
    status = "ok" if error is None else "error"
    payload = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "status": status,
        "result": result,
        "error": error,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> int:
    # The trusted image must not contain credentials.  Clear even its benign
    # build-time environment before any untrusted bytes are read as defense in
    # depth; the parent also passes no host environment to the runtime client.
    os.environ.clear()
    try:
        if len(sys.argv) != 3:
            raise ValueError("arguments")
        resource_policy = _parse_argument(sys.argv[1], _RESOURCE_KEYS)
        option_values = _parse_argument(sys.argv[2], _OPTION_KEYS)
        _apply_resource_limits(resource_policy)
    except Exception:
        _write_response(
            error={
                "error_code": PAPER_SLIDE_EXTRACTION_FAILED,
                "issue_code": "isolation_resource_limit_failed",
            }
        )
        return 0

    os.umask(0o077)
    _install_python_runtime_guards()
    _disable_python_network()
    try:
        options = PdfExtractionOptions(**option_values)
        pdf_bytes = sys.stdin.buffer.read(min(MAX_PDF_BYTES, options.max_pdf_bytes) + 1)
        result = _serialize_result(extract_pdf(pdf_bytes, options=options))
        _write_response(result=result)
    except PdfExtractionError as error:
        _write_response(error={"error_code": error.error_code, "issue_code": error.issue_code})
    except BaseException:
        _write_response(
            error={
                "error_code": PAPER_SLIDE_EXTRACTION_FAILED,
                "issue_code": "isolation_worker_failed",
            }
        )
    return 0


if __name__ == "__main__":
    try:
        exit_status = main()
    except BaseException:
        exit_status = 1
    raise SystemExit(exit_status)
