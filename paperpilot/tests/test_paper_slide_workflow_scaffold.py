"""Fail-closed contract tests for the dormant Paper Slide workflow."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import re
from base64 import urlsafe_b64encode
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import yaml

from paperpilot.paper_slides.generator_budget import (
    HARD_MAX_CALLS,
    HARD_MAX_INPUT_TOKENS,
    HARD_MAX_OUTPUT_TOKENS,
    HARD_MAX_OUTPUT_TOKENS_PER_CALL,
    HARD_MAX_WALL_SECONDS,
)
from paperpilot.paper_slides.provider_execution import (
    CONFIG_VERSION,
    load_provider_execution_config,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/paper-slides-on-demand.yml"
SCRIPT_PATH = REPO_ROOT / ".github/scripts/paper_slide_workflow.py"
DISPATCH_PATH = REPO_ROOT / "worker/paper-slide-dispatch.js"
WORKFLOW_API_PATH = REPO_ROOT / "worker/paper-slide-workflow-api.js"
INPUTS = {
    "paper_id",
    "job_id",
    "language",
    "coverage_preference",
    "snapshot_version",
    "job_key",
}
CLAIMANT_KEY = urlsafe_b64encode(bytes(range(32))).rstrip(b"=").decode("ascii")
LEASE_EXPIRES_AT = "2026-09-04T12:49:56.789Z"


def _provider_config(schema_version: str = CONFIG_VERSION) -> dict[str, Any]:
    return {
        "schema_version": schema_version,
        "provider": "offline-fixture",
        "model": "fixture-model",
        "adapter_version": "fixture-adapter-v1",
        "pricing_snapshot_sha256": "c" * 64,
        "budget": {
            "max_calls": 2,
            "max_input_tokens": 10_000,
            "max_output_tokens": 2_000,
            "max_output_tokens_per_call": 1_000,
            "max_wall_seconds": 60,
            "max_cost_micro_units": 12_000,
        },
    }


def _canonical_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def _approve_registry_identity(
    boundary: ModuleType, value: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    identity = tuple(value[key] for key in boundary.PROVIDER_IDENTITY_KEYS)
    monkeypatch.setattr(boundary, "APPROVED_PROVIDER_REGISTRY_IDENTITIES", frozenset({identity}))


def _load_workflow() -> dict[str, Any]:
    value = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _on(value: dict[str, Any]) -> Any:
    return value.get("on", value.get(True))


def _load_boundary() -> ModuleType:
    spec = importlib.util.spec_from_file_location("paper_slide_workflow", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _valid_environment(tmp_path: Path) -> dict[str, str]:
    return {
        "PAPER_SLIDE_PAPER_ID": "a" * 40,
        "PAPER_SLIDE_JOB_ID": f"paper-slide-job-{'A' * 22}",
        "PAPER_SLIDE_LANGUAGE": "ja",
        "PAPER_SLIDE_COVERAGE_PREFERENCE": "auto",
        "PAPER_SLIDE_SNAPSHOT_VERSION": "catalog-v1:2026-09-04",
        "PAPER_SLIDE_JOB_KEY": "b" * 64,
        "PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY": CLAIMANT_KEY,
        "GITHUB_REPOSITORY": "taichiiiiiiii/automatic-paper-search",
        "GITHUB_REPOSITORY_ID": "987654321",
        "GITHUB_WORKFLOW_REF": (
            "taichiiiiiiii/automatic-paper-search/"
            ".github/workflows/paper-slides-on-demand.yml@refs/heads/develop"
        ),
        "GITHUB_RUN_ID": "123456789",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_SHA": "d" * 40,
        "GITHUB_OUTPUT": str(tmp_path / "output"),
    }


def _claim_response(boundary: ModuleType, claimed: bool = True) -> dict[str, Any]:
    return {
        "schema_version": boundary.CALLBACK_SCHEMA,
        "ok": True,
        "claimed": claimed,
        "reclaimed": False,
        "lease_generation": 1 if claimed else None,
        "lease_expires_at": LEASE_EXPIRES_AT if claimed else None,
    }


class _Response:
    def __init__(
        self,
        body: dict[str, Any],
        *,
        status: int = 200,
        declared_length: str = "auto",
    ) -> None:
        self.status = status
        self._raw = json.dumps(body, separators=(",", ":")).encode()
        self._declared_length = (
            str(len(self._raw)) if declared_length == "auto" else declared_length
        )

    def getheader(self, name: str, default: str | None = None) -> str | None:
        if name.lower() == "content-type":
            return "application/json; charset=utf-8"
        if name.lower() == "content-length":
            return self._declared_length
        return default

    def read(self, maximum: int) -> bytes:
        return self._raw[:maximum]


class _Connection:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.request_args: tuple[Any, ...] | None = None
        self.request_kwargs: dict[str, Any] | None = None
        self.closed = False

    def request(self, *args: Any, **kwargs: Any) -> None:
        self.request_args = args
        self.request_kwargs = kwargs

    def getresponse(self) -> _Response:
        return self.response

    def close(self) -> None:
        self.closed = True


def _connection_factory(connection: _Connection):
    def factory(host: str, port: int, *, timeout: int) -> _Connection:
        assert host == "slides-api.example.com"
        assert port == 443
        assert timeout == 10
        return connection

    return factory


def _connection_sequence(responses: list[_Response]):
    connections: list[_Connection] = []

    def factory(host: str, port: int, *, timeout: int) -> _Connection:
        assert host == "slides-api.example.com"
        assert port == 443
        assert timeout == 10
        response = responses[min(len(connections), len(responses) - 1)]
        connection = _Connection(response)
        connections.append(connection)
        return connection

    return factory, connections


def test_workflow_accepts_exact_dispatch_inputs_with_least_permissions() -> None:
    workflow = _load_workflow()
    trigger = _on(workflow)
    assert isinstance(trigger, dict) and set(trigger) == {"workflow_dispatch"}
    inputs = trigger["workflow_dispatch"]["inputs"]
    assert set(inputs) == INPUTS
    assert all(value["required"] is True and value["type"] == "string" for value in inputs.values())
    assert workflow["permissions"] == {}
    assert workflow["concurrency"] == {
        "group": "paper-slide-${{ inputs.job_id }}",
        "cancel-in-progress": False,
    }
    job = workflow["jobs"]["guarded-request"]
    assert job["if"] == "github.ref == 'refs/heads/develop'"
    assert job["permissions"] == {"contents": "read"}
    assert job["timeout-minutes"] == 5


def test_workflow_inputs_match_worker_dispatch_adapter_exactly() -> None:
    source = DISPATCH_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"const INPUT_KEYS = Object\.freeze\(\[(?P<body>.*?)\]\);",
        source,
        re.DOTALL,
    )
    assert match is not None
    dispatch_inputs = set(re.findall(r'"([a-z_]+)"', match.group("body")))
    assert dispatch_inputs == INPUTS


def test_callback_bodies_match_worker_claim_and_status_envelopes() -> None:
    source = WORKFLOW_API_PATH.read_text(encoding="utf-8")
    claim_match = re.search(
        r"const CLAIM_KEYS = Object\.freeze\(\[(?P<body>.*?)\]\);",
        source,
        re.DOTALL,
    )
    status_match = re.search(
        r"const STATUS_ENVELOPE_KEYS = Object\.freeze\(\[(?P<body>.*?)\]\);",
        source,
        re.DOTALL,
    )
    assert claim_match is not None and status_match is not None
    assert set(re.findall(r'"([a-z_]+)"', claim_match.group("body"))) == {
        "claimant_token",
        "job_id",
        "lease_generation",
        "reclaim",
    }
    assert set(re.findall(r'"([a-z_]+)"', status_match.group("body"))) == {
        "claimant_token",
        "job_id",
        "lease_generation",
        "status",
    }


def test_workflow_claims_before_any_future_provider_and_is_dormant() -> None:
    workflow = _load_workflow()
    steps = workflow["jobs"]["guarded-request"]["steps"]
    names = [step["name"] for step in steps]
    assert names == [
        "Checkout immutable workflow code",
        "Validate inputs and provider approval gate",
        "Refuse generation while provider gate is closed",
        "Claim the underlying job before any provider execution",
        "Stop duplicate or late delivery without generation",
        "Commit atomic provider fence without provider execution",
        "Close claimed scaffold without generation",
        "Fail claimed scaffold after safe closure",
    ]
    assert names.index("Validate inputs and provider approval gate") < names.index(
        "Claim the underlying job before any provider execution"
    )
    assert names.index("Claim the underlying job before any provider execution") < names.index(
        "Commit atomic provider fence without provider execution"
    )
    assert names.index("Commit atomic provider fence without provider execution") < names.index(
        "Close claimed scaffold without generation"
    )
    gate = next(step for step in steps if step.get("id") == "provider_gate")
    assert set(gate["env"]) == {
        "PAPER_SLIDE_PAPER_ID",
        "PAPER_SLIDE_JOB_ID",
        "PAPER_SLIDE_LANGUAGE",
        "PAPER_SLIDE_COVERAGE_PREFERENCE",
        "PAPER_SLIDE_SNAPSHOT_VERSION",
        "PAPER_SLIDE_JOB_KEY",
    }
    claim = next(step for step in steps if step.get("id") == "claim")
    assert claim["if"] == "steps.provider_gate.outputs.authorized == 'true'"
    assert set(claim["env"]) == {
        "PAPER_SLIDE_PAPER_ID",
        "PAPER_SLIDE_JOB_ID",
        "PAPER_SLIDE_LANGUAGE",
        "PAPER_SLIDE_COVERAGE_PREFERENCE",
        "PAPER_SLIDE_SNAPSHOT_VERSION",
        "PAPER_SLIDE_JOB_KEY",
        "PAPER_SLIDE_WORKFLOW_CALLBACK_ORIGIN",
        "PAPER_SLIDE_WORKFLOW_CALLBACK_TOKEN",
        "PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY",
    }
    fence = next(step for step in steps if "provider fence" in step["name"])
    assert "steps.claim.outputs.lease_generation == '1'" in fence["if"]
    assert "steps.claim.outputs.lease_generation == '2'" in fence["if"]
    assert set(fence["env"]) == set(claim["env"]) | {"PAPER_SLIDE_LEASE_GENERATION"}
    close = next(
        step for step in steps if step["name"] == "Close claimed scaffold without generation"
    )
    assert close["if"].startswith("always() &&")
    assert "steps.claim.outputs.claimed == 'true'" in close["if"]
    assert "steps.claim.outputs.lease_generation == '1'" in close["if"]
    assert "steps.claim.outputs.lease_generation == '2'" in close["if"]
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    assert "PAPER_SLIDE_WORKFLOW_CALLBACK_ORIGIN: ${{ vars." in text
    assert "PAPER_SLIDE_WORKFLOW_CALLBACK_TOKEN: ${{ secrets." in text
    assert "PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY: ${{ secrets." in text
    assert "GITHUB_RUN_ATTEMPT" not in text
    assert "No automatic reclaim is attempted" in text
    assert "reclaim: true" not in text
    assert "claimant_token" not in text
    assert "provider execution is not implemented" in text
    assert not re.search(r"\b(?:git push|gh workflow run|deploy-pages|upload-artifact)\b", text)
    assert "PAPERPILOT_GROQ_API_KEY" not in text
    assert "QWEN" not in text.upper()
    run_commands = "\n".join(str(step.get("run", "")) for step in steps)
    assert "paper_slide_workflow.py preflight" in run_commands
    assert "paper_slide_workflow.py claim" in run_commands
    assert "paper_slide_workflow.py fence-provider" in run_commands
    assert "paper_slide_workflow.py close-scaffold" in run_commands
    assert not re.search(r"\b(?:uv|pip|curl|wget|npm|docker)\b", run_commands)
    fence_index = names.index("Commit atomic provider fence without provider execution")
    commands_before_fence = "\n".join(str(step.get("run", "")) for step in steps[:fence_index])
    assert "paperpilot.paper_slides" not in commands_before_fence
    assert "generate.py" not in commands_before_fence


def test_actions_are_pinned_and_checkout_does_not_persist_credentials() -> None:
    workflow = _load_workflow()
    steps = workflow["jobs"]["guarded-request"]["steps"]
    uses = [step["uses"] for step in steps if "uses" in step]
    assert uses == ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262"]
    checkout = next(step for step in steps if "uses" in step)
    assert checkout["with"] == {
        "ref": "${{ github.sha }}",
        "persist-credentials": False,
    }


def test_dispatch_input_validator_accepts_only_closed_bounded_values(tmp_path: Path) -> None:
    boundary = _load_boundary()
    valid = _valid_environment(tmp_path)
    assert set(boundary.validate_dispatch_inputs(valid)) == INPUTS
    probes = {
        "PAPER_SLIDE_PAPER_ID": "A" * 40,
        "PAPER_SLIDE_JOB_ID": f"paper-slide-job-{'A' * 23}",
        "PAPER_SLIDE_LANGUAGE": "fr",
        "PAPER_SLIDE_COVERAGE_PREFERENCE": "full_text",
        "PAPER_SLIDE_SNAPSHOT_VERSION": "v/1",
        "PAPER_SLIDE_JOB_KEY": "b" * 63,
    }
    for name, invalid in probes.items():
        environment = {**valid, name: invalid}
        with pytest.raises(boundary.BoundaryError, match="invalid dispatch input"):
            boundary.validate_dispatch_inputs(environment)


def test_provider_gate_is_code_pinned_closed_even_if_file_appears(tmp_path: Path) -> None:
    boundary = _load_boundary()
    gate = tmp_path / boundary.PROVIDER_GATE_PATH
    gate.parent.mkdir(parents=True)
    gate.write_bytes(_canonical_bytes(_provider_config()))
    assert boundary.APPROVED_PROVIDER_GATE_SHA256 is None
    assert frozenset() == boundary.APPROVED_PROVIDER_REGISTRY_IDENTITIES
    assert boundary.provider_gate_authorized(tmp_path) is False


def test_future_provider_gate_requires_exact_canonical_pinned_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    value = _provider_config()
    raw = _canonical_bytes(value)
    gate = tmp_path / boundary.PROVIDER_GATE_PATH
    gate.parent.mkdir(parents=True)
    gate.write_bytes(raw)
    monkeypatch.setattr(boundary, "APPROVED_PROVIDER_GATE_SHA256", hashlib.sha256(raw).hexdigest())
    assert boundary.provider_gate_authorized(tmp_path) is False

    _approve_registry_identity(boundary, value, monkeypatch)
    assert boundary.provider_gate_authorized(tmp_path) is True

    noncanonical = json.dumps(value, indent=2).encode()
    gate.write_bytes(noncanonical)
    monkeypatch.setattr(
        boundary,
        "APPROVED_PROVIDER_GATE_SHA256",
        hashlib.sha256(noncanonical).hexdigest(),
    )
    assert boundary.provider_gate_authorized(tmp_path) is False


def test_provider_gate_schema_and_bounds_match_provider_execution_contract() -> None:
    boundary = _load_boundary()
    value = _provider_config()
    checked = load_provider_execution_config(value)
    assert boundary.PROVIDER_GATE_SCHEMA == CONFIG_VERSION
    assert set(value) == boundary.PROVIDER_GATE_KEYS
    assert set(value["budget"]) == boundary.PROVIDER_BUDGET_KEYS
    assert boundary.PROVIDER_BUDGET_MAXIMA == {
        "max_calls": HARD_MAX_CALLS,
        "max_cost_micro_units": (1 << 63) - 1,
        "max_input_tokens": HARD_MAX_INPUT_TOKENS,
        "max_output_tokens": HARD_MAX_OUTPUT_TOKENS,
        "max_output_tokens_per_call": HARD_MAX_OUTPUT_TOKENS_PER_CALL,
        "max_wall_seconds": HARD_MAX_WALL_SECONDS,
    }
    assert checked.schema_version == boundary.PROVIDER_GATE_SCHEMA
    assert boundary._valid_provider_gate(value) is True
    assert boundary._valid_provider_gate({**value, "enabled": True}) is False


def test_provider_gate_rejects_final_and_ancestor_symlinks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    value = _provider_config()
    raw = _canonical_bytes(value)
    monkeypatch.setattr(boundary, "APPROVED_PROVIDER_GATE_SHA256", hashlib.sha256(raw).hexdigest())
    _approve_registry_identity(boundary, value, monkeypatch)

    real_gate = tmp_path / "real-gate.json"
    real_gate.write_bytes(raw)
    final_link = tmp_path / boundary.PROVIDER_GATE_PATH
    final_link.parent.mkdir(parents=True)
    final_link.symlink_to(real_gate)
    assert boundary.provider_gate_authorized(tmp_path) is False

    other_root = tmp_path / "other"
    ancestor_target = other_root / "paperpilot/data"
    ancestor_target.mkdir(parents=True)
    (ancestor_target / "paper-slide-provider-v1.json").write_bytes(raw)
    linked_root = tmp_path / "linked-root"
    linked_root.mkdir()
    (linked_root / "paperpilot").symlink_to(other_root / "paperpilot", target_is_directory=True)
    assert boundary.provider_gate_authorized(linked_root) is False


def test_provider_gate_rejects_lstat_open_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    value = _provider_config()
    raw = _canonical_bytes(value)
    gate = tmp_path / boundary.PROVIDER_GATE_PATH
    gate.parent.mkdir(parents=True)
    gate.write_bytes(raw)
    monkeypatch.setattr(boundary, "APPROVED_PROVIDER_GATE_SHA256", hashlib.sha256(raw).hexdigest())
    _approve_registry_identity(boundary, value, monkeypatch)
    original_open = boundary.os.open
    backup = gate.with_suffix(".original")
    replaced = False

    def replace_before_open(path: Path, flags: int) -> int:
        nonlocal replaced
        if not replaced:
            replaced = True
            gate.replace(backup)
            gate.write_bytes(raw)
        return original_open(path, flags)

    monkeypatch.setattr(boundary.os, "open", replace_before_open)
    assert boundary.provider_gate_authorized(tmp_path) is False


def _callback_environment(tmp_path: Path) -> dict[str, str]:
    return {
        **_valid_environment(tmp_path),
        "PAPER_SLIDE_WORKFLOW_CALLBACK_ORIGIN": "https://slides-api.example.com",
        "PAPER_SLIDE_WORKFLOW_CALLBACK_TOKEN": "s" * 32,
    }


def _approve_callback(boundary: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(boundary, "APPROVED_CALLBACK_ORIGIN", "https://slides-api.example.com")


def test_claimant_token_is_exact_hmac_domain_separated_and_rerun_stable(
    tmp_path: Path,
) -> None:
    boundary = _load_boundary()
    environment = _callback_environment(tmp_path)
    token = boundary.derive_claimant_token(environment)
    assert re.fullmatch(r"psct_[A-Za-z0-9_-]{43}", token)

    dispatch = boundary.validate_dispatch_inputs(environment)
    message = json.dumps(
        {
            "job": dispatch,
            "run": {
                "repository": environment["GITHUB_REPOSITORY"],
                "repository_id": environment["GITHUB_REPOSITORY_ID"],
                "run_id": environment["GITHUB_RUN_ID"],
                "workflow_ref": environment["GITHUB_WORKFLOW_REF"],
                "workflow_sha": environment["GITHUB_SHA"],
            },
            "schema_version": boundary.CLAIMANT_DERIVATION_SCHEMA,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    expected_digest = hmac.digest(
        bytes(range(32)), boundary.CLAIMANT_HMAC_DOMAIN + message, "sha256"
    )
    assert token == "psct_" + urlsafe_b64encode(expected_digest).rstrip(b"=").decode()

    rerun = {**environment, "GITHUB_RUN_ATTEMPT": "999"}
    assert boundary.derive_claimant_token(rerun) == token
    assert boundary.derive_claimant_token({**environment, "GITHUB_RUN_ID": "123456790"}) != token
    assert boundary.derive_claimant_token({**environment, "PAPER_SLIDE_JOB_KEY": "e" * 64}) != token


@pytest.mark.parametrize("claimed", [True, False])
def test_claim_uses_exact_generation_zero_body_and_closed_response(
    tmp_path: Path, claimed: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = _callback_environment(tmp_path)
    connection = _Connection(_Response(_claim_response(boundary, claimed)))
    decision = boundary.claim_job(environment, connection_factory=_connection_factory(connection))
    assert decision.claimed is claimed
    assert decision.reclaimed is False
    assert decision.lease_generation == (1 if claimed else None)
    assert decision.lease_expires_at == (LEASE_EXPIRES_AT if claimed else None)
    assert connection.request_args == (
        "POST",
        "/api/paper-slides/internal/claim",
    )
    assert connection.request_kwargs is not None
    headers = connection.request_kwargs["headers"]
    assert headers["Authorization"] == f"Bearer {'s' * 32}"
    claimant_token = boundary.derive_claimant_token(environment)
    assert json.loads(connection.request_kwargs["body"]) == {
        "claimant_token": claimant_token,
        "job_id": environment["PAPER_SLIDE_JOB_ID"],
        "lease_generation": 0,
        "reclaim": False,
    }
    assert connection.closed is True


def test_ambiguous_claim_retries_same_body_and_token_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = _callback_environment(tmp_path)
    factory, connections = _connection_sequence(
        [
            _Response(_claim_response(boundary), declared_length="1"),
            _Response(_claim_response(boundary)),
        ]
    )
    decision = boundary.claim_job(environment, connection_factory=factory)
    assert decision.claimed is True
    assert len(connections) == 2
    bodies = [connection.request_kwargs["body"] for connection in connections]
    assert bodies[0] == bodies[1]
    parsed = json.loads(bodies[0])
    assert parsed["reclaim"] is False
    assert parsed["lease_generation"] == 0
    assert parsed["claimant_token"] == boundary.derive_claimant_token(environment)


def test_definitive_claim_rejection_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = _callback_environment(tmp_path)
    factory, connections = _connection_sequence([_Response({"error": "closed"}, status=400)])
    with pytest.raises(boundary.DefinitiveCallbackError, match="callback rejected"):
        boundary.claim_job(environment, connection_factory=factory)
    assert len(connections) == 1


def test_ambiguous_claim_retry_is_bounded_to_three_attempts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = _callback_environment(tmp_path)
    factory, connections = _connection_sequence(
        [_Response(_claim_response(boundary), declared_length="1")]
    )
    with pytest.raises(boundary.AmbiguousCallbackError, match="outcome uncertain"):
        boundary.claim_job(environment, connection_factory=factory)
    assert boundary.MAX_CLAIM_ATTEMPTS == 3
    assert len(connections) == 3
    assert len({connection.request_kwargs["body"] for connection in connections}) == 1


def test_claim_rejects_unpinned_or_mismatched_origin_before_sending_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    environment = _callback_environment(tmp_path)
    with pytest.raises(boundary.BoundaryError, match="callback configuration unavailable"):
        boundary.claim_job(environment)

    _approve_callback(boundary, monkeypatch)
    environment["PAPER_SLIDE_WORKFLOW_CALLBACK_ORIGIN"] = "https://evil.example.com"
    called = False

    def forbidden_connection(*args: Any, **kwargs: Any) -> None:
        nonlocal called
        called = True
        raise AssertionError("connection must not be created")

    with pytest.raises(boundary.BoundaryError, match="callback configuration unavailable"):
        boundary.claim_job(environment, connection_factory=forbidden_connection)
    assert called is False


def test_claim_rejects_malformed_or_length_mismatched_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = _callback_environment(tmp_path)
    connection = _Connection(_Response({**_claim_response(boundary), "claimed": "yes"}))
    with pytest.raises(boundary.AmbiguousCallbackError, match="outcome uncertain"):
        boundary.claim_job(environment, connection_factory=_connection_factory(connection))

    mismatch = _Connection(
        _Response(
            _claim_response(boundary),
            declared_length="1",
        )
    )
    with pytest.raises(boundary.AmbiguousCallbackError, match="outcome uncertain"):
        boundary.claim_job(environment, connection_factory=_connection_factory(mismatch))


def test_fence_provider_posts_generating_with_current_claim_and_waits_for_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = {**_callback_environment(tmp_path), "PAPER_SLIDE_LEASE_GENERATION": "1"}
    connection = _Connection(
        _Response({"schema_version": boundary.CALLBACK_SCHEMA, "ok": True, "updated": True})
    )
    boundary.fence_provider(environment, connection_factory=_connection_factory(connection))
    assert connection.request_args == ("POST", "/api/paper-slides/internal/status")
    assert connection.request_kwargs is not None
    payload = json.loads(connection.request_kwargs["body"])
    assert payload == {
        "claimant_token": boundary.derive_claimant_token(environment),
        "job_id": environment["PAPER_SLIDE_JOB_ID"],
        "lease_generation": 1,
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
    }


def test_fence_provider_does_not_return_on_unconfirmed_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = {**_callback_environment(tmp_path), "PAPER_SLIDE_LEASE_GENERATION": "1"}
    connection = _Connection(
        _Response({"schema_version": boundary.CALLBACK_SCHEMA, "ok": True, "updated": False})
    )
    with pytest.raises(boundary.AmbiguousCallbackError, match="outcome uncertain"):
        boundary.fence_provider(environment, connection_factory=_connection_factory(connection))


def test_claimed_scaffold_is_closed_as_failed_without_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boundary = _load_boundary()
    _approve_callback(boundary, monkeypatch)
    environment = {**_callback_environment(tmp_path), "PAPER_SLIDE_LEASE_GENERATION": "1"}
    connection = _Connection(
        _Response({"schema_version": boundary.CALLBACK_SCHEMA, "ok": True, "updated": True})
    )
    boundary.close_claimed_scaffold(environment, connection_factory=_connection_factory(connection))
    assert connection.request_args == (
        "POST",
        "/api/paper-slides/internal/status",
    )
    assert connection.request_kwargs is not None
    payload = json.loads(connection.request_kwargs["body"])
    assert payload["claimant_token"] == boundary.derive_claimant_token(environment)
    assert payload["job_id"] == environment["PAPER_SLIDE_JOB_ID"]
    assert payload["lease_generation"] == 1
    assert payload["status"] == {
        "coverage": None,
        "deck_id": None,
        "message_code": "PAPER_SLIDE_FAILED",
        "phase": None,
        "preview_available": False,
        "preview_expires_at": None,
        "public_url": None,
        "retryable": False,
        "status": "failed",
    }


def test_cli_preflight_writes_false_and_never_authorizes_generation(tmp_path: Path) -> None:
    boundary = _load_boundary()
    environment = _valid_environment(tmp_path)
    assert boundary.main(["preflight"], environment) == 0
    assert Path(environment["GITHUB_OUTPUT"]).read_text(encoding="utf-8") == ("authorized=false\n")


def test_cli_claim_outputs_only_nonsecret_decision_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    boundary = _load_boundary()
    environment = _callback_environment(tmp_path)
    decision = boundary.ClaimDecision(True, False, 1, LEASE_EXPIRES_AT)
    monkeypatch.setattr(boundary, "claim_job", lambda _environment: decision)
    assert boundary.main(["claim"], environment) == 0
    output = Path(environment["GITHUB_OUTPUT"]).read_text(encoding="utf-8")
    assert output == "lease_generation=1\nclaimed=true\n"
    claimant_token = boundary.derive_claimant_token(environment)
    captured = capsys.readouterr()
    assert claimant_token not in output
    assert claimant_token not in captured.out
    assert claimant_token not in captured.err
