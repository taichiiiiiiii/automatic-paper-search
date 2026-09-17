"""CLI contract for one-paper local slide previews."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from paperpilot.paper_slides.sol_local import (
    SOL_PILOT_PAPER_ID,
    load_sol_local_execution,
)
from paperpilot.replay import canonical_json_bytes
from paperpilot.scripts.generate_paper_slides import main
from paperpilot.tests.test_slide_service import (
    NOW,
    FixtureProvider,
    prepared_execution,
    source_tree,
)
from paperpilot.tests.test_slide_sol_local import _responses
from paperpilot.tests.test_slide_sol_provider import FakeTransport

PROJECT = Path(__file__).resolve().parents[2]


def test_cli_fixed_profile_rejects_non_pilot_before_provider_use(tmp_path: Path, capsys) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    result = main(
        [
            "--paper-id",
            paper_id,
            "--output",
            str(tmp_path / "preview"),
            "--catalog",
            str(catalog),
            "--detail-dir",
            str(details),
            "--asset-dir",
            str(assets),
        ]
    )
    assert result == 1
    assert capsys.readouterr().out.strip() == (
        "PAPER_SLIDE_REQUEST_INVALID:local_profile_request_mismatch"
    )


def test_cli_accepts_only_canonical_generation_inputs_and_emits_safe_summary(
    tmp_path: Path, capsys
) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    profile = tmp_path / "profile.json"
    profile.write_text("{}", encoding="utf-8")
    provider = FixtureProvider()

    def loader(path: Path, at):
        assert path == profile
        assert at.tzinfo is not None
        return prepared_execution(provider, at)

    output = tmp_path / "preview"
    result = main(
        [
            "--paper-id",
            paper_id,
            "--language",
            "ja",
            "--output",
            str(output),
            "--profile",
            str(profile),
            "--catalog",
            str(catalog),
            "--detail-dir",
            str(details),
            "--asset-dir",
            str(assets),
        ],
        execution_loader=loader,
        now=lambda: NOW,
    )
    summary = json.loads(capsys.readouterr().out)
    assert result == 0
    assert provider.calls == 2
    assert summary["paper_id"] == paper_id
    assert summary["coverage"] == "abstract_only"
    assert summary["review_status"] == "provisional"
    assert set(summary) == {
        "actual_input_tokens",
        "actual_output_tokens",
        "calls",
        "coverage",
        "cost_micro_units",
        "deck_sha256",
        "elapsed_wall_ms",
        "html_sha256",
        "language",
        "output_dir",
        "paper_id",
        "review_status",
    }


def test_cli_has_no_url_prompt_or_model_generation_override(tmp_path: Path) -> None:
    for flag in ("--url", "--prompt", "--model"):
        try:
            main(["--paper-id", "0" * 40, "--output", str(tmp_path / "x"), flag, "x"])
        except SystemExit as exc:
            assert exc.code == 2
        else:
            raise AssertionError(f"{flag} unexpectedly accepted")


def test_cli_default_loader_runs_only_fixed_local_sol_profile(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    transport = FakeTransport(_responses())

    def loader(path: Path, at):
        return load_sol_local_execution(
            path,
            at,
            environ={"PAPERPILOT_OPENAI_API_KEY": "test-key"},
            transport=transport,
        )

    monkeypatch.setattr("paperpilot.scripts.generate_paper_slides.load_sol_local_execution", loader)
    output = tmp_path / "sol-preview"

    result = main(["--paper-id", SOL_PILOT_PAPER_ID, "--output", str(output)], now=lambda: NOW)
    summary = json.loads(capsys.readouterr().out)

    assert result == 0
    assert transport.calls == 2
    assert summary["paper_id"] == SOL_PILOT_PAPER_ID
    assert summary["calls"] == 2
    assert summary["actual_input_tokens"] == 200
    assert summary["actual_output_tokens"] == 200
    assert summary["cost_micro_units"] == 4_800
    assert output.is_dir()


@pytest.mark.parametrize("mutation", ["title", "authors", "cvpr_collection"])
def test_cli_local_profile_rejects_falsified_pilot_catalog_before_http(
    tmp_path: Path, capsys, monkeypatch, mutation: str
) -> None:
    rows = json.loads((PROJECT / "docs" / "cvpr-2025" / "papers.json").read_bytes())
    row = next(item for item in rows if item["paper_id"] == SOL_PILOT_PAPER_ID)
    if mutation == "title":
        row["title"] = "Falsified title"
    elif mutation == "authors":
        row["authors"] = ["Falsified Author"]
    else:
        row["arxiv_url"] = row["arxiv_url"].replace("CVPR2025", "CVPR2024")
        row["pdf_url"] = row["pdf_url"].replace("CVPR2025", "CVPR2024")
    catalog = tmp_path / "papers.json"
    catalog.write_bytes(canonical_json_bytes([row]))
    transport = FakeTransport(_responses())

    def loader(path: Path, at):
        return load_sol_local_execution(
            path,
            at,
            environ={"PAPERPILOT_OPENAI_API_KEY": "test-key"},
            transport=transport,
        )

    monkeypatch.setattr("paperpilot.scripts.generate_paper_slides.load_sol_local_execution", loader)
    result = main(
        [
            "--paper-id",
            SOL_PILOT_PAPER_ID,
            "--output",
            str(tmp_path / "preview"),
            "--catalog",
            str(catalog),
        ],
        now=lambda: NOW,
    )

    assert result == 1
    assert "source_constraint_mismatch" in capsys.readouterr().out
    assert transport.calls == 0
    assert not (tmp_path / "preview").exists()
