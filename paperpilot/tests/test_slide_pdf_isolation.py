"""SD1I hardened-container and test-only protocol isolation tests."""

from __future__ import annotations

import hashlib
import json
import os
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from dataclasses import asdict
from io import BytesIO
from pathlib import Path

import pytest

from paperpilot.paper_slides import isolate as isolation
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_FAILED,
    PAPER_SLIDE_PDF_INVALID,
)
from paperpilot.paper_slides.extract import (
    PdfExtractionError,
    PdfExtractionOptions,
    PdfExtractionResult,
    extract_pdf,
)
from paperpilot.paper_slides.isolate import (
    HardenedContainerRunner,
    PdfIsolationPolicy,
)
from paperpilot.paper_slides.isolate import (
    extract_pdf_isolated as production_extract_pdf_isolated,
)


def extract_pdf_isolated(
    pdf_bytes: bytes,
    *,
    options: PdfExtractionOptions | None = None,
    policy: PdfIsolationPolicy | None = None,
) -> PdfExtractionResult:
    """Exercise the explicitly test-only subprocess protocol helper."""

    return isolation._extract_pdf_via_test_subprocess_for_tests(
        pdf_bytes, options=options, policy=policy
    )


def _unique_text(prefix: str, count: int = 80) -> str:
    return " ".join(f"{prefix}{index:03d}" for index in range(count))


def _in_memory_pdf() -> bytes:
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    content = DecodedStreamObject()
    content.set_data(f"BT /F1 12 Tf 72 720 Td ({_unique_text('visible')}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _error_response(error_code: str, issue_code: str) -> str:
    return json.dumps(
        {
            "schema_version": isolation.RESULT_SCHEMA_VERSION,
            "status": "error",
            "result": None,
            "error": {"error_code": error_code, "issue_code": issue_code},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _success_response(
    pdf_bytes: bytes,
    *,
    page_texts: tuple[tuple[int, str], ...] | None = None,
    options: PdfExtractionOptions | None = None,
) -> str:
    effective_options = options or PdfExtractionOptions()
    effective_page_texts = page_texts or ((1, _unique_text("safe")),)
    page_chunk_counts: dict[int, int] = {}
    chunks: list[dict[str, object]] = []
    for page, text in effective_page_texts:
        chunk_number = page_chunk_counts.get(page, 0) + 1
        page_chunk_counts[page] = chunk_number
        hint = text.partition("\n")[0].strip()[:160].rstrip() or None
        chunks.append(
            {
                "chunk_id": f"p{page:03d}-c{chunk_number:02d}",
                "page": page,
                "text": text,
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "section_hint": hint,
            }
        )
    return json.dumps(
        {
            "schema_version": isolation.RESULT_SCHEMA_VERSION,
            "status": "ok",
            "result": {
                "pdf_sha256": hashlib.sha256(pdf_bytes).hexdigest(),
                "page_count": max(page for page, _text in effective_page_texts),
                "extracted_page_count": len(page_chunk_counts),
                "chunks": chunks,
                "extractor": "pypdf:test",
                "options": asdict(effective_options),
            },
            "error": None,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _allow_fake_worker(monkeypatch: pytest.MonkeyPatch, source: str) -> None:
    monkeypatch.setattr(isolation, "_require_supported_platform", lambda: None)
    monkeypatch.setattr(
        isolation,
        "_test_worker_command",
        lambda _resource_policy, _extraction_options: (sys.executable, "-I", "-B", "-c", source),
    )


def _assert_isolation_error(caught: pytest.ExceptionInfo[PdfExtractionError], issue: str) -> None:
    assert caught.value.error_code == PAPER_SLIDE_EXTRACTION_FAILED
    assert caught.value.issue_code == issue
    assert caught.value.__dict__ == {
        "error_code": PAPER_SLIDE_EXTRACTION_FAILED,
        "issue_code": issue,
    }
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def _runner_shape(
    *,
    image: str = "registry.example/paperpilot/pdf-worker@sha256:" + "a" * 64,
    runtime_path: str = "/opt/trusted/bin/docker",
    runtime_sha256: str = "b" * 64,
    daemon_socket_path: str = "/opt/trusted/run/docker.sock",
) -> HardenedContainerRunner:
    return HardenedContainerRunner(
        image=image,
        runtime_path=runtime_path,
        runtime_sha256=runtime_sha256,
        daemon_socket_path=daemon_socket_path,
    )


@pytest.fixture
def immutable_runner(monkeypatch: pytest.MonkeyPatch) -> Iterator[HardenedContainerRunner]:
    with tempfile.TemporaryDirectory(
        prefix="paperpilot-runner-test-",
        dir="/private/tmp" if Path("/private/tmp").is_dir() else None,
    ) as directory:
        trusted_directory = Path(directory).resolve()
        runtime_path = trusted_directory / "docker"
        runtime_bytes = b"#!/bin/sh\nexit 0\n"
        runtime_path.write_bytes(runtime_bytes)
        runtime_path.chmod(0o700)
        daemon_socket_path = trusted_directory / "docker.sock"
        monkeypatch.setattr(
            isolation,
            "_validate_runtime_path_policy",
            lambda path: os.lstat(path),
        )
        monkeypatch.setattr(
            isolation,
            "_validate_daemon_socket",
            lambda path: (
                None if path == str(daemon_socket_path) else pytest.fail("unexpected daemon socket")
            ),
        )
        yield HardenedContainerRunner(
            image="registry.example/paperpilot/pdf-worker@sha256:" + "a" * 64,
            runtime_path=str(runtime_path),
            runtime_sha256=hashlib.sha256(runtime_bytes).hexdigest(),
            daemon_socket_path=str(daemon_socket_path),
        )


def test_production_requires_explicit_hardened_runner_and_never_spawns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("must fail before any subprocess"),
    )

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_runner_required")


@pytest.mark.parametrize(
    "image",
    (
        "paperpilot/pdf-worker:latest",
        "paperpilot/pdf-worker@sha256:not-a-digest",
        "paperpilot/pdf-worker@sha256:" + "A" * 64,
        "--privileged@sha256:" + "a" * 64,
    ),
)
def test_production_rejects_mutable_or_malformed_image_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
    image: str,
) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("invalid runner must not spawn"),
    )
    runner = _runner_shape(image=image)

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=runner)

    _assert_isolation_error(caught, "isolation_image_not_immutable")


@pytest.mark.parametrize(
    "runtime_path",
    (
        "docker",
        "/opt/trusted/../bin/docker",
        "/opt/trusted/bin/sh",
        "/opt/trusted/bin/docker\x00suffix",
    ),
)
def test_production_rejects_untrusted_runtime_path_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
    runtime_path: str,
) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("invalid runner must not spawn"),
    )
    runner = _runner_shape(
        image="paperpilot/pdf-worker@sha256:" + "a" * 64,
        runtime_path=runtime_path,
    )

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=runner)

    _assert_isolation_error(caught, "isolation_runner_invalid")


@pytest.mark.parametrize(
    "runner",
    (
        _runner_shape(runtime_sha256="A" * 64),
        _runner_shape(runtime_sha256="short"),
        _runner_shape(daemon_socket_path="relative/docker.sock"),
        _runner_shape(daemon_socket_path="/tmp/../tmp/docker.sock"),
    ),
)
def test_runner_requires_exact_hash_and_normalized_local_socket_path(
    monkeypatch: pytest.MonkeyPatch,
    runner: HardenedContainerRunner,
) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("invalid runner must not spawn"),
    )

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=runner)

    _assert_isolation_error(caught, "isolation_runner_invalid")


def test_runtime_hash_helper_reads_real_file_and_rejects_wrong_hash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "docker"
    runtime_bytes = b"trusted docker client"
    runtime.write_bytes(runtime_bytes)
    runtime.chmod(0o700)
    digest = hashlib.sha256(runtime_bytes).hexdigest()

    metadata = os.lstat(runtime)
    assert isolation._hash_runtime_file(str(runtime), metadata) == digest
    monkeypatch.setattr(isolation, "_validate_runtime_path_policy", lambda _path: metadata)
    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_runtime(str(runtime), "0" * 64)
    assert caught.value.issue_code == "isolation_runtime_hash_mismatch"


@pytest.mark.parametrize(
    "mode",
    (stat.S_IFREG | 0o720, stat.S_IFREG | 0o702, stat.S_IFREG | 0o600),
)
def test_runtime_root_leaf_rejects_writable_or_non_executable_mode(
    monkeypatch: pytest.MonkeyPatch,
    mode: int,
) -> None:
    metadata = os.stat_result((mode, 1, 1, 1, 0, 0, 7, 0, 0, 0))
    monkeypatch.setattr(isolation.os, "lstat", lambda _path: metadata)

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_runtime_path_policy("/trusted/docker")

    assert caught.value.issue_code == "isolation_runtime_invalid"


def test_runtime_symlink_is_rejected_before_hash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "docker"
    runtime.write_bytes(b"trusted")
    runtime.chmod(0o700)
    symlink = tmp_path / "docker-symlink"
    symlink.symlink_to(runtime)
    metadata = os.stat_result((stat.S_IFREG | 0o700, 1, 1, 1, 0, 0, 7, 0, 0, 0))
    monkeypatch.setattr(isolation.os, "lstat", lambda _path: metadata)
    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_runtime_path_policy(str(symlink))
    assert caught.value.issue_code == "isolation_runtime_invalid"


def test_runtime_validation_rejects_non_root_owner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "docker"
    runtime.write_bytes(b"trusted")
    runtime.chmod(0o700)
    real_lstat = isolation.os.lstat
    real_metadata = real_lstat(runtime)

    metadata = os.stat_result(
        (
            real_metadata.st_mode,
            1,
            1,
            1,
            os.getuid() or 501,
            real_metadata.st_gid,
            real_metadata.st_size,
            0,
            0,
            0,
        )
    )

    def fake_lstat(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        *,
        dir_fd: int | None = None,
    ) -> os.stat_result:
        if os.fspath(path) == str(runtime) and dir_fd is None:
            return metadata
        return real_lstat(path, dir_fd=dir_fd)

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_runtime_path_policy(str(runtime))

    assert caught.value.issue_code == "isolation_runtime_invalid"


@pytest.mark.parametrize(
    ("bad_parent", "mode", "owner"),
    (
        ("/trusted/bin", stat.S_IFDIR | 0o775, 0),
        ("/trusted", stat.S_IFDIR | 0o755, 501),
        ("/trusted", stat.S_IFLNK | 0o777, 0),
    ),
)
def test_root_owned_parent_chain_rejects_replacement_points(
    monkeypatch: pytest.MonkeyPatch,
    bad_parent: str,
    mode: int,
    owner: int,
) -> None:
    secure = os.stat_result((stat.S_IFDIR | 0o755, 1, 1, 1, 0, 0, 0, 0, 0, 0))
    bad = os.stat_result((mode, 1, 1, 1, owner, 0, 0, 0, 0, 0))
    observed: list[str] = []

    def fake_lstat(path: str) -> os.stat_result:
        observed.append(path)
        return bad if path == bad_parent else secure

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_root_owned_parent_chain(
            "/trusted/bin/docker", "isolation_runtime_invalid"
        )

    assert caught.value.issue_code == "isolation_runtime_invalid"
    assert bad_parent in observed


def test_root_owned_parent_chain_reaches_filesystem_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secure = os.stat_result((stat.S_IFDIR | 0o755, 1, 1, 1, 0, 0, 0, 0, 0, 0))
    observed: list[str] = []

    def fake_lstat(path: str) -> os.stat_result:
        observed.append(path)
        return secure

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)

    isolation._validate_root_owned_parent_chain("/trusted/bin/docker", "isolation_runtime_invalid")

    assert observed == ["/trusted/bin", "/trusted", "/"]


@pytest.mark.parametrize(
    ("mode", "owner", "group", "accepted"),
    (
        (stat.S_IFSOCK | 0o600, 0, os.getgid(), True),
        (stat.S_IFSOCK | 0o602, 0, os.getgid(), False),
        (stat.S_IFSOCK | 0o620, 0, 2_000_000_001, False),
        (stat.S_IFSOCK | 0o600, os.getuid() or 501, os.getgid(), False),
        (stat.S_IFSOCK | 0o600, 2_000_000_001, os.getgid(), False),
        (stat.S_IFREG | 0o600, os.getuid(), os.getgid(), False),
    ),
)
def test_daemon_socket_lstat_policy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: int,
    owner: int,
    group: int,
    accepted: bool,
) -> None:
    socket_path = str((tmp_path / "docker.sock").resolve())
    real_lstat = isolation.os.lstat
    metadata = os.stat_result((mode, 1, 1, 1, owner, group, 0, 0, 0, 0))

    def fake_lstat(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        *,
        dir_fd: int | None = None,
    ) -> os.stat_result:
        if os.fspath(path) == socket_path and dir_fd is None:
            return metadata
        return real_lstat(path, dir_fd=dir_fd)

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)
    monkeypatch.setattr(isolation, "_validate_root_owned_parent_chain", lambda *_args: None)
    if accepted:
        isolation._validate_daemon_socket(socket_path)
    else:
        with pytest.raises(PdfExtractionError) as caught:
            isolation._validate_daemon_socket(socket_path)
        assert caught.value.issue_code == "isolation_daemon_socket_invalid"


def test_daemon_socket_symlink_is_rejected(tmp_path: Path) -> None:
    target = tmp_path / "socket-target"
    target.write_bytes(b"not a socket")
    link = tmp_path / "docker.sock"
    link.symlink_to(target)

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_daemon_socket(str(link))

    assert caught.value.issue_code == "isolation_daemon_socket_invalid"


def test_daemon_socket_rejects_writable_root_owned_parent_chain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket_path = "/trusted/run/docker.sock"
    socket_metadata = os.stat_result((stat.S_IFSOCK | 0o600, 1, 1, 1, 0, 0, 0, 0, 0, 0))
    secure_directory = os.stat_result((stat.S_IFDIR | 0o755, 1, 1, 1, 0, 0, 0, 0, 0, 0))
    writable_directory = os.stat_result((stat.S_IFDIR | 0o775, 1, 1, 1, 0, 0, 0, 0, 0, 0))

    def fake_lstat(path: str) -> os.stat_result:
        if path == socket_path:
            return socket_metadata
        if path == "/trusted/run":
            return writable_directory
        return secure_directory

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_daemon_socket(socket_path)

    assert caught.value.issue_code == "isolation_daemon_socket_invalid"


def test_group_writable_socket_requires_and_accepts_supplementary_group(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    supplementary_group = 424242
    socket_path = str((tmp_path / "docker.sock").resolve())
    metadata = os.stat_result(
        (
            stat.S_IFSOCK | 0o620,
            1,
            1,
            1,
            0,
            supplementary_group,
            0,
            0,
            0,
            0,
        )
    )
    real_lstat = isolation.os.lstat

    def fake_lstat(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        *,
        dir_fd: int | None = None,
    ) -> os.stat_result:
        if os.fspath(path) == socket_path and dir_fd is None:
            return metadata
        return real_lstat(path, dir_fd=dir_fd)

    monkeypatch.setattr(isolation.os, "lstat", fake_lstat)
    monkeypatch.setattr(isolation.os, "getgroups", lambda: [supplementary_group])
    monkeypatch.setattr(isolation, "_validate_root_owned_parent_chain", lambda *_args: None)

    isolation._validate_daemon_socket(socket_path)


def test_runner_exact_type_is_rejected_without_hostile_property_access() -> None:
    class HostileRunner:
        @property
        def image(self) -> str:
            raise AssertionError("property must not be read")

    with pytest.raises(PdfExtractionError) as caught:
        isolation._validate_runner(HostileRunner())  # type: ignore[arg-type]

    assert caught.value.issue_code == "isolation_runner_invalid"


def test_validated_runner_values_are_snapshotted_before_argv(
    immutable_runner: HardenedContainerRunner,
) -> None:
    snapshot = isolation._validate_runner(immutable_runner)
    original_image = snapshot.image
    object.__setattr__(
        immutable_runner,
        "image",
        "attacker.invalid/changed@sha256:" + "f" * 64,
    )

    command = isolation._container_command(
        snapshot,
        PdfIsolationPolicy(),
        "{}",
        "{}",
        container_name="paperpilot-sd1i-snapshot",
        run_nonce="1" * 32,
    )

    assert original_image in command
    assert immutable_runner.image not in command


def test_runtime_hash_and_socket_rejections_happen_before_pdf_spawn(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("validation must precede spawn"),
    )
    wrong_hash_runner = HardenedContainerRunner(
        image=immutable_runner.image,
        runtime_path=immutable_runner.runtime_path,
        runtime_sha256="0" * 64,
        daemon_socket_path=immutable_runner.daemon_socket_path,
    )
    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=wrong_hash_runner)
    _assert_isolation_error(caught, "isolation_runtime_hash_mismatch")

    monkeypatch.setattr(
        isolation,
        "_validate_daemon_socket",
        lambda _path: (_ for _ in ()).throw(
            PdfExtractionError(
                PAPER_SLIDE_EXTRACTION_FAILED,
                "isolation_daemon_socket_invalid",
            )
        ),
    )
    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=immutable_runner)
    _assert_isolation_error(caught, "isolation_daemon_socket_invalid")


def test_hardened_container_command_is_closed_and_has_no_host_mounts(
    immutable_runner: HardenedContainerRunner,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    policy = PdfIsolationPolicy(
        cpu_seconds=7,
        max_address_space_bytes=256 * 1024 * 1024,
        max_open_files=16,
        max_container_pids=12,
    )
    command = isolation._container_command(
        runner,
        policy,
        '{"resource":"closed"}',
        '{"options":"closed"}',
        container_name="paperpilot-sd1i-testname",
        run_nonce="1" * 32,
    )

    assert command == (
        runner.runtime_path,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        "paperpilot-sd1i-testname",
        "--label",
        "io.paperpilot.sd1i=managed-v1",
        "--label",
        f"io.paperpilot.sd1i.run={'1' * 32}",
        "--interactive",
        "--network=none",
        "--ipc=none",
        "--read-only",
        "--log-driver=none",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        "--pids-limit",
        "12",
        "--memory",
        "268435456",
        "--memory-swap",
        "268435456",
        "--cpus",
        "1.0",
        "--ulimit",
        "cpu=7:7",
        "--ulimit",
        "nofile=16:16",
        "--ulimit",
        "core=0:0",
        "--ulimit",
        "fsize=0:0",
        "--user",
        "65532:65532",
        "--workdir",
        "/tmp",
        "--entrypoint",
        "/opt/paper-slide-worker/bin/python",
        runner.image,
        "-I",
        "-B",
        "-m",
        "paperpilot.paper_slides.extract_worker",
        '{"resource":"closed"}',
        '{"options":"closed"}',
    )
    assert not ({"-v", "--volume", "--mount", "--privileged"} & set(command))
    assert all("/Users/" not in argument for argument in command)


def test_container_python_matches_dedicated_worker_image_entrypoint() -> None:
    dockerfile = (
        Path(__file__).parents[2] / "containers" / "paper-slide-worker" / "Dockerfile"
    ).read_text(encoding="utf-8")
    entrypoint_line = next(
        line for line in dockerfile.splitlines() if line.startswith("ENTRYPOINT ")
    )
    entrypoint = json.loads(entrypoint_line.removeprefix("ENTRYPOINT "))

    assert entrypoint == [
        isolation.CONTAINER_PYTHON,
        "-I",
        "-m",
        "paperpilot.paper_slides.extract_worker",
    ]


def test_cleanup_removes_verified_id_not_reused_name_and_uses_nonce_filters(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    calls: list[tuple[str, ...]] = []
    deadlines: list[float] = []
    responses = iter((b"c" * 64 + b"\n", b"", b""))

    def fake_management(
        _runner: object,
        _client: str,
        arguments: tuple[str, ...],
        *,
        deadline: float,
    ) -> bytes:
        calls.append(arguments)
        deadlines.append(deadline)
        return next(responses)

    monkeypatch.setattr(isolation, "_bounded_management_command", fake_management)

    assert isolation._cleanup_container(
        runner,
        str(tmp_path),
        "paperpilot-sd1i-known",
        "1" * 32,
        deadline=1234.0,
    ) == (True, None)
    # A new container may reuse the human-readable name after the first query.
    # Cleanup is therefore bound to the observed immutable ID, while every
    # presence check also requires this run's unique nonce label.
    assert calls == [
        (
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            "name=^/paperpilot-sd1i-known$",
            "--filter",
            "label=io.paperpilot.sd1i=managed-v1",
            "--filter",
            f"label=io.paperpilot.sd1i.run={'1' * 32}",
        ),
        ("rm", "--force", "--volumes", "c" * 64),
        (
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            "name=^/paperpilot-sd1i-known$",
            "--filter",
            "label=io.paperpilot.sd1i=managed-v1",
            "--filter",
            f"label=io.paperpilot.sd1i.run={'1' * 32}",
        ),
    ]
    assert deadlines == [1234.0, 1234.0, 1234.0]


def test_cleanup_is_idempotent_and_retries_only_the_exact_name(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    attempts: list[str] = []

    def fake_once(
        _runner: object,
        _client: str,
        name: str,
        _nonce: str,
        *,
        deadline: float,
    ) -> bool:
        assert deadline == 1234.0
        attempts.append(name)
        return len(attempts) == 2

    monkeypatch.setattr(isolation, "_cleanup_container_once", fake_once)

    assert isolation._cleanup_container(
        runner,
        str(tmp_path),
        "paperpilot-sd1i-exact",
        "2" * 32,
        deadline=1234.0,
    ) == (True, None)
    assert attempts == ["paperpilot-sd1i-exact", "paperpilot-sd1i-exact"]


def test_cleanup_retries_after_interrupt_and_returns_control_for_later_propagation(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    attempts = 0

    def fake_once(
        _runner: object,
        _client: str,
        _name: str,
        _nonce: str,
        *,
        deadline: float,
    ) -> bool:
        assert deadline == 1234.0
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise KeyboardInterrupt
        return True

    monkeypatch.setattr(isolation, "_cleanup_container_once", fake_once)

    succeeded, process_control = isolation._cleanup_container(
        runner,
        str(tmp_path),
        "paperpilot-sd1i-interrupt",
        "3" * 32,
        deadline=1234.0,
    )
    assert succeeded
    assert isinstance(process_control, KeyboardInterrupt)
    assert attempts == 2


def test_absent_container_cleanup_is_a_single_bounded_query(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    calls: list[tuple[str, ...]] = []

    def fake_management(
        _runner: object,
        _client: str,
        arguments: tuple[str, ...],
        *,
        deadline: float,
    ) -> bytes:
        assert deadline == 1234.0
        calls.append(arguments)
        return b""

    monkeypatch.setattr(isolation, "_bounded_management_command", fake_management)

    assert isolation._cleanup_container(
        runner,
        str(tmp_path),
        "paperpilot-sd1i-absent",
        "4" * 32,
        deadline=1234.0,
    ) == (True, None)
    assert len(calls) == 1
    assert calls[0][:2] == ("container", "ls")


def test_unknown_presence_never_removes_a_possibly_unrelated_container(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    calls: list[tuple[str, ...]] = []

    def unavailable_query(
        _runner: object,
        _client: str,
        arguments: tuple[str, ...],
        *,
        deadline: float,
    ) -> None:
        assert deadline == 1234.0
        calls.append(arguments)
        return None

    monkeypatch.setattr(isolation, "_bounded_management_command", unavailable_query)

    assert isolation._cleanup_container(
        runner,
        str(tmp_path),
        "paperpilot-sd1i-unknown",
        "5" * 32,
        deadline=1234.0,
    ) == (False, None)
    assert len(calls) == 2
    assert all(call[:2] == ("container", "ls") for call in calls)
    assert not any(call and call[0] == "rm" for call in calls)


def test_all_docker_cli_calls_use_fresh_explicit_local_context(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
) -> None:
    parent_secret = "PARENT_CONTEXT_MUST_NOT_CROSS"
    monkeypatch.setenv("DOCKER_CONTEXT", parent_secret)
    monkeypatch.setenv("DOCKER_CONFIG", parent_secret)
    observed: dict[str, object] = {}
    fake_process = object()

    def fake_popen(*args: object, **kwargs: object) -> object:
        client_directory = kwargs["cwd"]
        assert isinstance(client_directory, str)
        assert Path(client_directory).exists()
        assert Path(client_directory).stat().st_mode & 0o777 == 0o700
        assert list(Path(client_directory).iterdir()) == []
        observed["command"] = args[0]
        observed["client_directory"] = client_directory
        observed["env"] = kwargs["env"]
        return fake_process

    monkeypatch.setattr(isolation.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        isolation,
        "_bounded_exchange",
        lambda process, _payload, **_kwargs: (
            _error_response(PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid").encode()
            if process is fake_process
            else pytest.fail("wrong process")
        ),
    )
    monkeypatch.setattr(isolation, "_cleanup_container", lambda *_args, **_kwargs: (True, None))

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=immutable_runner)

    assert caught.value.issue_code == "pdf_magic_invalid"
    client_directory = observed["client_directory"]
    assert isinstance(client_directory, str)
    assert observed["env"] == {
        "DOCKER_CONFIG": client_directory,
        "DOCKER_HOST": f"unix://{immutable_runner.daemon_socket_path}",
        "HOME": client_directory,
    }
    assert parent_secret not in repr(observed)
    assert not Path(client_directory).exists()


def test_management_cli_uses_same_explicit_empty_context(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    client_directory = tmp_path / "client"
    client_directory.mkdir(mode=0o700)
    observed: dict[str, object] = {}
    fake_process = object()

    def fake_popen(*args: object, **kwargs: object) -> object:
        observed["command"] = args[0]
        observed["kwargs"] = kwargs
        return fake_process

    monkeypatch.setattr(isolation.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        isolation,
        "_bounded_exchange",
        lambda process, payload, **_kwargs: (
            b"" if process is fake_process and payload == b"" else pytest.fail("wrong call")
        ),
    )

    assert (
        isolation._bounded_management_command(
            runner,
            str(client_directory),
            ("container", "ls", "--quiet"),
            deadline=time.monotonic() + 1,
        )
        == b""
    )
    kwargs = observed["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["env"] == {
        "DOCKER_CONFIG": str(client_directory),
        "DOCKER_HOST": f"unix://{immutable_runner.daemon_socket_path}",
        "HOME": str(client_directory),
    }
    assert kwargs["cwd"] == str(client_directory)


def test_expired_shared_cleanup_deadline_never_starts_another_cli(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    tmp_path: Path,
) -> None:
    runner = isolation._validate_runner(immutable_runner)
    monkeypatch.setattr(isolation.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("expired cleanup must not spawn"),
    )

    assert (
        isolation._bounded_management_command(
            runner,
            str(tmp_path),
            ("container", "ls"),
            deadline=100.0,
        )
        is None
    )


def test_runtime_start_failure_never_falls_back_to_test_subprocess(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
) -> None:
    monkeypatch.setattr(
        isolation,
        "_extract_pdf_via_test_subprocess_for_tests",
        lambda *_args, **_kwargs: pytest.fail("production fallback is forbidden"),
    )
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError()),
    )
    monkeypatch.setattr(isolation, "_cleanup_container", lambda *_args, **_kwargs: (True, None))

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=immutable_runner)

    _assert_isolation_error(caught, "isolation_process_failed")


@pytest.mark.parametrize("during_spawn", (True, False))
@pytest.mark.parametrize("control_exception", (KeyboardInterrupt, SystemExit, GeneratorExit))
def test_production_process_control_always_attempts_cleanup_before_propagation(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
    during_spawn: bool,
    control_exception: type[BaseException],
) -> None:
    fake_process = object()
    cleanup_names: list[str] = []
    event_order: list[str] = []

    def fake_popen(*_args: object, **_kwargs: object) -> object:
        if during_spawn:
            raise control_exception
        return fake_process

    def fake_exchange(process: object, _payload: bytes, **_kwargs: object) -> bytes:
        assert process is fake_process
        raise control_exception

    def fake_terminate(process: object) -> None:
        assert process is fake_process
        event_order.append("terminate")

    def fake_cleanup(
        _runner: object,
        _client: str,
        name: str,
        _nonce: str,
        *,
        deadline: float,
    ) -> tuple[bool, None]:
        assert deadline > 0
        event_order.append("cleanup")
        cleanup_names.append(name)
        return True, None

    monkeypatch.setattr(isolation.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(isolation, "_bounded_exchange", fake_exchange)
    monkeypatch.setattr(isolation, "_terminate", fake_terminate)
    monkeypatch.setattr(isolation, "_cleanup_container", fake_cleanup)

    with pytest.raises(control_exception):
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=immutable_runner)

    assert len(cleanup_names) == 1
    assert cleanup_names[0].startswith("paperpilot-sd1i-")
    assert event_order == (["cleanup"] if during_spawn else ["terminate", "cleanup"])


def test_unverified_container_cleanup_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    immutable_runner: HardenedContainerRunner,
) -> None:
    observed: dict[str, object] = {}
    fake_process = object()

    def fake_popen(*args: object, **kwargs: object) -> object:
        observed["command"] = args[0]
        observed["kwargs"] = kwargs
        return fake_process

    monkeypatch.setattr(isolation.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        isolation,
        "_bounded_exchange",
        lambda process, _payload, **_kwargs: (
            b"must-not-be-decoded" if process is fake_process else pytest.fail("wrong process")
        ),
    )
    monkeypatch.setattr(isolation, "_cleanup_container", lambda *_args, **_kwargs: (False, None))

    with pytest.raises(PdfExtractionError) as caught:
        production_extract_pdf_isolated(b"%PDF-in-memory", runner=immutable_runner)

    _assert_isolation_error(caught, "isolation_cleanup_failed")
    command = observed["command"]
    assert isinstance(command, tuple)
    assert command[0] == immutable_runner.runtime_path
    kwargs = observed["kwargs"]
    assert isinstance(kwargs, dict)
    client_directory = kwargs["cwd"]
    assert isinstance(client_directory, str)
    assert kwargs["env"] == {
        "DOCKER_CONFIG": client_directory,
        "DOCKER_HOST": f"unix://{immutable_runner.daemon_socket_path}",
        "HOME": client_directory,
    }
    assert kwargs["stderr"] is subprocess.DEVNULL
    assert kwargs["start_new_session"] is True


@pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="RLIMIT_AS is enforceable on Linux"
)
def test_isolated_visibility_gate_has_exact_parity_with_core() -> None:
    pdf_bytes = _in_memory_pdf()

    for extractor in (extract_pdf, extract_pdf_isolated):
        with pytest.raises(PdfExtractionError) as caught:
            extractor(pdf_bytes)
        assert caught.value.error_code == PAPER_SLIDE_EXTRACTION_FAILED
        assert caught.value.issue_code == "page_text_visibility_unverifiable"
        assert caught.value.__cause__ is None
        assert caught.value.__context__ is None


def test_unsupported_platform_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(isolation.sys, "platform", "darwin")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_platform_unsupported")


def test_wall_timeout_kills_worker_with_stable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _allow_fake_worker(monkeypatch, "import time; time.sleep(10)")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(
            b"%PDF-in-memory",
            policy=PdfIsolationPolicy(wall_timeout_seconds=0.05),
        )

    _assert_isolation_error(caught, "isolation_timeout")


def test_stdout_is_capped_before_it_can_be_buffered(monkeypatch: pytest.MonkeyPatch) -> None:
    _allow_fake_worker(
        monkeypatch,
        "import sys; sys.stdout.buffer.write(b'x' * 4096); sys.stdout.buffer.flush()",
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(
            b"%PDF-in-memory",
            policy=PdfIsolationPolicy(max_output_bytes=256),
        )

    _assert_isolation_error(caught, "isolation_output_limit_exceeded")


def test_oversized_pdf_is_rejected_before_worker_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        isolation.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("oversized PDF must not reach subprocess"),
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(
            b"%PDF-1234",
            options=PdfExtractionOptions(max_pdf_bytes=8),
        )

    _assert_isolation_error(caught, "pdf_byte_limit_exceeded")


def test_malformed_stdout_and_stderr_are_never_exposed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "SUPER_SECRET_STDOUT_AND_STDERR"
    _allow_fake_worker(
        monkeypatch,
        f"import sys; print({secret!r}); print({secret!r}, file=sys.stderr)",
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_protocol_invalid")
    assert secret not in str(caught.value)
    assert secret not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_child_environment_is_empty_and_no_shell_is_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "SECRET_PARENT_VALUE_MUST_NOT_CROSS_BOUNDARY"
    for name in ("QWEN_API_KEY", "ACCESS_TOKEN", "HTTPS_PROXY", "NETRC"):
        monkeypatch.setenv(name, secret)
    response = _error_response(PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid")
    _allow_fake_worker(
        monkeypatch,
        "import os; "
        "assert not any(name in os.environ for name in "
        "('QWEN_API_KEY','ACCESS_TOKEN','HTTPS_PROXY','NETRC')); "
        f"print({response!r}, end='')",
    )
    real_popen = isolation.subprocess.Popen
    observed: dict[str, object] = {}

    def recording_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        observed["args"] = args[0]
        observed["env"] = kwargs.get("env")
        observed["shell"] = kwargs.get("shell", False)
        observed["start_new_session"] = kwargs.get("start_new_session")
        return real_popen(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(isolation.subprocess, "Popen", recording_popen)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    assert caught.value.error_code == PAPER_SLIDE_PDF_INVALID
    assert caught.value.issue_code == "pdf_magic_invalid"
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert observed["env"] == {}
    assert observed["shell"] is False
    assert observed["start_new_session"] is True
    assert isinstance(observed["args"], tuple)
    assert secret not in str(caught.value)


def test_private_working_directory_is_removed_after_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _allow_fake_worker(monkeypatch, "print('malformed')")
    real_temporary_directory = isolation.tempfile.TemporaryDirectory
    created: list[Path] = []

    def recording_temporary_directory(
        *args: object, **kwargs: object
    ) -> tempfile.TemporaryDirectory[str]:
        directory = real_temporary_directory(*args, **kwargs)  # type: ignore[arg-type]
        created.append(Path(directory.name))
        return directory

    monkeypatch.setattr(isolation.tempfile, "TemporaryDirectory", recording_temporary_directory)

    with pytest.raises(PdfExtractionError):
        extract_pdf_isolated(b"%PDF-raw-never-written")

    assert len(created) == 1
    assert not created[0].exists()


def test_private_working_directory_is_removed_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_bytes = b"%PDF-in-memory"
    response = _success_response(pdf_bytes)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")
    real_temporary_directory = isolation.tempfile.TemporaryDirectory
    created: list[Path] = []

    def recording_temporary_directory(
        *args: object, **kwargs: object
    ) -> tempfile.TemporaryDirectory[str]:
        directory = real_temporary_directory(*args, **kwargs)  # type: ignore[arg-type]
        created.append(Path(directory.name))
        return directory

    monkeypatch.setattr(isolation.tempfile, "TemporaryDirectory", recording_temporary_directory)

    result = extract_pdf_isolated(pdf_bytes)

    assert result.page_count == 1
    assert len(created) == 1
    assert not created[0].exists()


def test_worker_audit_hook_survives_socket_reimport_and_denies_runtime_bypasses() -> None:
    source = """
import _socket
import ctypes
import importlib
import socket
import subprocess
import sys
from paperpilot.paper_slides.extract_worker import (
    _disable_python_network,
    _install_python_runtime_guards,
)
assert "pypdf" not in sys.modules
existing_socket = socket.socket()
_install_python_runtime_guards()
_disable_python_network()
del sys.modules["socket"]
del sys.modules["_socket"]
reloaded_low_level = importlib.import_module("_socket")
reloaded_socket = importlib.import_module("socket")
attempts = (
    lambda: reloaded_socket.socket(),
    lambda: reloaded_low_level.socket(),
    lambda: reloaded_low_level.getaddrinfo("example.invalid", 443),
    lambda: existing_socket.connect(("127.0.0.1", 9)),
    lambda: ctypes.CDLL(None),
    lambda: subprocess.Popen((sys.executable, "-c", "raise SystemExit(0)")),
    lambda: sys.audit("os.system", b"true"),
)
for operation in attempts:
    try:
        operation()
    except PermissionError:
        continue
    raise AssertionError("Python runtime escape remained enabled")
existing_socket.close()
"""
    with tempfile.TemporaryDirectory(prefix="paperpilot-sd1i-network-test-") as directory:
        completed = subprocess.run(
            (sys.executable, "-I", "-B", "-c", source),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            cwd=directory,
            env={},
            check=False,
            timeout=10,
        )

    assert completed.returncode == 0
    assert completed.stdout == b""
    assert completed.stderr == b""


def test_timeout_kills_entire_new_process_group(monkeypatch: pytest.MonkeyPatch) -> None:
    source = """
import subprocess
import sys
import time
subprocess.Popen((sys.executable, "-c", "import time; time.sleep(30)"))
time.sleep(30)
"""
    _allow_fake_worker(monkeypatch, source)
    real_popen = isolation.subprocess.Popen
    direct_processes: list[subprocess.Popen[bytes]] = []
    real_killpg = isolation.os.killpg
    killed_groups: list[tuple[int, int]] = []

    def recording_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        process = real_popen(*args, **kwargs)  # type: ignore[arg-type]
        direct_processes.append(process)
        return process

    def recording_killpg(process_group: int, signal_number: int) -> None:
        killed_groups.append((process_group, signal_number))
        real_killpg(process_group, signal_number)

    monkeypatch.setattr(isolation.subprocess, "Popen", recording_popen)
    monkeypatch.setattr(isolation.os, "killpg", recording_killpg)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(
            b"%PDF-in-memory",
            policy=PdfIsolationPolicy(wall_timeout_seconds=0.1),
        )

    _assert_isolation_error(caught, "isolation_timeout")
    assert len(direct_processes) == 1
    process_group = direct_processes[0].pid
    assert (process_group, isolation.signal.SIGKILL) in killed_groups
    assert direct_processes[0].poll() is not None
    group_exists = True
    for _attempt in range(100):
        try:
            real_killpg(process_group, 0)
        except ProcessLookupError:
            group_exists = False
            break
        time.sleep(0.01)
    if group_exists:
        real_killpg(process_group, isolation.signal.SIGKILL)
    assert not group_exists


@pytest.mark.parametrize(
    ("error_code", "issue_code"),
    (
        (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_resource_limit_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "isolation_worker_failed"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_ambiguous"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "page_text_visibility_unverifiable"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "unexpected_extraction_failure"),
        (PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid"),
    ),
)
def test_only_exact_allowlisted_child_errors_are_accepted(
    monkeypatch: pytest.MonkeyPatch,
    error_code: str,
    issue_code: str,
) -> None:
    response = _error_response(error_code, issue_code)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    assert caught.value.error_code == error_code
    assert caught.value.issue_code == issue_code
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


@pytest.mark.parametrize(
    ("error_code", "issue_code"),
    (
        (PAPER_SLIDE_EXTRACTION_FAILED, "child_chosen_secret_marker"),
        (PAPER_SLIDE_EXTRACTION_FAILED, "pdf_magic_invalid"),
        (PAPER_SLIDE_PDF_INVALID, "chunk_limit_exceeded"),
    ),
)
def test_unknown_or_mismatched_child_error_pair_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    error_code: str,
    issue_code: str,
) -> None:
    response = _error_response(error_code, issue_code)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_protocol_invalid")
    assert "child_chosen_secret_marker" not in str(caught.value)


@pytest.mark.parametrize(
    "payload",
    (
        "[" + ",".join("{}" for _index in range(129)) + "]",
        "[" + ",".join("0" for _index in range(2100)) + "]",
    ),
)
def test_json_container_and_structural_token_bombs_fail_before_json_loads(
    monkeypatch: pytest.MonkeyPatch,
    payload: str,
) -> None:
    _allow_fake_worker(monkeypatch, f"import sys; sys.stdout.write({payload!r})")
    monkeypatch.setattr(
        isolation.json,
        "loads",
        lambda *_args, **_kwargs: pytest.fail("preflight must reject before json.loads"),
    )

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_protocol_invalid")


@pytest.mark.parametrize(
    "payload",
    (
        b'{"value":' + b"9" * 100_000 + b"}",
        b'{"value":1.' + b"0" * 100_000 + b"}",
        b'{"value":"' + b"x" * (128 * 1024 + 1) + b'"}',
        b" ".join(b"0" for _index in range(4097)),
    ),
    ids=("huge-integer", "huge-float", "huge-string", "scalar-count"),
)
def test_json_scalar_bombs_fail_in_preflight_before_json_loads(
    monkeypatch: pytest.MonkeyPatch,
    payload: bytes,
) -> None:
    monkeypatch.setattr(
        isolation.json,
        "loads",
        lambda *_args, **_kwargs: pytest.fail("scalar preflight must reject first"),
    )

    with pytest.raises(PdfExtractionError) as caught:
        isolation._parse_json(payload)

    assert caught.value.error_code == PAPER_SLIDE_EXTRACTION_FAILED
    assert caught.value.issue_code == "isolation_protocol_invalid"


@pytest.mark.parametrize(
    ("parser", "payload"),
    (
        (isolation._bounded_parse_int, "9" * 129),
        (isolation._bounded_parse_float, "1." + "0" * 129),
        (isolation._bounded_parse_float, "1e999"),
    ),
)
def test_json_numeric_hooks_are_independently_bounded(
    parser: Callable[[str], object],
    payload: str,
) -> None:
    with pytest.raises(ValueError):
        parser(payload)


@pytest.mark.parametrize(
    ("page_texts", "options"),
    (
        (((1, _unique_text("short")[:499].rstrip()),), PdfExtractionOptions()),
        (
            (
                (1, _unique_text("alpha")[:300].rstrip()),
                (1, _unique_text("bravo")[:300].rstrip()),
            ),
            PdfExtractionOptions(max_page_codepoints=500, max_chunk_codepoints=300),
        ),
        (
            ((1, _unique_text("duplicate")), (2, _unique_text("duplicate"))),
            PdfExtractionOptions(),
        ),
        (((1, "repeat " * 100),), PdfExtractionOptions()),
    ),
)
def test_parent_rejects_invalid_sanitized_result_invariants(
    monkeypatch: pytest.MonkeyPatch,
    page_texts: tuple[tuple[int, str], ...],
    options: PdfExtractionOptions,
) -> None:
    pdf_bytes = b"%PDF-in-memory"
    response = _success_response(pdf_bytes, page_texts=page_texts, options=options)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(pdf_bytes, options=options)

    _assert_isolation_error(caught, "isolation_protocol_invalid")


def test_parent_accepts_core_style_cross_page_line_deduplication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_bytes = b"%PDF-in-memory"
    header = "Conference header retained on its first physical page"
    page_texts = (
        (1, f"{header}\n{_unique_text('first', 40)}"),
        (2, _unique_text("second", 40)),
    )
    response = _success_response(pdf_bytes, page_texts=page_texts)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    result = extract_pdf_isolated(pdf_bytes)

    assert result.extracted_page_count == 2


def test_parent_rejects_forged_repeated_cross_page_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_bytes = b"%PDF-in-memory"
    header = "Conference header must not survive on another physical page"
    page_texts = (
        (1, f"{header}\n{_unique_text('first', 40)}"),
        (2, f"{header}\n{_unique_text('second', 40)}"),
    )
    response = _success_response(pdf_bytes, page_texts=page_texts)
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(pdf_bytes)

    _assert_isolation_error(caught, "isolation_protocol_invalid")


def test_options_require_exact_integer_types_and_reuse_expected_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_bytes = b"%PDF-in-memory"
    options = PdfExtractionOptions(max_pages=1)
    response = json.loads(_success_response(pdf_bytes, options=options))
    response["result"]["options"]["max_pages"] = True
    encoded = json.dumps(response, sort_keys=True, separators=(",", ":"))
    _allow_fake_worker(monkeypatch, f"print({encoded!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(pdf_bytes, options=options)

    _assert_isolation_error(caught, "isolation_protocol_invalid")
    assert isolation._decode_options(asdict(options), options) is options


def test_selector_setup_exception_terminates_spawned_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "SECRET_SELECTOR_SETUP_EXCEPTION"
    _allow_fake_worker(monkeypatch, "import time; time.sleep(30)")
    real_popen = isolation.subprocess.Popen
    started: list[subprocess.Popen[bytes]] = []
    real_killpg = isolation.os.killpg
    killed_groups: list[int] = []

    def recording_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        process = real_popen(*args, **kwargs)  # type: ignore[arg-type]
        started.append(process)
        return process

    def recording_killpg(process_group: int, signal_number: int) -> None:
        killed_groups.append(process_group)
        real_killpg(process_group, signal_number)

    def broken_selector() -> selectors.BaseSelector:
        raise RuntimeError(secret)

    monkeypatch.setattr(isolation.subprocess, "Popen", recording_popen)
    monkeypatch.setattr(isolation.os, "killpg", recording_killpg)
    monkeypatch.setattr(isolation.selectors, "DefaultSelector", broken_selector)

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-in-memory")

    _assert_isolation_error(caught, "isolation_process_failed")
    assert len(started) == 1
    assert killed_groups == [started[0].pid]
    assert started[0].poll() is not None
    assert secret not in repr(caught.value)


@pytest.mark.parametrize("control_exception", (KeyboardInterrupt, SystemExit))
def test_process_control_exception_terminates_worker_before_propagation(
    monkeypatch: pytest.MonkeyPatch,
    control_exception: type[BaseException],
) -> None:
    _allow_fake_worker(monkeypatch, "import time; time.sleep(30)")
    real_popen = isolation.subprocess.Popen
    started: list[subprocess.Popen[bytes]] = []
    real_killpg = isolation.os.killpg
    killed_groups: list[int] = []

    def recording_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        process = real_popen(*args, **kwargs)  # type: ignore[arg-type]
        started.append(process)
        return process

    def recording_killpg(process_group: int, signal_number: int) -> None:
        killed_groups.append(process_group)
        real_killpg(process_group, signal_number)

    def interrupted_selector() -> selectors.BaseSelector:
        raise control_exception

    monkeypatch.setattr(isolation.subprocess, "Popen", recording_popen)
    monkeypatch.setattr(isolation.os, "killpg", recording_killpg)
    monkeypatch.setattr(isolation.selectors, "DefaultSelector", interrupted_selector)

    with pytest.raises(control_exception):
        extract_pdf_isolated(b"%PDF-in-memory")

    assert len(started) == 1
    assert killed_groups == [started[0].pid]
    assert started[0].poll() is not None


def test_empty_input_does_not_deadlock_pipe_exchange(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _error_response(PAPER_SLIDE_PDF_INVALID, "pdf_magic_invalid")
    _allow_fake_worker(monkeypatch, f"print({response!r}, end='')")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"")

    assert caught.value.error_code == PAPER_SLIDE_PDF_INVALID
    assert caught.value.issue_code == "pdf_magic_invalid"


def test_raw_pdf_bytes_never_appear_in_public_process_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_marker = b"RAW_PDF_SECRET_MARKER"
    _allow_fake_worker(monkeypatch, "raise SystemExit(7)")

    with pytest.raises(PdfExtractionError) as caught:
        extract_pdf_isolated(b"%PDF-" + raw_marker)

    _assert_isolation_error(caught, "isolation_process_failed")
    assert raw_marker.decode("ascii") not in str(caught.value)
    assert raw_marker.decode("ascii") not in repr(caught.value)
    assert raw_marker not in b"".join(
        path.read_bytes() for path in Path(os.getcwd()).glob("paperpilot-sd1i-*") if path.is_file()
    )
