"""PipelineRunner end-to-end test with all sources/signals mocked."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
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


def test_runner_records_exporter_failure_in_errors(tmp_path: Path):
    """Regression test (closes #386): a real exporter failure (Slack webhook
    returning non-2xx, injected below) must land in result.errors /
    run_history, not be silently swallowed. CSV/JSON stay enabled and must
    still succeed alongside it, proving the pipeline continues past the
    failing exporter rather than aborting."""
    from types import SimpleNamespace
    from unittest.mock import patch as mock_patch

    config = _build_config(tmp_path)
    config["output"]["slack"] = {"enabled": True, "max_items": 10}
    config["env"]["slack_webhook_url"] = "https://hooks.slack.com/services/T/B/X"
    runner = PipelineRunner(config)

    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    bad_resp = SimpleNamespace(status_code=500, json=lambda: {})
    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        with mock_patch(
            "paperpilot.exporters.slack_exporter.request_with_retry",
            return_value=bad_resp,
        ):
            result = asyncio.run(runner.run())

    assert any("export:slack" in e for e in result.errors)
    # The pipeline must still complete and other exporters must still run.
    assert result.output_count == 3
    csv_files = list(tmp_path.glob("papers_*.csv"))
    assert csv_files


def _last_history_record(tmp_path: Path) -> dict[str, Any]:
    """The run_history line the run just appended — what an operator actually
    reads, not only the in-memory result."""
    lines = (tmp_path / "run_history.jsonl").read_text(encoding="utf-8").splitlines()
    assert lines
    return json.loads(lines[-1])


def test_runner_reports_degraded_signal_in_errors_and_history(tmp_path: Path):
    """H-2: every citation batch failed, so all papers kept citation_score 0.0.

    That must be stated in the run's own record — a ranking built on missing
    evidence is not the same evidence as a ranking of quiet papers, and before
    the failure channel the two were indistinguishable in run_history.jsonl.
    """
    config = _build_config(tmp_path)
    config["signals"] = {"venue": {"enabled": True}, "citation": {"enabled": True}}
    config["weights"]["citation"] = 1.0
    runner = PipelineRunner(config)

    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        with patch(
            "paperpilot.signals.citation_signal.request_with_retry",
            return_value=None,
        ):
            result = asyncio.run(runner.run())

    # Fail-Safe: the run still completed and exported its papers.
    assert result.output_count == 3
    assert len(result.errors) == 1
    assert result.errors[0].startswith("signal:citation:")
    assert "n=3" in result.errors[0]
    assert result.degraded_signals == ["citation"]

    record = _last_history_record(tmp_path)
    assert record["degraded_signals"] == ["citation"]
    assert record["errors"] == result.errors
    # The additions never replace the fields rule §9 requires.
    assert {"finished_at", "sources_status", "errors"} <= set(record)


def test_runner_keeps_a_healthy_run_free_of_signal_degradation(tmp_path: Path):
    """The channel is per run and per enabled signal: a run whose lookups
    answered must not report a previous run's outage."""
    config = _build_config(tmp_path)
    config["signals"] = {"venue": {"enabled": True}, "citation": {"enabled": True}}
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    payload = [
        {
            "paperId": f"p{i}",
            "citationCount": 0,
            "influentialCitationCount": 0,
            "publicationDate": date.today().isoformat(),
            "authors": [],
            "venue": None,
        }
        for i in range(3)
    ]
    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        with patch(
            "paperpilot.signals.citation_signal.request_with_retry",
            side_effect=[SimpleNamespace(status_code=200, json=lambda: payload)],
        ):
            result = asyncio.run(runner.run())

    assert result.errors == []
    assert result.degraded_signals == []
    assert _last_history_record(tmp_path)["degraded_signals"] == []


def test_runner_warns_and_records_a_truncated_delivery(tmp_path: Path, caplog):
    """M-6: Slack posts only papers[:max_items] while seen_ids is stamped from
    the whole export list, so the papers behind the cut are marked seen without
    ever being shown.

    The delivery and stamping policy is deliberately unchanged (product
    decision) — what changed is that the run says so once, in a WARNING and in
    run_history.truncated_deliveries, using the count the exporter reports
    rather than a second copy of the slicing.
    """
    config = _build_config(tmp_path)
    config["output"]["slack"] = {"enabled": True, "max_items": 1}
    config["env"]["slack_webhook_url"] = "https://hooks.slack.com/services/T/B/X"
    runner = PipelineRunner(config)

    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    ok = SimpleNamespace(status_code=200, json=lambda: {})
    with caplog.at_level(logging.WARNING, logger="paperpilot.pipeline.runner"):
        with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
            with patch(
                "paperpilot.exporters.slack_exporter.request_with_retry",
                return_value=ok,
            ):
                result = asyncio.run(runner.run())

    assert result.truncated_deliveries == [
        {"exporter": "slack", "delivered": 1, "given": 3}
    ]
    warnings = [
        r.getMessage()
        for r in caplog.records
        if r.name == "paperpilot.pipeline.runner" and r.levelno == logging.WARNING
    ]
    assert len(warnings) == 1
    assert "exporter 'slack' delivered 1 of 3" in warnings[0]
    assert _last_history_record(tmp_path)["truncated_deliveries"] == [
        {"exporter": "slack", "delivered": 1, "given": 3}
    ]
    # A truncated delivery is not an error, and the stamping policy is intact:
    # all three papers are still marked seen.
    assert result.errors == []
    with (tmp_path / "seen_ids.json").open(encoding="utf-8") as f:
        assert len(json.load(f)) == 3


def test_runner_does_not_report_a_full_notification_as_truncated(tmp_path: Path):
    """max_items at or above the paper count is not a cut — and CSV/JSON, which
    write every paper, must never appear in the tally."""
    config = _build_config(tmp_path)
    config["output"]["slack"] = {"enabled": True, "max_items": 10}
    config["env"]["slack_webhook_url"] = "https://hooks.slack.com/services/T/B/X"
    runner = PipelineRunner(config)

    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    ok = SimpleNamespace(status_code=200, json=lambda: {})
    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        with patch(
            "paperpilot.exporters.slack_exporter.request_with_retry", return_value=ok
        ):
            result = asyncio.run(runner.run())

    assert result.truncated_deliveries == []
    assert result.errors == []
    assert _last_history_record(tmp_path)["truncated_deliveries"] == []
    # The other truncation channel is per fetch too: a source whose window still had
    # room reports no keyword, so the record cannot inherit a previous run's cut.
    assert result.truncated_windows == {}
    assert _last_history_record(tmp_path)["truncated_windows"] == {}


def test_runner_skips_seen_ids_when_all_exporters_fail(tmp_path: Path):
    """Regression test (closes #400): if every enabled exporter raises, the
    user never actually received these papers. Marking them seen anyway
    would make stage_rule_filter's ¬seen_ids filter drop them forever on
    every later run — a silent, permanent loss indistinguishable from
    "already delivered"."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    for exp in runner.exporters:
        exp.export = lambda _papers, _name=exp.name: (_ for _ in ()).throw(
            RuntimeError(f"{_name} boom")
        )

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.output_count == 3
    assert any("boom" in e for e in result.errors)
    seen_path = tmp_path / "seen_ids.json"
    if seen_path.exists():
        import json

        with seen_path.open() as f:
            seen = json.load(f)
        assert seen == {}
    # A second run with a working exporter must still see these papers
    # (they were never actually marked seen).
    config2 = _build_config(tmp_path)
    runner2 = PipelineRunner(config2)
    with patch.object(runner2.sources[0], "afetch", side_effect=_fake_afetch):
        second = asyncio.run(runner2.run())
    assert second.output_count == 3


def test_runner_marks_seen_when_at_least_one_exporter_succeeds(tmp_path: Path):
    """A partial exporter failure (at least one delivery channel worked)
    must NOT block seen_ids from being marked — the papers were genuinely
    delivered through the surviving exporter, so re-sending them next run
    would be a duplicate notification, not a recovery."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    failing_exp = runner.exporters[0]
    failing_exp.export = lambda _papers: (_ for _ in ()).throw(RuntimeError("boom"))

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.output_count == 3
    seen_path = tmp_path / "seen_ids.json"
    assert seen_path.exists()
    import json

    with seen_path.open() as f:
        seen = json.load(f)
    assert len(seen) == 3


def test_runner_skips_seen_ids_when_failures_and_no_delivery(tmp_path: Path):
    """A no-op exporter is not a delivery. CLAUDE.md rule 10 makes an
    enabled-but-unconfigured Slack/Email exporter return None instead of
    raising, so counting exceptions against ``len(enabled_exporters)``
    treats "one raised, one silently did nothing" as a partial success.
    Nothing reached the user, yet the papers were marked seen and then
    filtered out of every later run."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    raising_exp, noop_exp = runner.exporters[0], runner.exporters[1]
    raising_exp.export = lambda _papers: (_ for _ in ()).throw(RuntimeError("boom"))
    # Mirrors the unconfigured-webhook/SMTP no-op: enabled, never raises,
    # delivers nothing.
    noop_exp.export = lambda _papers: None

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.output_count == 3
    assert any("boom" in e for e in result.errors)
    seen_path = tmp_path / "seen_ids.json"
    if seen_path.exists():
        import json

        with seen_path.open() as f:
            assert json.load(f) == {}


def test_runner_marks_seen_when_every_exporter_no_ops(tmp_path: Path):
    """Zero deliveries but zero failures is the "nothing is configured"
    setup, not an outage. Prior behaviour marks these seen and must be
    preserved, otherwise a user with no exporters configured would
    re-process the same papers forever."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    for exp in runner.exporters:
        exp.export = lambda _papers: None

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.output_count == 3
    assert not result.errors
    import json

    with (tmp_path / "seen_ids.json").open() as f:
        assert len(json.load(f)) == 3


def test_runner_reports_an_incomplete_keyword_as_a_source_error(tmp_path: Path):
    """HIGH-1: one keyword's arXiv feed was malformed, so its papers were withdrawn and
    the source answered with the rest. Stage 0 has no channel for a result that is
    complete-but-partial — `sources_status["arxiv"]["ok"]` is honestly True — so the
    keyword loss has to reach result.errors (and run_history) on its own, because that
    is the only thing --fail-on-errors reads.

    The fake afetch below mimics what the real fetch() leaves behind: the surviving
    papers plus the degraded keyword and its reason on the source itself.
    """
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        runner.sources[0].degraded_keywords = [
            ("large language model", "1 malformed feed page(s), first: Malformed feed")
        ]
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.sources_status["arxiv"]["ok"] is True
    assert (
        "source:arxiv: incomplete keyword 'large language model' "
        "(1 malformed feed page(s), first: Malformed feed)"
    ) in result.errors
    # run_history carries it, which is what the collect-* workflows read.
    assert _last_history_record(tmp_path)["errors"] == result.errors


def test_runner_names_the_source_of_every_incomplete_keyword(tmp_path: Path):
    """HIGH-1 for S2 and OpenAlex: both throttle per keyword, so one failing keyword
    alongside a succeeding one is routine and the source answers with the survivor.
    Stage 0 then records ok=True for both, so the run is only honest if each lost
    keyword is reported under the name of the source that lost it — that `source:`
    prefix is what collector.py's --fail-on-errors refuses and run_history is what
    the collect-* workflows leave behind for the operator.

    The fake afetch callbacks mimic what the real fetch() leaves behind: the surviving
    papers plus the degraded keyword and its reason on the source itself.
    """
    config = _build_config(tmp_path)
    config["sources"]["s2"] = {"enabled": True, "delay_seconds": 0}
    config["sources"]["openalex"] = {"enabled": True, "delay_seconds": 0}
    runner = PipelineRunner(config)
    by_name = {src.name: src for src in runner.sources}
    assert set(by_name) == {"arxiv", "s2", "openalex"}
    papers = _fake_arxiv_papers()

    async def _answered(*args, **kwargs):
        return papers

    async def _s2_partial(*args, **kwargs):
        by_name["s2"].degraded_keywords = [
            ("moe", "RuntimeError: s2 search failed for 'moe' (status=429)")
        ]
        return papers

    async def _openalex_partial(*args, **kwargs):
        by_name["openalex"].degraded_keywords = [
            (
                "rag",
                "RuntimeError: openalex search for 'rag' has no 'results' list "
                "(got NoneType)",
            )
        ]
        return papers

    with patch.object(by_name["arxiv"], "afetch", side_effect=_answered):
        with patch.object(by_name["s2"], "afetch", side_effect=_s2_partial):
            with patch.object(
                by_name["openalex"], "afetch", side_effect=_openalex_partial
            ):
                result = asyncio.run(runner.run())

    assert result.sources_status["s2"]["ok"] is True
    assert result.sources_status["openalex"]["ok"] is True
    assert (
        "source:s2: incomplete keyword 'moe' "
        "(RuntimeError: s2 search failed for 'moe' (status=429))"
    ) in result.errors
    assert (
        "source:openalex: incomplete keyword 'rag' "
        "(RuntimeError: openalex search for 'rag' has no 'results' list "
        "(got NoneType))"
    ) in result.errors
    assert _last_history_record(tmp_path)["errors"] == result.errors


def test_runner_records_truncated_windows_in_the_result_and_history(
    tmp_path: Path,
):
    """M-6 for the record, not just the console: a keyword that filled its window
    shipped papers, so it is not an error and --fail-on-errors stays green — but the
    survey is thinner than the window, and until now that was only printed. The print
    is gone by the time anyone reads the run again, so the runner now hands the same
    report to PipelineResult.truncated_windows and to run_history."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        runner.sources[0].truncated_keywords = ["retrieval augmented generation"]
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.truncated_windows == {
        "arxiv": ["retrieval augmented generation"]
    }
    # A cut window is a warning, never an error: the run exported what it had.
    assert result.errors == []
    record = _last_history_record(tmp_path)
    assert record["truncated_windows"] == {
        "arxiv": ["retrieval augmented generation"]
    }
    # The additive field never displaces what rule §9 requires.
    assert {"finished_at", "sources_status", "errors"} <= set(record)


def test_runner_does_not_report_incomplete_keywords_for_a_failed_source(
    tmp_path: Path,
):
    """A source that raised already reported every keyword through its own error
    line; repeating the per-keyword list would only double-count one outage."""
    config = _build_config(tmp_path)
    runner = PipelineRunner(config)

    async def _boom(*args, **kwargs):
        # The real fetch() records its degraded keywords before raising.
        runner.sources[0].degraded_keywords = [("llm", "HTTPError: 503")]
        raise RuntimeError("arxiv fetch failed for all 1 keyword(s)")

    with patch.object(runner.sources[0], "afetch", side_effect=_boom):
        result = asyncio.run(runner.run())

    assert result.sources_status["arxiv"]["ok"] is False
    assert [e for e in result.errors if "incomplete keyword" in e] == []
    assert any(e.startswith("source:arxiv:") for e in result.errors)


def test_runner_reports_a_quarantined_seen_ids_file_as_a_state_error(
    tmp_path: Path,
):
    """M-1: the run that loses its seen-ids history is the run that re-delivers the
    backlog, and load_seen_ids still has to answer {} to keep going at all. Before
    this, the only trace was a WARNING in a log nobody reads, so the record showed a
    clean run that had just re-sent every paper it had already sent.

    The `state:` prefix is what collector.py's --fail-on-errors refuses, and
    run_history is what the collect-* workflows leave behind for the operator.
    """
    config = _build_config(tmp_path)
    seen_path = tmp_path / "seen_ids.json"
    seen_path.write_text('{"arxiv:2604.0001": "2026-01-01T00:00:00",', encoding="utf-8")
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    state_errors = [e for e in result.errors if e.startswith("state:")]
    assert len(state_errors) == 1
    assert state_errors[0].startswith(
        f"state:seen_ids: unreadable file quarantined to {seen_path}.corrupt-"
    )
    assert state_errors[0].endswith("; backlog may be re-delivered")
    # The delivery itself is unaffected — the run still exports what it found, so
    # this is a report about what it re-sent, not a stage that broke.
    assert result.output_count == 3
    assert _last_history_record(tmp_path)["errors"] == result.errors


def test_runner_stays_green_when_the_seen_ids_file_is_readable(
    tmp_path: Path,
):
    """The counterpart: a run whose history file reads fine must not start reporting
    state errors — a stale or invented one would fail CI on a complete survey."""
    config = _build_config(tmp_path)
    (tmp_path / "seen_ids.json").write_text(
        f'{{"arxiv:9999.99999": "{date.today().isoformat()}"}}', encoding="utf-8"
    )
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        result = asyncio.run(runner.run())

    assert result.errors == []


def test_runner_uses_its_own_run_history_file_when_configured(tmp_path: Path):
    """L-7: collect-daily-watch and collect-weekly both append to and push the record,
    so sharing run_history.jsonl made them collide on one file. `incremental
    .run_history_file` gives a config its own; when it is unset the old rule (next to
    seen_ids) still holds, which is what every other config relies on."""
    config = _build_config(tmp_path)
    history = tmp_path / "nested" / "run_history.daily.jsonl"
    config["incremental"]["run_history_file"] = str(history)
    runner = PipelineRunner(config)
    papers = _fake_arxiv_papers()

    async def _fake_afetch(*args, **kwargs):
        return papers

    with patch.object(runner.sources[0], "afetch", side_effect=_fake_afetch):
        asyncio.run(runner.run())

    assert history.exists()
    assert json.loads(history.read_text(encoding="utf-8").splitlines()[-1])["errors"] == []
    assert not (tmp_path / "run_history.jsonl").exists()


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


def test_build_llm_provider_groq(tmp_path: Path):
    from paperpilot.llm.groq_provider import GroqProvider

    config = _build_config(tmp_path)
    config["llm"] = {"enabled": True, "provider": "groq"}
    config["env"]["groq_api_key"] = "gsk_k"
    runner = PipelineRunner(config)
    assert isinstance(runner.llm_provider, GroqProvider)
    assert runner.llm_provider.enabled


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
