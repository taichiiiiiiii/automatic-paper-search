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
    # What PipelineRunner records for the sources that cut a keyword short; the run
    # summary prints it from here, so it can never disagree with run_history.
    truncated_windows: dict[str, list[str]] = field(default_factory=dict)


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


# ---- --fail-on-errors: a degraded CI run must not read as success ----


def _run_with_result(argv: list[str], result: _FakeResult) -> int:
    """Run main() against a runner that returns `result`, and report its exit code."""

    class _Runner:
        def __init__(self, config: dict[str, Any]) -> None:
            self.config = config

        async def run(self) -> _FakeResult:
            return result

    with patch.object(collector, "PipelineRunner", _Runner):
        with patch.object(sys, "argv", ["collector.py", *argv]):
            return collector.main()


def _degraded() -> _FakeResult:
    """What Stage 0 leaves behind when every enabled source failed."""
    return _FakeResult(
        output_count=0,
        sources_status={"s2": {"ok": False, "count": 0, "error": "429"}},
        errors=["source:s2:429"],
    )


def test_fail_on_errors_is_off_by_default(tmp_path, monkeypatch):
    """Default behaviour is unchanged: the pipeline is fail-safe on purpose, so an
    interactive run still exits 0 and delivers what it found."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    assert _run_with_result(["--config", str(config_path)], _degraded()) == 0


def test_fail_on_errors_exits_non_zero_when_a_source_failed(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    rc = _run_with_result(["--config", str(config_path), "--fail-on-errors"], _degraded())
    assert rc != 0


def test_fail_on_errors_exits_non_zero_when_every_source_failed(tmp_path, monkeypatch):
    """The all-sources-failed condition is checked on its own, not only through the
    errors list — a run that collected nothing from any source is the case an
    operator must never get from an exit code of 0."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=0,
        sources_status={
            "arxiv": {"ok": False, "count": 0, "error": "timeout"},
            "s2": {"ok": False, "count": 0, "error": "429"},
        },
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) != 0


def test_fail_on_errors_exits_non_zero_when_an_exporter_failed(tmp_path, monkeypatch):
    """Sources all fine but a delivery channel broke: the papers exist and nobody
    got them, which is exactly what --fail-on-errors is for."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=3,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 3, "error": None}},
        errors=["export:slack:webhook 500"],
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) != 0


def test_fail_on_errors_leaves_a_clean_run_green(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=3,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 3, "error": None}},
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) == 0


def test_fail_on_errors_ignores_stage_quality_errors(tmp_path, monkeypatch):
    """Stage 3 / Stage 4 failures degrade ranking, not delivery — the run still
    exported what it had, so it stays green."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=3,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 3, "error": None}},
        errors=["stage4:llm timeout"],
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) == 0


def test_fail_on_errors_ignores_degraded_signals(tmp_path, monkeypatch):
    """L-2: a `signal:` error is Stage 2 degradation, not a delivery failure — the
    run still exported what it had, so --fail-on-errors must leave it green. The
    loss is recorded in run_history's degraded_signals instead."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=3,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 3, "error": None}},
        errors=["signal:author: batch returned 1 of 1 entries without a usable authorId"],
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) == 0


def test_fail_on_errors_exits_non_zero_when_no_source_ran(tmp_path, monkeypatch):
    """L-8: an empty sources_status means Stage 0 had no enabled source to ask at all —
    every source disabled, or a config naming none. The run then collected nothing for
    a reason that has nothing to do with the day being quiet, and a CI exit code of 0
    would read as a successful survey."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(output_count=0)
    assert result.sources_status == {}
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) != 0


def test_fail_on_errors_exits_non_zero_for_an_incomplete_keyword(tmp_path, monkeypatch):
    """HIGH-1 end-to-end: a keyword whose feed was malformed shipped no papers, so the
    run is not complete even though the source answered with its other keywords and
    reports ok=True. The `source:` entry the runner appends for it is what makes CI
    refuse the run, so that prefix is the contract tested here."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=12,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 12, "error": None}},
        errors=[
            "source:arxiv: incomplete keyword 'large language model' "
            "(1 malformed feed page(s), first: Malformed feed)"
        ],
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) != 0


def test_fail_on_errors_exits_non_zero_for_a_quarantined_state_file(
    tmp_path, monkeypatch
):
    """M-1 end-to-end: the run's own state file is a delivery problem. A seen-ids
    file that had to be quarantined means every paper it listed looks unseen, so the
    run re-delivered its backlog and an exit code of 0 would read that as a normal
    day. The `state:` prefix the runner writes is the contract tested here."""
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=12,
        output_files=["x.csv"],
        sources_status={"arxiv": {"ok": True, "count": 12, "error": None}},
        errors=[
            "state:seen_ids: unreadable file quarantined to "
            "/data/seen_ids.json.corrupt-20261003T010203; backlog may be re-delivered"
        ],
    )
    assert _run_with_result(["--config", str(config_path), "--fail-on-errors"], result) != 0


def test_truncated_fetch_windows_are_reported_in_the_run_summary(
    tmp_path, monkeypatch, capsys
):
    """The runner records the windows its sources filled; the CLI says it where the
    operator reads the paper count, and it stays a warning, not a failed run. The
    print reads the result rather than the source plugins, so the summary and
    run_history can never name different keywords.

    Asserted on stdout because main() installs its own console handler, which is the
    report the collect-* workflows actually show.
    """
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    config_path = _write_config(tmp_path)
    result = _FakeResult(
        output_count=30,
        sources_status={"arxiv": {"ok": True, "count": 30, "error": None}},
        truncated_windows={
            "arxiv": ["large language model", "moe"],
            "s2": ["rag"],
        },
    )

    rc = _run_with_result(["--config", str(config_path), "--fail-on-errors"], result)

    out = capsys.readouterr().out
    assert rc == 0
    assert "truncated fetch windows" in out
    assert "arxiv:large language model" in out
    assert "arxiv:moe" in out
    assert "s2:rag" in out
