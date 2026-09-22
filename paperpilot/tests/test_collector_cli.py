"""collector.py — CLI argument parsing and config override tests."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import patch

import yaml

from paperpilot import collector


@dataclass
class _FakeResult:
    output_count: int = 0
    output_files: list[str] = field(default_factory=list)
    stage_counts: dict[str, int] = field(default_factory=dict)
    duration_seconds: float = 0.1
    sources_status: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


class _FakeRunner:
    """Captures the config it was built with, returns a canned result."""

    built_configs: list[dict[str, Any]] = []

    def __init__(self, config: dict[str, Any]) -> None:
        _FakeRunner.built_configs.append(config)
        self.config = config

    async def run(self) -> _FakeResult:
        return _FakeResult(output_count=3, output_files=["x.csv"])


def _write_config(tmp_path: Path) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(
        "search:\n"
        "  keywords: [rag]\n"
        "  days_back: 7\n"
        "incremental:\n"
        "  enabled: true\n"
        "  seen_ids_file: seen.json\n"
        "llm:\n"
        "  enabled: true\n"
        "  provider: ollama\n"
        "logging:\n"
        "  level: INFO\n",
        encoding="utf-8",
    )
    return path


def _run_main(argv: list[str]) -> dict[str, Any]:
    _FakeRunner.built_configs.clear()
    with patch.object(collector, "PipelineRunner", _FakeRunner):
        with patch.object(sys, "argv", ["collector.py", *argv]):
            rc = collector.main()
    assert rc == 0
    assert len(_FakeRunner.built_configs) == 1
    return _FakeRunner.built_configs[0]


def test_cli_days_override(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    captured = _run_main(["--config", str(config_path), "--days", "3"])
    assert captured["search"]["days_back"] == 3


def test_cli_keyword_append(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    captured = _run_main(
        ["--config", str(config_path), "--keyword", "llm", "--keyword", "moe"]
    )
    assert captured["search"]["keywords"] == ["rag", "llm", "moe"]


def test_cli_full_disables_incremental(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    captured = _run_main(["--config", str(config_path), "--full"])
    assert captured["incremental"]["enabled"] is False


def test_cli_skip_llm_disables_stage4(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    captured = _run_main(["--config", str(config_path), "--skip-llm"])
    assert captured["llm"]["enabled"] is False


def test_cli_defaults_no_overrides(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    captured = _run_main(["--config", str(config_path)])
    assert captured["search"]["days_back"] == 7
    assert captured["search"]["keywords"] == ["rag"]
    assert captured["incremental"]["enabled"] is True
    assert captured["llm"]["enabled"] is True


class _FakeProvider:
    enabled = True


class _FakeRunnerWithLLM(_FakeRunner):
    """Like _FakeRunner but exposes an enabled llm_provider, as
    _run_expand_keywords requires."""

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self.llm_provider = _FakeProvider()


def test_expand_keywords_write_excludes_env_secrets(tmp_path, monkeypatch):
    """Regression test (closes #384): --write must never persist config['env']
    (secrets injected from PAPERPILOT_* environment variables) into config.yaml."""
    monkeypatch.setenv(
        "PAPERPILOT_SLACK_WEBHOOK_URL",
        "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN",
    )
    monkeypatch.setenv("PAPERPILOT_GITHUB_TOKEN", "ghp_supersecrettoken1234567890")
    config_path = _write_config(tmp_path)

    with patch.object(collector, "PipelineRunner", _FakeRunnerWithLLM):
        with patch.object(
            collector, "expand_keywords", return_value=["rag", "retrieval augmented generation"]
        ):
            with patch.object(
                sys,
                "argv",
                ["collector.py", "--config", str(config_path), "expand-keywords", "--write"],
            ):
                rc = collector.main()

    assert rc == 0
    written_text = config_path.read_text(encoding="utf-8")
    assert "SUPERSECRETTOKEN" not in written_text
    assert "ghp_supersecrettoken" not in written_text
    assert "hooks.slack.com" not in written_text

    written_config = yaml.safe_load(written_text)
    assert "env" not in written_config
    assert written_config["search"]["keywords"] == [
        "rag",
        "retrieval augmented generation",
    ]
