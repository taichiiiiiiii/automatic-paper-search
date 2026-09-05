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
SOL_IMPLEMENTERS = (
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


def test_implementers_are_fixed_to_sol_medium() -> None:
    for path in SOL_IMPLEMENTERS:
        profile = _toml(path)
        assert "model_provider" not in profile
        assert profile["model"] == "gpt-5.6-sol"
        assert profile["model_reasoning_effort"] == "medium"
        assert profile["sandbox_mode"] == "danger-full-access"
        instructions = profile["developer_instructions"]
        assert isinstance(instructions, str)
        assert "Qwen" not in instructions


def test_repository_agent_profiles_never_select_ultra() -> None:
    paths = sorted(AGENT_ROOT.glob("*.toml"))
    assert paths
    for path in paths:
        profile = _toml(path)
        assert profile.get("model_reasoning_effort") in {"medium", "high"}

    config = _toml(ROOT / ".codex" / "config.toml")
    agents = config.get("agents")
    assert isinstance(agents, dict)
    assert agents.get("default_subagent_reasoning_effort") == "medium"


def test_agents_policy_routes_bounded_implementation_to_named_sol_roles() -> None:
    policy = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    for role in ("paperpilot_backend_implementer", "paperpilot_frontend_implementer"):
        assert role in policy
    assert "GPT-5.6 Sol / medium" in policy
    assert "do not use ultra" in policy
