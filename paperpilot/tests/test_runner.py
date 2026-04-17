"""PipelineRunner end-to-end test with all sources/signals mocked."""

from __future__ import annotations

import asyncio
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from paperpilot.models import Paper
from paperpilot.pipeline.runner import PipelineRunner


def _fake_arxiv_papers() -> list[Paper]:
    today = date.today()
    return [
        Paper(
            title=f"Paper about retrieval augmented generation {i}",
            authors=["Author"],
            abstract="LLM abstract",
            url=f"http://arxiv.org/abs/2604.000{i}",
            published_date=today - timedelta(days=i),
            source="arxiv",
            arxiv_id=f"2604.000{i}",
            categories=["cs.CL"],
            comment="Accepted at ICLR 2026" if i == 1 else None,
        )
        for i in range(1, 4)
    ]


def _build_config(tmp_path: Path) -> dict[str, Any]:
    return {
        "search": {
            "keywords": ["retrieval augmented generation"],
            "categories": ["cs.CL"],
            "days_back": 7,
            "max_results_per_keyword": 10,
            "exclude_words": [],
        },
        "sources": {"arxiv": {"enabled": True, "delay_seconds": 0}},
        "signals": {"venue": {"enabled": True}},
        "weights": {"venue": 3.0, "keyword": 0.5},
        "pipeline": {"stage2_top_n": 5},
        "output": {
            "csv": {"enabled": True, "dir": str(tmp_path), "encoding": "utf-8"},
            "json": {"enabled": True, "dir": str(tmp_path)},
        },
        "incremental": {
            "enabled": True,
            "seen_ids_file": str(tmp_path / "seen_ids.json"),
            "max_age_days": 14,
        },
        "env": {"github_token": None, "s2_api_key": None, "slack_webhook_url": None},
    }


def test_runner_end_to_end_with_mocked_arxiv(tmp_path: Path):
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)

    # Replace ArxivSource.afetch to return fixed papers without hitting the network.
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.output_count == 3
    # ICLR paper should rank #1 (venue tier 1)
    assert result.stage_counts["stage0_collected"] == 3
    assert result.stage_counts["stage1_filtered"] == 3
    assert result.stage_counts["stage2_scored"] == 3
    assert result.sources_status["arxiv"]["ok"] is True
    assert result.errors == []

    # Files written
    csv_files = list(tmp_path.glob("papers_*.csv"))
    json_files = list(tmp_path.glob("papers_*.json"))
    assert csv_files and json_files
    assert (tmp_path / "seen_ids.json").exists()
    assert (tmp_path / "run_history.jsonl").exists()


def test_runner_incremental_second_run_filters_seen(tmp_path: Path):
    import json

    config = _build_config(tmp_path)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    runner1 = PipelineRunner(config)
    with patch.object(runner1.sources[0], "afetch", side_effect=_fake_afetch):
        first = asyncio.run(runner1.run())

    # Verify seen_ids.json actually grew with the expected IDs from run 1.
    seen_path = tmp_path / "seen_ids.json"
    assert seen_path.exists()
    with seen_path.open() as f:
        seen = json.load(f)
    assert len(seen) == 3
    assert set(seen.keys()) == {f"arxiv:2604.000{i}" for i in (1, 2, 3)}
    # Timestamps are ISO-8601 strings
    from datetime import datetime
    for ts in seen.values():
        datetime.fromisoformat(ts)  # raises if malformed

    runner2 = PipelineRunner(config)
    with patch.object(runner2.sources[0], "afetch", side_effect=_fake_afetch):
        second = asyncio.run(runner2.run())

    assert first.output_count == 3
    # All IDs are already seen on the second run.
    assert second.output_count == 0


def test_runner_handles_source_failure(tmp_path: Path):
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)

    async def _boom(*args, **kwargs):
        raise RuntimeError("network down")

    with patch.object(runner.sources[0], "afetch", side_effect=_boom):
        result = asyncio.run(runner.run())

    assert result.output_count == 0
    assert result.sources_status["arxiv"]["ok"] is False
    assert any("network down" in e for e in result.errors)


def test_build_llm_provider_ollama(tmp_path: Path):
    """runner._build_llm_provider picks the Ollama backend when configured."""
    from paperpilot.llm.ollama_provider import OllamaProvider

    config = _build_config(tmp_path)
    config["llm"] = {"enabled": True, "provider": "ollama", "model": "qwen2.5:7b"}
    runner = PipelineRunner(config)
    assert isinstance(runner.llm_provider, OllamaProvider)


def test_build_llm_provider_gemini(tmp_path: Path):
    from paperpilot.llm.gemini_provider import GeminiProvider

    config = _build_config(tmp_path)
    config["llm"] = {"enabled": True, "provider": "gemini"}
    config["env"]["gemini_api_key"] = "k"
    runner = PipelineRunner(config)
    assert isinstance(runner.llm_provider, GeminiProvider)
    assert runner.llm_provider.enabled  # api key wired through


def test_build_llm_provider_claude(tmp_path: Path):
    from paperpilot.llm.claude_provider import ClaudeProvider

    config = _build_config(tmp_path)
    config["llm"] = {"enabled": True, "provider": "claude"}
    config["env"]["claude_api_key"] = "sk-ant-k"
    runner = PipelineRunner(config)
    assert isinstance(runner.llm_provider, ClaudeProvider)
    assert runner.llm_provider.enabled


def test_build_llm_provider_unknown_returns_none(tmp_path: Path):
    config = _build_config(tmp_path)
    config["llm"] = {"enabled": True, "provider": "bogus-vendor"}
    runner = PipelineRunner(config)
    assert runner.llm_provider is None


def test_build_llm_provider_disabled_returns_none(tmp_path: Path):
    config = _build_config(tmp_path)
    config["llm"] = {"enabled": False, "provider": "ollama"}
    runner = PipelineRunner(config)
    assert runner.llm_provider is None


def test_build_signals_puts_keyword_before_github(tmp_path: Path):
    """Critical ordering: KeywordSignal must run BEFORE GitHubSignal so the
    latter can use keyword_score in its budget prioritization.
    """
    from paperpilot.signals.github_signal import GitHubSignal
    from paperpilot.signals.keyword_signal import KeywordSignal

    config = _build_config(tmp_path)
    config["signals"] = {
        "venue": {"enabled": True},
        "github": {"enabled": True},
    }
    runner = PipelineRunner(config)
    sig_classes = [type(s) for s in runner.signals]
    assert KeywordSignal in sig_classes
    assert GitHubSignal in sig_classes
    assert sig_classes.index(KeywordSignal) < sig_classes.index(GitHubSignal)


def test_build_signals_citation_before_author(tmp_path: Path):
    """CitationSignal must run before AuthorSignal (it populates first_author_id)."""
    from paperpilot.signals.author_signal import AuthorSignal
    from paperpilot.signals.citation_signal import CitationSignal

    config = _build_config(tmp_path)
    config["signals"] = {"citation": {}, "author": {}}
    runner = PipelineRunner(config)
    sig_classes = [type(s) for s in runner.signals]
    assert sig_classes.index(CitationSignal) < sig_classes.index(AuthorSignal)
