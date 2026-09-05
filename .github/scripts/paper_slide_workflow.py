#!/usr/bin/env python3
"""Fail-closed boundary helpers for the dormant Paper Slide workflow.

This module intentionally contains no provider adapter and no generation entry
point.  The checked-in callback origin, provider config digest, and approved
registry identities remain empty until separately reviewed activation changes.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import stat
import sys
from base64 import urlsafe_b64decode, urlsafe_b64encode
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

CALLBACK_SCHEMA = "paper-slide-workflow-api-v1"
CLAIMANT_DERIVATION_SCHEMA = "paper-slide-claimant-derivation-v1"
CLAIMANT_HMAC_DOMAIN = b"paperpilot:paper-slide:claimant-token:v1\0"
PROVIDER_GATE_SCHEMA = "paper-slide-provider-execution-v1"
PROVIDER_GATE_PATH = Path("paperpilot/data/paper-slide-provider-v1.json")

# A mutable repository variable is routing convenience only. The workflow will
# not send its bearer secret unless that value exactly equals this code pin.
APPROVED_CALLBACK_ORIGIN: str | None = None

# Activation requires reviewed edits which pin both the exact provider config
# bytes and an identity present in a code-owned ProviderRegistry. The latter is
# a preliminary workflow check only: a future provider runner must still call
# provider_execution.prepare_provider_execution with the real non-empty
# ProviderRegistry immediately before use. A config file alone is insufficient.
APPROVED_PROVIDER_GATE_SHA256: str | None = None
APPROVED_PROVIDER_REGISTRY_IDENTITIES: frozenset[tuple[str, str, str, str]] = frozenset()

MAX_CALLBACK_RESPONSE_BYTES = 4096
MAX_PROVIDER_GATE_BYTES = 8192
CALLBACK_TIMEOUT_SECONDS = 10
MAX_CLAIM_ATTEMPTS = 3

PAPER_ID_RE = re.compile(r"[0-9a-f]{40}\Z")
JOB_ID_RE = re.compile(r"paper-slide-job-[A-Za-z0-9_-]{22}\Z")
JOB_KEY_RE = re.compile(r"[0-9a-f]{64}\Z")
SNAPSHOT_VERSION_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
TOKEN_RE = re.compile(r"[!-~]{32,256}\Z")
CLAIMANT_KEY_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
CLAIMANT_TOKEN_RE = re.compile(r"psct_[A-Za-z0-9_-]{43}\Z")
LEASE_EXPIRES_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
REPOSITORY_RE = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
WORKFLOW_REF_RE = re.compile(r"[A-Za-z0-9_.@:/-]{1,512}\Z")
RUN_ID_RE = re.compile(r"[1-9][0-9]{0,19}\Z")
GIT_SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
HOST_RE = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z"
)

INPUT_ENV = {
    "paper_id": "PAPER_SLIDE_PAPER_ID",
    "job_id": "PAPER_SLIDE_JOB_ID",
    "language": "PAPER_SLIDE_LANGUAGE",
    "coverage_preference": "PAPER_SLIDE_COVERAGE_PREFERENCE",
    "snapshot_version": "PAPER_SLIDE_SNAPSHOT_VERSION",
    "job_key": "PAPER_SLIDE_JOB_KEY",
}

PROVIDER_GATE_KEYS = {
    "adapter_version",
    "budget",
    "model",
    "pricing_snapshot_sha256",
    "provider",
    "schema_version",
}
PROVIDER_BUDGET_KEYS = {
    "max_calls",
    "max_cost_micro_units",
    "max_input_tokens",
    "max_output_tokens",
    "max_output_tokens_per_call",
    "max_wall_seconds",
}
PROVIDER_BUDGET_MAXIMA = {
    "max_calls": 16,
    "max_cost_micro_units": (1 << 63) - 1,
    "max_input_tokens": 200_000,
    "max_output_tokens": 32_000,
    "max_output_tokens_per_call": 8_000,
    "max_wall_seconds": 300,
}
PROVIDER_IDENTITY_KEYS = (
    "provider",
    "model",
    "adapter_version",
    "pricing_snapshot_sha256",
)


class BoundaryError(RuntimeError):
    """A closed, user-data-free workflow boundary failure."""


class AmbiguousCallbackError(BoundaryError):
    """The caller cannot know whether the callback operation committed."""


class DefinitiveCallbackError(BoundaryError):
    """The callback definitively rejected the operation."""


class ClaimDecision:
    __slots__ = ("claimed", "lease_expires_at", "lease_generation", "reclaimed")

    def __init__(
        self,
        claimed: bool,
        reclaimed: bool,
        lease_generation: int | None,
        lease_expires_at: str | None,
    ) -> None:
        self.claimed = claimed
        self.reclaimed = reclaimed
        self.lease_generation = lease_generation
        self.lease_expires_at = lease_expires_at


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _decode_unique_json(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)


def validate_dispatch_inputs(environ: Mapping[str, str]) -> dict[str, str]:
    """Project and validate the six inputs accepted by the dispatch adapter."""

    values = {name: environ.get(env_name, "") for name, env_name in INPUT_ENV.items()}
    if not PAPER_ID_RE.fullmatch(values["paper_id"]):
        raise BoundaryError("invalid dispatch input")
    if not JOB_ID_RE.fullmatch(values["job_id"]):
        raise BoundaryError("invalid dispatch input")
    if values["language"] not in {"ja", "en"}:
        raise BoundaryError("invalid dispatch input")
    if values["coverage_preference"] != "auto":
        raise BoundaryError("invalid dispatch input")
    if not SNAPSHOT_VERSION_RE.fullmatch(values["snapshot_version"]):
        raise BoundaryError("invalid dispatch input")
    if not JOB_KEY_RE.fullmatch(values["job_key"]):
        raise BoundaryError("invalid dispatch input")
    return values


def derive_claimant_token(environ: Mapping[str, str]) -> str:
    """Derive one stable, non-output claimant capability for a GitHub run/job."""

    dispatch = validate_dispatch_inputs(environ)
    claimant_key = environ.get("PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY", "")
    repository = environ.get("GITHUB_REPOSITORY", "")
    repository_id = environ.get("GITHUB_REPOSITORY_ID", "")
    workflow_ref = environ.get("GITHUB_WORKFLOW_REF", "")
    run_id = environ.get("GITHUB_RUN_ID", "")
    workflow_sha = environ.get("GITHUB_SHA", "")
    if (
        CLAIMANT_KEY_RE.fullmatch(claimant_key) is None
        or REPOSITORY_RE.fullmatch(repository) is None
        or RUN_ID_RE.fullmatch(repository_id) is None
        or WORKFLOW_REF_RE.fullmatch(workflow_ref) is None
        or RUN_ID_RE.fullmatch(run_id) is None
        or GIT_SHA_RE.fullmatch(workflow_sha) is None
    ):
        raise BoundaryError("claimant configuration unavailable")
    try:
        key_bytes = urlsafe_b64decode(claimant_key + "=")
    except (ValueError, TypeError) as exc:
        raise BoundaryError("claimant configuration unavailable") from exc
    if (
        len(key_bytes) != 32
        or urlsafe_b64encode(key_bytes).rstrip(b"=").decode("ascii") != claimant_key
    ):
        raise BoundaryError("claimant configuration unavailable")
    message = json.dumps(
        {
            "job": dispatch,
            "run": {
                "repository": repository,
                "repository_id": repository_id,
                "run_id": run_id,
                "workflow_ref": workflow_ref,
                "workflow_sha": workflow_sha,
            },
            "schema_version": CLAIMANT_DERIVATION_SCHEMA,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hmac.digest(key_bytes, CLAIMANT_HMAC_DOMAIN + message, "sha256")
    token = "psct_" + urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    if CLAIMANT_TOKEN_RE.fullmatch(token) is None:
        raise BoundaryError("claimant configuration unavailable")
    return token


def _is_positive_bounded_int(value: Any, maximum: int) -> bool:
    return type(value) is int and 1 <= value <= maximum


def _valid_provider_gate(value: Any) -> bool:
    if type(value) is not dict or set(value) != PROVIDER_GATE_KEYS:
        return False
    budget = value["budget"]
    if type(budget) is not dict or set(budget) != PROVIDER_BUDGET_KEYS:
        return False
    valid_budget = all(
        _is_positive_bounded_int(budget[key], maximum)
        for key, maximum in PROVIDER_BUDGET_MAXIMA.items()
        if key != "max_cost_micro_units"
    ) and (
        type(budget["max_cost_micro_units"]) is int
        and 0 <= budget["max_cost_micro_units"] <= PROVIDER_BUDGET_MAXIMA["max_cost_micro_units"]
    )
    return valid_budget and (
        value["schema_version"] == PROVIDER_GATE_SCHEMA
        and type(value["provider"]) is str
        and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", value["provider"]) is not None
        and type(value["model"]) is str
        and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", value["model"]) is not None
        and type(value["adapter_version"]) is str
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value["adapter_version"]) is not None
        and type(value["pricing_snapshot_sha256"]) is str
        and re.fullmatch(r"[0-9a-f]{64}", value["pricing_snapshot_sha256"]) is not None
    )


def _has_symlink_component(path: Path) -> bool:
    """Reject every existing symlink component without resolving the path."""

    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    try:
        for part in absolute.parts[1:]:
            current /= part
            try:
                if stat.S_ISLNK(current.lstat().st_mode):
                    return True
            except FileNotFoundError:
                return False
        return False
    except OSError:
        return True


def _same_file(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev == second.st_dev
        and first.st_ino == second.st_ino
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
    )


def _read_exact_regular_file(path: Path, maximum_bytes: int) -> bytes | None:
    descriptor: int | None = None
    try:
        if _has_symlink_component(path):
            return None
        path_before = path.lstat()
        if not stat.S_ISREG(path_before.st_mode):
            return None
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        fd_before = os.fstat(descriptor)
        if not stat.S_ISREG(fd_before.st_mode) or not _same_file(path_before, fd_before):
            return None
        if fd_before.st_size > maximum_bytes:
            return None
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = None
            raw = handle.read(maximum_bytes + 1)
            fd_after = os.fstat(handle.fileno())
        path_after = path.lstat()
        if (
            len(raw) > maximum_bytes
            or len(raw) != fd_before.st_size
            or not _same_file(fd_before, fd_after)
            or not _same_file(fd_after, path_after)
        ):
            return None
        return raw
    except OSError:
        return None
    finally:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)


def provider_gate_authorized(repo_root: Path) -> bool:
    """Require exact config bytes plus a separately approved registry identity."""

    expected_digest = APPROVED_PROVIDER_GATE_SHA256
    if expected_digest is None or re.fullmatch(r"[0-9a-f]{64}", expected_digest) is None:
        return False

    gate_path = repo_root / PROVIDER_GATE_PATH
    raw = _read_exact_regular_file(gate_path, MAX_PROVIDER_GATE_BYTES)
    if raw is None:
        return False
    if hashlib.sha256(raw).hexdigest() != expected_digest:
        return False
    try:
        value = _decode_unique_json(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return False
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    if raw != canonical:
        return False
    if not _valid_provider_gate(value):
        return False
    registrations = APPROVED_PROVIDER_REGISTRY_IDENTITIES
    if type(registrations) is not frozenset:
        return False
    identity = tuple(value[key] for key in PROVIDER_IDENTITY_KEYS)
    return identity in registrations


def _write_github_output(environ: Mapping[str, str], key: str, value: str) -> None:
    output_path = environ.get("GITHUB_OUTPUT", "")
    if not output_path or re.fullmatch(r"[a-z_][a-z0-9_]*", key) is None:
        raise BoundaryError("workflow output unavailable")
    if "\n" in value or "\r" in value:
        raise BoundaryError("workflow output unavailable")
    try:
        with Path(output_path).open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(f"{key}={value}\n")
    except OSError as exc:
        raise BoundaryError("workflow output unavailable") from exc


def _validated_callback_host(origin: object) -> str | None:
    if type(origin) is not str:
        return None
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return None
    host = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
        or not HOST_RE.fullmatch(host)
        or host != host.lower()
    ):
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return None
    if origin != f"https://{host}":
        return None
    return host


def _callback_target(environ: Mapping[str, str]) -> tuple[str, str]:
    configured_origin = environ.get("PAPER_SLIDE_WORKFLOW_CALLBACK_ORIGIN", "")
    approved_origin = APPROVED_CALLBACK_ORIGIN
    token = environ.get("PAPER_SLIDE_WORKFLOW_CALLBACK_TOKEN", "")
    host = _validated_callback_host(approved_origin)
    if host is None or configured_origin != approved_origin or TOKEN_RE.fullmatch(token) is None:
        raise BoundaryError("callback configuration unavailable")
    return host, token


def _closed_callback(
    environ: Mapping[str, str],
    path: str,
    body: dict[str, Any],
    *,
    connection_factory: Callable[..., Any] = http.client.HTTPSConnection,
) -> dict[str, Any]:
    host, token = _callback_target(environ)
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    connection: Any | None = None
    try:
        connection = connection_factory(host, 443, timeout=CALLBACK_TIMEOUT_SECONDS)
        connection.request(
            "POST",
            path,
            body=encoded,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(encoded)),
                "User-Agent": "paperpilot-paper-slide-workflow",
            },
        )
        response = connection.getresponse()
        status_code = response.status
        if not isinstance(status_code, int):
            raise AmbiguousCallbackError("callback outcome uncertain")
        if status_code != 200:
            if status_code >= 500 or status_code in {408, 409, 425, 429}:
                raise AmbiguousCallbackError("callback outcome uncertain")
            raise DefinitiveCallbackError("callback rejected")
        content_type = response.getheader("content-type", "")
        declared = response.getheader("content-length")
        declared_length: int | None = None
        if declared is not None:
            if re.fullmatch(r"(?:0|[1-9][0-9]*)", declared) is None:
                raise AmbiguousCallbackError("callback outcome uncertain")
            declared_length = int(declared)
            if declared_length > MAX_CALLBACK_RESPONSE_BYTES:
                raise AmbiguousCallbackError("callback outcome uncertain")
        raw = response.read(MAX_CALLBACK_RESPONSE_BYTES + 1)
        if (
            len(raw) > MAX_CALLBACK_RESPONSE_BYTES
            or (declared_length is not None and declared_length != len(raw))
            or re.fullmatch(
                r'application/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?',
                content_type,
                re.IGNORECASE,
            )
            is None
        ):
            raise AmbiguousCallbackError("callback outcome uncertain")
    except BoundaryError:
        raise
    except Exception as exc:
        raise AmbiguousCallbackError("callback outcome uncertain") from exc
    finally:
        if connection is not None:
            with suppress(Exception):
                connection.close()
    try:
        value = _decode_unique_json(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise AmbiguousCallbackError("callback outcome uncertain") from exc
    if type(value) is not dict:
        raise AmbiguousCallbackError("callback outcome uncertain")
    return value


def _parse_claim_decision(value: dict[str, Any]) -> ClaimDecision:
    expected = {
        "schema_version",
        "ok",
        "claimed",
        "reclaimed",
        "lease_generation",
        "lease_expires_at",
    }
    if set(value) != expected or value["schema_version"] != CALLBACK_SCHEMA:
        raise AmbiguousCallbackError("callback outcome uncertain")
    if value["ok"] is not True or type(value["claimed"]) is not bool:
        raise AmbiguousCallbackError("callback outcome uncertain")
    if type(value["reclaimed"]) is not bool:
        raise AmbiguousCallbackError("callback outcome uncertain")
    if not value["claimed"]:
        if (
            value["reclaimed"] is not False
            or value["lease_generation"] is not None
            or value["lease_expires_at"] is not None
        ):
            raise AmbiguousCallbackError("callback outcome uncertain")
        return ClaimDecision(False, False, None, None)
    lease_generation = value["lease_generation"]
    lease_expires_at = value["lease_expires_at"]
    if (
        value["reclaimed"] is not False
        or type(lease_generation) is not int
        or lease_generation not in {1, 2}
        or type(lease_expires_at) is not str
        or LEASE_EXPIRES_RE.fullmatch(lease_expires_at) is None
    ):
        raise AmbiguousCallbackError("callback outcome uncertain")
    try:
        datetime.strptime(lease_expires_at, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise AmbiguousCallbackError("callback outcome uncertain") from exc
    return ClaimDecision(True, False, lease_generation, lease_expires_at)


def claim_job(
    environ: Mapping[str, str],
    *,
    connection_factory: Callable[..., Any] = http.client.HTTPSConnection,
) -> ClaimDecision:
    job_id = environ.get("PAPER_SLIDE_JOB_ID", "")
    if JOB_ID_RE.fullmatch(job_id) is None:
        raise BoundaryError("invalid job identifier")
    claimant_token = derive_claimant_token(environ)
    claim_body = {
        "claimant_token": claimant_token,
        "job_id": job_id,
        "lease_generation": 0,
        "reclaim": False,
    }
    for attempt in range(MAX_CLAIM_ATTEMPTS):
        try:
            value = _closed_callback(
                environ,
                "/api/paper-slides/internal/claim",
                claim_body,
                connection_factory=connection_factory,
            )
            return _parse_claim_decision(value)
        except AmbiguousCallbackError:
            if attempt + 1 == MAX_CLAIM_ATTEMPTS:
                raise
    raise AmbiguousCallbackError("callback outcome uncertain")


def _lease_generation(environ: Mapping[str, str]) -> int:
    raw = environ.get("PAPER_SLIDE_LEASE_GENERATION", "")
    if raw not in {"1", "2"}:
        raise BoundaryError("lease generation unavailable")
    return int(raw)


def _require_updated_response(value: dict[str, Any]) -> None:
    if set(value) != {"schema_version", "ok", "updated"} or value != {
        "schema_version": CALLBACK_SCHEMA,
        "ok": True,
        "updated": True,
    }:
        raise AmbiguousCallbackError("callback outcome uncertain")


def fence_provider(
    environ: Mapping[str, str],
    *,
    connection_factory: Callable[..., Any] = http.client.HTTPSConnection,
) -> None:
    """Atomically fence the current claimant before any future provider call."""

    job_id = environ.get("PAPER_SLIDE_JOB_ID", "")
    if JOB_ID_RE.fullmatch(job_id) is None:
        raise BoundaryError("invalid job identifier")
    lease_generation = _lease_generation(environ)
    claimant_token = derive_claimant_token(environ)
    value = _closed_callback(
        environ,
        "/api/paper-slides/internal/status",
        {
            "claimant_token": claimant_token,
            "job_id": job_id,
            "lease_generation": lease_generation,
            "status": {
                "coverage": None,
                "deck_id": None,
                "message_code": "PAPER_SLIDE_GENERATING",
                "phase": "generating",
                "preview_available": False,
                "preview_expires_at": None,
                "public_url": None,
                "retryable": None,
                "status": "running",
            },
        },
        connection_factory=connection_factory,
    )
    _require_updated_response(value)


def close_claimed_scaffold(
    environ: Mapping[str, str],
    *,
    connection_factory: Callable[..., Any] = http.client.HTTPSConnection,
) -> None:
    """Move an accidentally claimed dormant run to a closed failed state."""

    job_id = environ.get("PAPER_SLIDE_JOB_ID", "")
    if JOB_ID_RE.fullmatch(job_id) is None:
        raise BoundaryError("invalid job identifier")
    lease_generation = _lease_generation(environ)
    claimant_token = derive_claimant_token(environ)
    value = _closed_callback(
        environ,
        "/api/paper-slides/internal/status",
        {
            "claimant_token": claimant_token,
            "job_id": job_id,
            "lease_generation": lease_generation,
            "status": {
                "coverage": None,
                "deck_id": None,
                "message_code": "PAPER_SLIDE_FAILED",
                "phase": None,
                "preview_available": False,
                "preview_expires_at": None,
                "public_url": None,
                "retryable": False,
                "status": "failed",
            },
        },
        connection_factory=connection_factory,
    )
    _require_updated_response(value)


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    env = os.environ if environ is None else environ
    if len(args) != 1 or args[0] not in {"preflight", "claim", "fence-provider", "close-scaffold"}:
        print("paper-slide workflow boundary: invalid command", file=sys.stderr)
        return 2
    try:
        if args[0] == "preflight":
            validate_dispatch_inputs(env)
            authorized = provider_gate_authorized(Path.cwd())
            _write_github_output(env, "authorized", "true" if authorized else "false")
            if not authorized:
                print("Paper Slide provider gate is closed; generation remains disabled.")
            return 0
        if args[0] == "claim":
            decision = claim_job(env)
            # Write the non-secret generation first. Cleanup predicates require
            # both outputs, so a partial output write cannot use a missing fence.
            _write_github_output(
                env,
                "lease_generation",
                str(decision.lease_generation) if decision.lease_generation is not None else "0",
            )
            _write_github_output(env, "claimed", "true" if decision.claimed else "false")
            if not decision.claimed:
                print("Paper Slide job was not claimed; no generation will run.")
            return 0
        if args[0] == "fence-provider":
            fence_provider(env)
            print("Paper Slide provider fence committed; no provider is wired.")
            return 0
        close_claimed_scaffold(env)
        print("Claimed dormant job was closed without provider execution.")
        return 0
    except BoundaryError:
        print("paper-slide workflow boundary: closed failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
