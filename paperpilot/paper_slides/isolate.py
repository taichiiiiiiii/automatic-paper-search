"""Fail-closed SD1I container boundary for untrusted PDF parsing.

Production parsing is allowed only in an explicitly configured, digest-pinned
OCI image.  The container receives the PDF through stdin and returns one closed
JSON document through stdout.  It has no host mounts, network, capabilities, or
writable root filesystem.  The older same-UID subprocess path remains private
and is named test-only; production never falls back to it.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import suppress
from dataclasses import asdict, dataclass
from typing import Any

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
    PAPER_SLIDE_PDF_ENCRYPTED,
    PAPER_SLIDE_PDF_INVALID,
)
from paperpilot.paper_slides.extract import (
    MAX_CHUNKS,
    MAX_PAGES,
    MAX_SECTION_HINT_CODEPOINTS,
    MAX_TOTAL_CODEPOINTS,
    PdfExtractionError,
    PdfExtractionOptions,
    PdfExtractionResult,
    PdfTextChunk,
    _deduplicate_page_lines,
    _sanitize_page_text,
    _validate_options,
)

RESULT_SCHEMA_VERSION = "sd1i-result-v1"
MAX_RESULT_BYTES = 8 * 1024 * 1024
MAX_WALL_TIMEOUT_SECONDS = 60.0
MAX_CPU_SECONDS = 30
MAX_ADDRESS_SPACE_BYTES = 768 * 1024 * 1024
MAX_OPEN_FILES = 32
MAX_CONTAINER_PIDS = 32
MAX_RUNTIME_BYTES = 256 * 1024 * 1024
CONTAINER_TMPFS_BYTES = 64 * 1024 * 1024
CONTAINER_USER = "65532:65532"
CONTAINER_PYTHON = "/opt/paper-slide-worker/bin/python"
MANAGEMENT_LABEL = "io.paperpilot.sd1i=managed-v1"
RUN_LABEL_KEY = "io.paperpilot.sd1i.run"
MAX_MANAGEMENT_OUTPUT_BYTES = 4096
# One absolute deadline is shared by every query/remove/retry in a cleanup.
MAX_CLEANUP_GRACE_SECONDS = 10.0
_READ_SIZE = 64 * 1024
_MAX_RESPONSE_JSON_DEPTH = 16
_MAX_RESPONSE_JSON_CONTAINERS = 128
_MAX_RESPONSE_JSON_STRUCTURAL_TOKENS = 2048
_MAX_RESPONSE_JSON_SCALARS = 4096
_MAX_RESPONSE_JSON_STRING_CHARACTERS = 128 * 1024
_MAX_RESPONSE_JSON_NUMBER_CHARACTERS = 128
_REQUIRED_LIMITS = (
    "RLIMIT_CPU",
    "RLIMIT_AS",
    "RLIMIT_FSIZE",
    "RLIMIT_CORE",
    "RLIMIT_NOFILE",
)
_ALLOWED_CHILD_ERRORS = frozenset(
    {
        (PAPER_SLIDE_EXTRACTION_FAILED, "chunk_limit_exceeded"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "extractor_options_invalid"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_resource_limit_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_worker_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_extraction_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_limit_exceeded"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_type_invalid"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_unverifiable"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "parser_dependency_unavailable"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "parser_load_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "pdf_byte_limit_exceeded"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "pdf_page_limit_exceeded"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "total_text_limit_exceeded"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "unexpected_extraction_failure"),
        (PAPER_SLIDE_EXTRACTION_INSUFFICIENT, "extracted_text_insufficient"),
        (PAPER_SLIDE_PDF_ENCRYPTED, "pdf_encrypted"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_bytes_type"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_encryption_state_invalid"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_encryption_state_unavailable"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_malformed"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_page_count_invalid"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_page_count_mismatch"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_page_count_unavailable"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_page_iteration_failed"),
    }
)


@dataclass(frozen=True, slots=True)
class PdfIsolationPolicy:
    """Non-raiseable SD1I process ceilings."""

    wall_timeout_seconds: float = 20.0
    cpu_seconds: int = 15
    max_address_space_bytes: int = MAX_ADDRESS_SPACE_BYTES
    max_output_bytes: int = MAX_RESULT_BYTES
    max_open_files: int = MAX_OPEN_FILES
    max_container_pids: int = MAX_CONTAINER_PIDS


@dataclass(frozen=True, slots=True)
class HardenedContainerRunner:
    """Deployment-owned runtime, daemon, and credential-free worker image.

    ``image`` must be an OCI repository reference pinned by a lowercase
    sha256 digest.  Tags and mutable local image names are deliberately
    rejected.  These values are trusted deployment configuration and must
    never be populated from a request or PDF metadata.  Building the dedicated
    image and maintaining the deployment's approved digest allowlist are a
    separate release task; this boundary only enforces the supplied exact
    digest reference.
    """

    image: str
    runtime_path: str
    runtime_sha256: str
    daemon_socket_path: str


@dataclass(frozen=True, slots=True)
class _RunnerSnapshot:
    image: str
    runtime_path: str
    runtime_sha256: str
    daemon_socket_path: str


_IMMUTABLE_IMAGE_PATTERN = re.compile(
    r"(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?/)*"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}\Z"
)


def _failure(issue_code: str) -> PdfExtractionError:
    return PdfExtractionError(PAPER_SLIDE_EXTRACTION_FAILED, issue_code)


def _validate_policy(policy: PdfIsolationPolicy) -> None:
    if not isinstance(policy, PdfIsolationPolicy):
        raise _failure("isolation_policy_invalid")
    if (
        isinstance(policy.wall_timeout_seconds, bool)
        or not isinstance(policy.wall_timeout_seconds, (int, float))
        or not 0 < policy.wall_timeout_seconds <= MAX_WALL_TIMEOUT_SECONDS
    ):
        raise _failure("isolation_policy_invalid")
    integer_limits = (
        (policy.cpu_seconds, MAX_CPU_SECONDS),
        (policy.max_address_space_bytes, MAX_ADDRESS_SPACE_BYTES),
        (policy.max_output_bytes, MAX_RESULT_BYTES),
        (policy.max_open_files, MAX_OPEN_FILES),
        (policy.max_container_pids, MAX_CONTAINER_PIDS),
    )
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum
        for value, maximum in integer_limits
    ):
        raise _failure("isolation_policy_invalid")
    if policy.max_address_space_bytes < 128 * 1024 * 1024 or policy.max_open_files < 8:
        raise _failure("isolation_policy_invalid")


def _root_owned_unwritable(metadata: os.stat_result, *, directory: bool) -> bool:
    expected_kind = stat.S_ISDIR if directory else stat.S_ISREG
    return (
        expected_kind(metadata.st_mode)
        and metadata.st_uid == 0
        and not metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    )


def _validate_root_owned_parent_chain(path: str, issue_code: str) -> None:
    """Require every parent through ``/`` to be a canonical root trust chain."""

    parent = os.path.dirname(path)
    while True:
        try:
            metadata = os.lstat(parent)
        except OSError:
            raise _failure(issue_code) from None
        if not _root_owned_unwritable(metadata, directory=True):
            raise _failure(issue_code)
        if parent == os.path.sep:
            return
        next_parent = os.path.dirname(parent)
        if next_parent == parent:
            raise _failure(issue_code)
        parent = next_parent


def _validate_runtime_path_policy(runtime_path: str) -> os.stat_result:
    try:
        metadata = os.lstat(runtime_path)
    except OSError:
        raise _failure("isolation_runtime_invalid") from None
    if (
        not _root_owned_unwritable(metadata, directory=False)
        or not metadata.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        or not 1 <= metadata.st_size <= MAX_RUNTIME_BYTES
        or os.path.realpath(runtime_path) != runtime_path
    ):
        raise _failure("isolation_runtime_invalid")
    _validate_root_owned_parent_chain(runtime_path, "isolation_runtime_invalid")
    return metadata


def _hash_runtime_file(runtime_path: str, metadata: os.stat_result) -> str:
    """Hash one already-policy-checked regular file without following symlinks."""

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(runtime_path, flags)
    except OSError:
        raise _failure("isolation_runtime_invalid") from None
    digest = hashlib.sha256()
    bytes_read = 0
    try:
        opened_metadata = os.fstat(descriptor)
        if not stat.S_ISREG(opened_metadata.st_mode) or (
            opened_metadata.st_dev,
            opened_metadata.st_ino,
        ) != (metadata.st_dev, metadata.st_ino):
            raise _failure("isolation_runtime_invalid")
        while bytes_read <= MAX_RUNTIME_BYTES:
            chunk = os.read(descriptor, min(_READ_SIZE, MAX_RUNTIME_BYTES + 1 - bytes_read))
            if not chunk:
                break
            bytes_read += len(chunk)
            digest.update(chunk)
        final_metadata = os.fstat(descriptor)
    except PdfExtractionError:
        raise
    except (OSError, ValueError):
        raise _failure("isolation_runtime_invalid") from None
    finally:
        with suppress(OSError):
            os.close(descriptor)
    if (
        bytes_read != metadata.st_size
        or bytes_read > MAX_RUNTIME_BYTES
        or (final_metadata.st_dev, final_metadata.st_ino, final_metadata.st_size)
        != (metadata.st_dev, metadata.st_ino, metadata.st_size)
        or final_metadata.st_mtime_ns != metadata.st_mtime_ns
        or final_metadata.st_mode != metadata.st_mode
        or final_metadata.st_uid != metadata.st_uid
        or final_metadata.st_gid != metadata.st_gid
    ):
        raise _failure("isolation_runtime_invalid")
    return digest.hexdigest()


def _validate_runtime(
    runtime_path: str,
    expected_sha256: str,
) -> None:
    metadata = _validate_runtime_path_policy(runtime_path)
    if _hash_runtime_file(runtime_path, metadata) != expected_sha256:
        raise _failure("isolation_runtime_hash_mismatch")


def _validate_daemon_socket(daemon_socket_path: str) -> None:
    try:
        metadata = os.lstat(daemon_socket_path)
        supplementary_groups = frozenset(os.getgroups())
    except OSError:
        raise _failure("isolation_daemon_socket_invalid") from None
    if (
        not stat.S_ISSOCK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_mode & stat.S_IWOTH
        or (metadata.st_mode & stat.S_IWGRP and metadata.st_gid not in supplementary_groups)
        or os.path.realpath(daemon_socket_path) != daemon_socket_path
    ):
        raise _failure("isolation_daemon_socket_invalid")
    _validate_root_owned_parent_chain(daemon_socket_path, "isolation_daemon_socket_invalid")


def _validate_runner(runner: HardenedContainerRunner) -> _RunnerSnapshot:
    # Exact type plus one-time primitive snapshots prevent request-controlled
    # subclasses/properties from changing a checked value before argv creation.
    if type(runner) is not HardenedContainerRunner:
        raise _failure("isolation_runner_invalid")
    image = runner.image
    runtime_path = runner.runtime_path
    runtime_sha256 = runner.runtime_sha256
    daemon_socket_path = runner.daemon_socket_path
    if (
        type(image) is not str
        or not 1 <= len(image) <= 512
        or _IMMUTABLE_IMAGE_PATTERN.fullmatch(image) is None
    ):
        raise _failure("isolation_image_not_immutable")
    if (
        type(runtime_path) is not str
        or not 1 <= len(runtime_path) <= 4096
        or "\x00" in runtime_path
        or not os.path.isabs(runtime_path)
        or os.path.normpath(runtime_path) != runtime_path
        or os.path.basename(runtime_path) != "docker"
        or type(runtime_sha256) is not str
        or re.fullmatch(r"[0-9a-f]{64}", runtime_sha256) is None
        or type(daemon_socket_path) is not str
        or not 1 <= len(daemon_socket_path) <= 4096
        or "\x00" in daemon_socket_path
        or not os.path.isabs(daemon_socket_path)
        or os.path.normpath(daemon_socket_path) != daemon_socket_path
    ):
        raise _failure("isolation_runner_invalid")
    _validate_runtime(runtime_path, runtime_sha256)
    _validate_daemon_socket(daemon_socket_path)
    return _RunnerSnapshot(
        image=image,
        runtime_path=runtime_path,
        runtime_sha256=runtime_sha256,
        daemon_socket_path=daemon_socket_path,
    )


def _require_supported_platform() -> None:
    """Require every promised kernel resource limit instead of degrading."""

    # Darwin exposes RLIMIT_AS but rejects practical ceilings because the
    # process already maps the multi-gigabyte shared cache.  Treating a
    # terabyte-scale limit as memory isolation would be misleading.
    if os.name != "posix" or not sys.platform.startswith("linux"):
        raise _failure("isolation_platform_unsupported")
    try:
        import resource
    except ImportError:
        raise _failure("isolation_platform_unsupported") from None
    if not hasattr(resource, "setrlimit") or any(
        not hasattr(resource, name) for name in _REQUIRED_LIMITS
    ):
        raise _failure("isolation_platform_unsupported")


def _test_worker_command(resource_policy: str, extraction_options: str) -> tuple[str, ...]:
    """Return an argv-only command suitable for an editable or wheel install."""

    return (
        sys.executable,
        "-I",
        "-B",
        "-m",
        "paperpilot.paper_slides.extract_worker",
        resource_policy,
        extraction_options,
    )


def _container_command(
    runner: _RunnerSnapshot,
    policy: PdfIsolationPolicy,
    resource_policy: str,
    extraction_options: str,
    *,
    container_name: str,
    run_nonce: str,
) -> tuple[str, ...]:
    """Build the complete closed hardened-container argv contract."""

    return (
        runner.runtime_path,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        container_name,
        "--label",
        MANAGEMENT_LABEL,
        "--label",
        f"{RUN_LABEL_KEY}={run_nonce}",
        "--interactive",
        "--network=none",
        "--ipc=none",
        "--read-only",
        "--log-driver=none",
        "--tmpfs",
        (f"/tmp:rw,noexec,nosuid,nodev,size={CONTAINER_TMPFS_BYTES},mode=1777"),
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        "--pids-limit",
        str(policy.max_container_pids),
        "--memory",
        str(policy.max_address_space_bytes),
        "--memory-swap",
        str(policy.max_address_space_bytes),
        "--cpus",
        "1.0",
        "--ulimit",
        f"cpu={policy.cpu_seconds}:{policy.cpu_seconds}",
        "--ulimit",
        f"nofile={policy.max_open_files}:{policy.max_open_files}",
        "--ulimit",
        "core=0:0",
        "--ulimit",
        "fsize=0:0",
        "--user",
        CONTAINER_USER,
        "--workdir",
        "/tmp",
        "--entrypoint",
        CONTAINER_PYTHON,
        runner.image,
        "-I",
        "-B",
        "-m",
        "paperpilot.paper_slides.extract_worker",
        resource_policy,
        extraction_options,
    )


def _docker_environment(runner: _RunnerSnapshot, client_directory: str) -> dict[str, str]:
    return {
        "DOCKER_CONFIG": client_directory,
        "DOCKER_HOST": f"unix://{runner.daemon_socket_path}",
        "HOME": client_directory,
    }


def _bounded_management_command(
    runner: _RunnerSnapshot,
    client_directory: str,
    arguments: tuple[str, ...],
    *,
    deadline: float,
) -> bytes | None:
    process: subprocess.Popen[bytes] | None = None
    if deadline <= time.monotonic():
        return None
    try:
        process = subprocess.Popen(
            (runner.runtime_path, *arguments),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=client_directory,
            env=_docker_environment(runner, client_directory),
            close_fds=True,
            start_new_session=True,
        )
        return _bounded_exchange(
            process,
            b"",
            deadline=deadline,
            output_limit=MAX_MANAGEMENT_OUTPUT_BYTES,
            termination_deadline=deadline,
        )
    except (KeyboardInterrupt, SystemExit):
        if process is not None:
            _terminate(process, deadline=deadline)
        raise
    except BaseException:
        if process is not None:
            _terminate(process, deadline=deadline)
        return None


def _container_presence(
    runner: _RunnerSnapshot,
    client_directory: str,
    container_name: str,
    run_nonce: str,
    *,
    deadline: float,
) -> tuple[bool, str | None]:
    output = _bounded_management_command(
        runner,
        client_directory,
        (
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            f"name=^/{container_name}$",
            "--filter",
            f"label={MANAGEMENT_LABEL}",
            "--filter",
            f"label={RUN_LABEL_KEY}={run_nonce}",
        ),
        deadline=deadline,
    )
    if output is None:
        return False, None
    try:
        text = output.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError:
        return False, None
    if not text:
        return True, None
    identifiers = text.splitlines()
    if len(identifiers) != 1 or re.fullmatch(r"[0-9a-f]{64}", identifiers[0]) is None:
        return False, None
    return True, identifiers[0]


def _cleanup_container_once(
    runner: _RunnerSnapshot,
    client_directory: str,
    container_name: str,
    run_nonce: str,
    *,
    deadline: float,
) -> bool:
    query_succeeded, container_id = _container_presence(
        runner,
        client_directory,
        container_name,
        run_nonce,
        deadline=deadline,
    )
    if query_succeeded and container_id is None:
        return True
    if not query_succeeded or container_id is None:
        # Never remove by name unless the exact management label was observed;
        # an unavailable daemon/query must not risk another container.
        return False
    _bounded_management_command(
        runner,
        client_directory,
        ("rm", "--force", "--volumes", container_id),
        deadline=deadline,
    )
    verified, remaining_id = _container_presence(
        runner,
        client_directory,
        container_name,
        run_nonce,
        deadline=deadline,
    )
    return verified and remaining_id is None


def _cleanup_container(
    runner: _RunnerSnapshot,
    client_directory: str,
    container_name: str,
    run_nonce: str,
    *,
    deadline: float,
) -> tuple[bool, BaseException | None]:
    """Make at most two exact-name cleanup attempts and verify absence."""

    process_control: BaseException | None = None
    for _attempt in range(2):
        try:
            if _cleanup_container_once(
                runner,
                client_directory,
                container_name,
                run_nonce,
                deadline=deadline,
            ):
                return True, process_control
        except (KeyboardInterrupt, SystemExit) as error:
            if process_control is None:
                process_control = error
        except BaseException:
            continue
    return False, process_control


def _terminate(
    process: subprocess.Popen[bytes],
    *,
    deadline: float | None = None,
) -> None:
    # Every worker starts a new session, so its PID is also the process-group
    # ID. Kill the group even if the direct child has already exited: a
    # compromised parser may otherwise leave descendants behind.
    if os.name == "posix" and hasattr(os, "killpg"):
        with suppress(OSError):
            os.killpg(process.pid, signal.SIGKILL)
    elif process.poll() is None:
        with suppress(OSError):
            process.kill()
    wait_timeout = 2.0
    if deadline is not None:
        wait_timeout = min(wait_timeout, max(0.0, deadline - time.monotonic()))
    with suppress(OSError, subprocess.TimeoutExpired):
        process.wait(timeout=wait_timeout)


def _close_pipe(pipe: Any, selector: selectors.BaseSelector | None) -> None:
    if pipe is None:
        return
    if selector is not None:
        with suppress(KeyError, ValueError):
            selector.unregister(pipe)
    with suppress(OSError):
        pipe.close()


def _bounded_exchange(
    process: subprocess.Popen[bytes],
    payload: bytes,
    *,
    deadline: float,
    output_limit: int,
    termination_deadline: float | None = None,
) -> bytes:
    """Write stdin and drain stdout concurrently without unbounded buffering."""

    selector: selectors.BaseSelector | None = None
    try:
        output = bytearray()
        offset = 0
        if process.stdin is None or process.stdout is None:
            raise _failure("isolation_process_failed")
        selector = selectors.DefaultSelector()
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        if payload:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _failure("isolation_timeout")
            events = selector.select(remaining)
            if not events:
                raise _failure("isolation_timeout")
            for key, _ in events:
                if key.data == "stdin":
                    try:
                        written = os.write(
                            process.stdin.fileno(), payload[offset : offset + _READ_SIZE]
                        )
                    except BrokenPipeError:
                        _close_pipe(process.stdin, selector)
                        continue
                    offset += written
                    if offset == len(payload):
                        _close_pipe(process.stdin, selector)
                else:
                    chunk = os.read(
                        process.stdout.fileno(),
                        min(_READ_SIZE, output_limit + 1 - len(output)),
                    )
                    if not chunk:
                        _close_pipe(process.stdout, selector)
                        continue
                    output.extend(chunk)
                    if len(output) > output_limit:
                        raise _failure("isolation_output_limit_exceeded")

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _failure("isolation_timeout")
        try:
            return_code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise _failure("isolation_timeout") from None
        if return_code != 0:
            raise _failure("isolation_process_failed")
        return bytes(output)
    except (KeyboardInterrupt, SystemExit):
        _terminate(process, deadline=termination_deadline)
        raise
    except PdfExtractionError:
        _terminate(process, deadline=termination_deadline)
        raise
    except Exception:
        _terminate(process, deadline=termination_deadline)
        raise _failure("isolation_process_failed") from None
    finally:
        _close_pipe(process.stdin, selector)
        _close_pipe(process.stdout, selector)
        if selector is not None:
            with suppress(Exception):
                selector.close()


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _bounded_parse_int(value: str) -> int:
    if not 1 <= len(value) <= _MAX_RESPONSE_JSON_NUMBER_CHARACTERS:
        raise ValueError("integer length")
    return int(value, 10)


def _bounded_parse_float(value: str) -> float:
    if not 1 <= len(value) <= _MAX_RESPONSE_JSON_NUMBER_CHARACTERS:
        raise ValueError("float length")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("float range")
    return parsed


def _parse_json(payload: bytes) -> object:
    try:
        text = payload.decode("utf-8", errors="strict")
        depth = 0
        containers = 0
        structural_tokens = 0
        scalar_tokens = 0
        scalar_characters = 0
        in_string = False
        in_bare_scalar = False
        escaped = False
        for character in text:
            if in_string:
                scalar_characters += 1
                if scalar_characters > _MAX_RESPONSE_JSON_STRING_CHARACTERS:
                    raise ValueError("string length")
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    in_string = False
            elif character == '"':
                if in_bare_scalar:
                    raise ValueError("shape")
                scalar_tokens += 1
                scalar_characters = 0
                in_string = True
            elif character in "[{":
                if in_bare_scalar:
                    raise ValueError("shape")
                structural_tokens += 1
                containers += 1
                depth += 1
                if (
                    depth > _MAX_RESPONSE_JSON_DEPTH
                    or containers > _MAX_RESPONSE_JSON_CONTAINERS
                    or structural_tokens > _MAX_RESPONSE_JSON_STRUCTURAL_TOKENS
                ):
                    raise ValueError("depth")
            elif character in "]}":
                in_bare_scalar = False
                structural_tokens += 1
                depth -= 1
                if depth < 0:
                    raise ValueError("shape")
            elif character in ",:":
                in_bare_scalar = False
                structural_tokens += 1
            elif character.isspace():
                in_bare_scalar = False
            else:
                if not in_bare_scalar:
                    scalar_tokens += 1
                    scalar_characters = 0
                    in_bare_scalar = True
                scalar_characters += 1
                if scalar_characters > _MAX_RESPONSE_JSON_NUMBER_CHARACTERS:
                    raise ValueError("scalar length")
            if (
                structural_tokens > _MAX_RESPONSE_JSON_STRUCTURAL_TOKENS
                or scalar_tokens > _MAX_RESPONSE_JSON_SCALARS
            ):
                raise ValueError("tokens")
        if in_string or depth != 0:
            raise ValueError("shape")
        return json.loads(
            text,
            object_pairs_hook=_closed_object,
            parse_int=_bounded_parse_int,
            parse_float=_bounded_parse_float,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("constant")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, OverflowError, ValueError):
        raise _failure("isolation_protocol_invalid") from None


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_exact_keys(value: object, keys: set[str]) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value) != keys
        or not all(isinstance(key, str) for key in value)
    ):
        raise _failure("isolation_protocol_invalid")
    return value


def _decode_error(envelope: dict[str, Any]) -> None:
    error = _require_exact_keys(envelope.get("error"), {"error_code", "issue_code"})
    error_code = error["error_code"]
    issue_code = error["issue_code"]
    if (
        not isinstance(error_code, str)
        or not isinstance(issue_code, str)
        or not issue_code.isascii()
        or not 1 <= len(issue_code) <= 80
        or not all(
            character.islower() or character.isdigit() or character == "_"
            for character in issue_code
        )
    ):
        raise _failure("isolation_protocol_invalid")
    if (error_code, issue_code) not in _ALLOWED_CHILD_ERRORS:
        raise _failure("isolation_protocol_invalid")
    raise PdfExtractionError(error_code, issue_code)


def _decode_options(value: object, expected: PdfExtractionOptions) -> PdfExtractionOptions:
    expected_dict = asdict(expected)
    options = _require_exact_keys(value, set(expected_dict))
    if any(
        type(options[key]) is not type(expected_value) or options[key] != expected_value
        for key, expected_value in expected_dict.items()
    ):
        raise _failure("isolation_protocol_invalid")
    return expected


def _decode_result(
    value: object,
    *,
    pdf_bytes: bytes,
    expected_options: PdfExtractionOptions,
) -> PdfExtractionResult:
    result = _require_exact_keys(
        value,
        {"pdf_sha256", "page_count", "extracted_page_count", "chunks", "extractor", "options"},
    )
    pdf_sha256 = result["pdf_sha256"]
    page_count = result["page_count"]
    extracted_page_count = result["extracted_page_count"]
    extractor = result["extractor"]
    chunks_value = result["chunks"]
    if pdf_sha256 != hashlib.sha256(pdf_bytes).hexdigest():
        raise _failure("isolation_protocol_invalid")
    if not _is_int(page_count) or not 1 <= page_count <= min(MAX_PAGES, expected_options.max_pages):
        raise _failure("isolation_protocol_invalid")
    if not _is_int(extracted_page_count) or not 1 <= extracted_page_count <= page_count:
        raise _failure("isolation_protocol_invalid")
    if (
        not isinstance(extractor, str)
        or not extractor.startswith("pypdf:")
        or not 7 < len(extractor) <= 80
        or not extractor.isascii()
        or not all(character.isalnum() or character in ".+_-" for character in extractor[6:])
    ):
        raise _failure("isolation_protocol_invalid")
    if not isinstance(chunks_value, list) or not 1 <= len(chunks_value) <= min(
        MAX_CHUNKS, expected_options.max_chunks
    ):
        raise _failure("isolation_protocol_invalid")

    chunks: list[PdfTextChunk] = []
    page_chunk_counts: dict[int, int] = {}
    page_codepoints: dict[int, int] = {}
    seen_hashes: set[str] = set()
    seen_texts: set[str] = set()
    seen_lines: set[str] = set()
    last_page = 0
    total_codepoints = 0
    for value_chunk in chunks_value:
        chunk = _require_exact_keys(
            value_chunk,
            {"chunk_id", "page", "text", "sha256", "section_hint"},
        )
        chunk_id = chunk["chunk_id"]
        page = chunk["page"]
        text = chunk["text"]
        sha256 = chunk["sha256"]
        section_hint = chunk["section_hint"]
        if not _is_int(page) or not 1 <= page <= page_count or page < last_page:
            raise _failure("isolation_protocol_invalid")
        if not isinstance(text, str) or not 1 <= len(text) <= expected_options.max_chunk_codepoints:
            raise _failure("isolation_protocol_invalid")
        sanitized = _sanitize_page_text(text)
        if sanitized != text:
            raise _failure("isolation_protocol_invalid")
        if _deduplicate_page_lines(sanitized, seen_lines) != text:
            raise _failure("isolation_protocol_invalid")
        chunk_number = page_chunk_counts.get(page, 0) + 1
        if chunk_id != f"p{page:03d}-c{chunk_number:02d}":
            raise _failure("isolation_protocol_invalid")
        if sha256 != hashlib.sha256(text.encode("utf-8")).hexdigest():
            raise _failure("isolation_protocol_invalid")
        if sha256 in seen_hashes or text in seen_texts:
            raise _failure("isolation_protocol_invalid")
        expected_hint = text.partition("\n")[0].strip()[:MAX_SECTION_HINT_CODEPOINTS].rstrip()
        expected_hint_value = expected_hint or None
        if section_hint != expected_hint_value:
            raise _failure("isolation_protocol_invalid")
        page_chunk_counts[page] = chunk_number
        page_codepoints[page] = page_codepoints.get(page, 0) + len(text)
        if page_codepoints[page] > expected_options.max_page_codepoints:
            raise _failure("isolation_protocol_invalid")
        seen_hashes.add(sha256)
        seen_texts.add(text)
        last_page = page
        total_codepoints += len(text)
        if total_codepoints > min(MAX_TOTAL_CODEPOINTS, expected_options.max_total_codepoints):
            raise _failure("isolation_protocol_invalid")
        chunks.append(
            PdfTextChunk(
                chunk_id=chunk_id,
                page=page,
                text=text,
                sha256=sha256,
                section_hint=section_hint,
            )
        )
    if len(page_chunk_counts) != extracted_page_count:
        raise _failure("isolation_protocol_invalid")
    if total_codepoints < expected_options.minimum_text_codepoints:
        raise _failure("isolation_protocol_invalid")

    return PdfExtractionResult(
        pdf_sha256=pdf_sha256,
        page_count=page_count,
        extracted_page_count=extracted_page_count,
        chunks=tuple(chunks),
        extractor=extractor,
        options=_decode_options(result["options"], expected_options),
    )


def _decode_response(
    payload: bytes,
    *,
    pdf_bytes: bytes,
    options: PdfExtractionOptions,
) -> PdfExtractionResult:
    envelope = _require_exact_keys(
        _parse_json(payload), {"schema_version", "status", "result", "error"}
    )
    if envelope["schema_version"] != RESULT_SCHEMA_VERSION:
        raise _failure("isolation_protocol_invalid")
    if envelope["status"] == "error" and envelope["result"] is None:
        _decode_error(envelope)
    if envelope["status"] != "ok" or envelope["error"] is not None:
        raise _failure("isolation_protocol_invalid")
    return _decode_result(envelope["result"], pdf_bytes=pdf_bytes, expected_options=options)


def _serialized_worker_arguments(
    policy: PdfIsolationPolicy, options: PdfExtractionOptions
) -> tuple[str, str]:
    resource_policy = json.dumps(
        {
            "cpu_seconds": policy.cpu_seconds,
            "max_address_space_bytes": policy.max_address_space_bytes,
            "max_open_files": policy.max_open_files,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    extraction_options = json.dumps(asdict(options), sort_keys=True, separators=(",", ":"))
    return resource_policy, extraction_options


def _validated_request(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None,
    policy: PdfIsolationPolicy | None,
) -> tuple[PdfExtractionOptions, PdfIsolationPolicy]:
    effective_options = options if options is not None else PdfExtractionOptions()
    effective_policy = policy if policy is not None else PdfIsolationPolicy()
    if not isinstance(pdf_bytes, bytes):
        raise PdfExtractionError(PAPER_SLIDE_PDF_INVALID, "pdf_bytes_type")
    if not isinstance(effective_options, PdfExtractionOptions):
        raise _failure("extractor_options_invalid")
    _validate_options(effective_options)
    if len(pdf_bytes) > effective_options.max_pdf_bytes:
        raise _failure("pdf_byte_limit_exceeded")
    _validate_policy(effective_policy)
    return effective_options, effective_policy


def _extract_pdf_via_same_uid_subprocess_unsafe_for_tests(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None = None,
    policy: PdfIsolationPolicy | None = None,
) -> PdfExtractionResult:
    """TEST ONLY: run the worker as the caller UID without filesystem isolation.

    This helper exists for deterministic protocol/resource tests.  It must not
    be called by production code and is intentionally excluded from ``__all__``.
    """

    effective_options, effective_policy = _validated_request(
        pdf_bytes, options=options, policy=policy
    )
    _require_supported_platform()
    resource_policy, extraction_options = _serialized_worker_arguments(
        effective_policy, effective_options
    )
    deadline = time.monotonic() + float(effective_policy.wall_timeout_seconds)
    try:
        with tempfile.TemporaryDirectory(prefix="paperpilot-sd1i-") as temporary_directory:
            os.chmod(temporary_directory, 0o700)
            try:
                process = subprocess.Popen(
                    _test_worker_command(resource_policy, extraction_options),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    cwd=temporary_directory,
                    env={},
                    close_fds=True,
                    start_new_session=True,
                )
            except (OSError, ValueError):
                raise _failure("isolation_process_failed") from None
            response = _bounded_exchange(
                process,
                pdf_bytes,
                deadline=deadline,
                output_limit=effective_policy.max_output_bytes,
            )
            return _decode_response(response, pdf_bytes=pdf_bytes, options=effective_options)
    except PdfExtractionError:
        raise
    except Exception:
        raise _failure("isolation_process_failed") from None


def _extract_pdf_via_test_subprocess_for_tests(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None = None,
    policy: PdfIsolationPolicy | None = None,
) -> PdfExtractionResult:
    """TEST ONLY wrapper that also strips internal exception chains."""

    failure: tuple[str, str] | None = None
    try:
        return _extract_pdf_via_same_uid_subprocess_unsafe_for_tests(
            pdf_bytes, options=options, policy=policy
        )
    except PdfExtractionError as error:
        failure = (error.error_code, error.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_process_failed")
    assert failure is not None
    raise PdfExtractionError(*failure)


def _extract_pdf_in_hardened_container(
    pdf_bytes: bytes,
    *,
    runner: HardenedContainerRunner,
    options: PdfExtractionOptions | None = None,
    policy: PdfIsolationPolicy | None = None,
) -> PdfExtractionResult:
    """Extract through the required hardened container boundary."""

    effective_options, effective_policy = _validated_request(
        pdf_bytes, options=options, policy=policy
    )
    runner_snapshot = _validate_runner(runner)
    resource_policy, extraction_options = _serialized_worker_arguments(
        effective_policy, effective_options
    )
    deadline = time.monotonic() + float(effective_policy.wall_timeout_seconds)
    run_nonce = secrets.token_hex(16)
    container_name = f"paperpilot-sd1i-{run_nonce}"
    try:
        with tempfile.TemporaryDirectory(prefix="paperpilot-sd1i-client-") as temporary_directory:
            os.chmod(temporary_directory, 0o700)
            if os.listdir(temporary_directory):
                raise _failure("isolation_client_config_invalid")
            response: bytes | None = None
            pending_failure: BaseException | None = None
            start_attempted = False
            process: subprocess.Popen[bytes] | None = None
            try:
                start_attempted = True
                process = subprocess.Popen(
                    _container_command(
                        runner_snapshot,
                        effective_policy,
                        resource_policy,
                        extraction_options,
                        container_name=container_name,
                        run_nonce=run_nonce,
                    ),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    cwd=temporary_directory,
                    env=_docker_environment(runner_snapshot, temporary_directory),
                    close_fds=True,
                    start_new_session=True,
                )
                response = _bounded_exchange(
                    process,
                    pdf_bytes,
                    deadline=deadline,
                    output_limit=effective_policy.max_output_bytes,
                )
            except BaseException as error:
                pending_failure = error
                if process is not None:
                    # Always terminate the Docker client group before daemon
                    # cleanup, including GeneratorExit and the post-Popen /
                    # pre-exchange interruption window.
                    _terminate(process)
            cleanup_succeeded = True
            cleanup_process_control: BaseException | None = None
            if start_attempted:
                cleanup_deadline = time.monotonic() + MAX_CLEANUP_GRACE_SECONDS
                cleanup_succeeded, cleanup_process_control = _cleanup_container(
                    runner_snapshot,
                    temporary_directory,
                    container_name,
                    run_nonce,
                    deadline=cleanup_deadline,
                )
            if isinstance(pending_failure, (KeyboardInterrupt, SystemExit)):
                raise pending_failure
            if cleanup_process_control is not None:
                raise cleanup_process_control
            if not cleanup_succeeded:
                raise _failure("isolation_cleanup_failed")
            if pending_failure is not None:
                raise pending_failure
            assert response is not None
            return _decode_response(response, pdf_bytes=pdf_bytes, options=effective_options)
    except PdfExtractionError:
        raise
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        raise _failure("isolation_process_failed") from None


def extract_pdf_isolated(
    pdf_bytes: bytes,
    *,
    runner: HardenedContainerRunner | None = None,
    options: PdfExtractionOptions | None = None,
    policy: PdfIsolationPolicy | None = None,
) -> PdfExtractionResult:
    """Extract in an explicitly configured hardened container.

    No runner means no parsing.  In particular, this function never falls back
    to the same-UID test subprocess when Docker is absent or fails.
    """

    failure: tuple[str, str] | None = None
    try:
        if runner is None:
            raise _failure("isolation_runner_required")
        return _extract_pdf_in_hardened_container(
            pdf_bytes, runner=runner, options=options, policy=policy
        )
    except PdfExtractionError as error:
        failure = (error.error_code, error.issue_code)
    except Exception:
        failure = (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_process_failed")

    # This raise occurs after the handled exception has left scope.  A fresh
    # exception therefore has neither __cause__ nor __context__, even when an
    # internal parser/process exception contained sensitive input.
    assert failure is not None
    raise PdfExtractionError(*failure)


__all__ = [
    "MAX_ADDRESS_SPACE_BYTES",
    "MAX_CONTAINER_PIDS",
    "MAX_CPU_SECONDS",
    "MAX_OPEN_FILES",
    "MAX_RESULT_BYTES",
    "MAX_WALL_TIMEOUT_SECONDS",
    "RESULT_SCHEMA_VERSION",
    "HardenedContainerRunner",
    "PdfIsolationPolicy",
    "extract_pdf_isolated",
]
