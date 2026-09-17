"""Host-only offline contract for repository-owned PaperPilot agent routing.

The operational ``.codex`` tree is intentionally absent from Docker build
contexts, so the application test image skips this non-runtime contract.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest

ROOT = Path(__file__).resolve().parents[2]
AGENT_ROOT = ROOT / ".codex" / "agents"
OLD_NATIVE_IMPLEMENTERS = (
    AGENT_ROOT / "paperpilot_backend_implementer.toml",
    AGENT_ROOT / "paperpilot_frontend_implementer.toml",
)
pytestmark = pytest.mark.skipif(
    not AGENT_ROOT.is_dir(),
    reason="repository-owned .codex profiles are outside the Docker build context",
)


def _toml(path: Path) -> dict[str, object]:
    try:
        import tomllib
    except ImportError:
        pytest.skip("tomllib requires Python 3.11+")
    with path.open("rb") as source:
        return cast(dict[str, object], tomllib.load(source))


def test_retained_inactive_launcher_keeps_its_original_safety_contract() -> None:
    for path in OLD_NATIVE_IMPLEMENTERS:
        assert not path.exists()
        policy = ROOT / ".codex" / "runners" / (path.stem + ".instructions.md")
        instructions = policy.read_text(encoding="utf-8")
        # The fixed domain policy is retained; the launcher appends the latest
        # route banner before the bounded task so Cloud selection cannot rewrite it.
        assert "qwen3.8-flash" in instructions
        assert "reasoning effort none" in instructions
        assert "workspace-write" in instructions
        assert "SOL parent" in instructions
    launcher = (ROOT / ".codex" / "bin" / "qwen-implement").read_text(encoding="utf-8")
    assert 'MODEL="qwen38-flash-next"' in launcher
    assert 'PROVIDER="qwen_flash_local"' in launcher
    assert 'REASONING="none"' in launcher
    assert "qwen-cloud-runner.py" in launcher
    assert "--interactive" in launcher
    assert "--cloud-only" in launcher
    assert 'CATALOG="/Users/example/.codex-local-flash/models.json"' in launcher
    for role in ("backend", "frontend"):
        assert f'POLICY_BASENAME="paperpilot_{role}_implementer.instructions.md"' in launcher
    assert "--ignore-user-config" in launcher
    assert "analytics.enabled=false" in launcher
    assert "Routing authority (latest user instruction" in launcher
    assert 'EXECUTION_MODE="cloud-only"' in launcher

    runner = (ROOT / ".codex" / "bin" / "qwen-cloud-runner.py").read_text(encoding="utf-8")
    assert 'QUEUE = Path("/Users/example/.local/bin/qwen-implementation-queue")' in runner
    assert "qwen3.8-flash" in runner
    assert "--interactive" in runner
    assert "cloud-only" in runner
    assert "PROVIDER_CONFIG" not in runner
    assert "Keychain" in runner

    operations = (ROOT / "docs" / "QWEN_IMPLEMENTER.md").read_text(encoding="utf-8")
    for term in (
        "qwen38-flash-next",
        "qwen3.7-plus",
        "--interactive",
        "--cloud-only",
        "/Users/example/.local/bin/qwen-implementation-queue",
    ):
        assert term in operations


def test_repository_agent_profiles_never_select_ultra() -> None:
    paths = sorted(AGENT_ROOT.glob("*.toml"))
    assert paths
    expected = {
        "paperpilot_evaluator": ("gpt-5.6-terra", "medium"),
        "paperpilot_system_investigator": ("gpt-5.6-terra", "medium"),
        "paperpilot_retrieval_researcher": ("gpt-5.6-sol", "high"),
        "paperpilot_security_reviewer": ("gpt-5.6-sol", "high"),
    }
    for path in paths:
        profile = _toml(path)
        assert (profile.get("model"), profile.get("model_reasoning_effort")) == expected[
            path.stem
        ]

    config = _toml(ROOT / ".codex" / "config.toml")
    agents = config.get("agents")
    assert isinstance(agents, dict)
    assert agents.get("default_subagent_reasoning_effort") == "medium"
    assert agents.get("default_subagent_model") == "gpt-5.6-terra"


def test_support_roles_and_fixed_cloud_implementation_are_enabled() -> None:
    config = _toml(ROOT / ".codex" / "config.toml")
    agents = config.get("agents")
    assert isinstance(agents, dict)
    assert agents.get("enabled") is True
    assert config.get("sandbox_mode") == "danger-full-access"
    policy = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "Native support agents may investigate" in policy
    assert "Qwen task routing" in policy
    assert "exact `qwen3.8-flash`" in policy
    assert "qwen3.8-max" in policy
    assert "10–20%" in policy
    assert "no fixed" in policy and "Flash-attempt cap" in policy
    assert "do not block the whole Goal" in policy
    assert "MAX must not reimplement" in policy
    assert "parent Codex makes final acceptance" in policy
    assert "Do not routinely use xhigh, max or ultra" in policy
    assert "do not preload all documentation" in policy
    assert "stop when the criteria are met" in policy
    assert "120 seconds when unknown" in policy
    assert "### Historical Single-agent mode" not in policy
    for relative in (
        "PAPERPILOT_PROFILE.md",
        "CLAUDE.md",
        "docs/QWEN_IMPLEMENTER.md",
        "docs/design/13-agent-workboard.md",
    ):
        operations = (ROOT / relative).read_text(encoding="utf-8")
        assert "Single-agent mode" in operations
