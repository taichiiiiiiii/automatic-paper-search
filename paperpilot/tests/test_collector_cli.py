"""collector.py — CLI argument parsing and config override tests."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from paperpilot import collector


@dataclass
class _FakeResult:
    output_count: int = 0
    output_files: list[str] = None
    stage_counts: dict = None
    duration_seconds: float = 0.1
    sources_status: dict = None
    errors: list = None

    def __post_init__(self):
        if self.output_files is None:
            self.output_files = []
        if self.stage_counts is None:
            self.stage_counts = {}
        if self.sources_status is None:
            self.sources_status = {}
        if self.errors is None:
            self.errors = []


class _FakeRunner:
    """Captures the config it was built with, returns a canned result."""

    built_configs: list[dict] = []

    def __init__(self, config: dict):
        _FakeRunner.built_configs.append(config)
        self.config = config

    async def run(self):
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


def _run_main(argv: list[str]) -> _FakeRunner:
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
