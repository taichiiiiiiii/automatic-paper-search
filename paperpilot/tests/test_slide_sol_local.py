"""Fixed-profile and real-adapter local Sol execution tests."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_PROVIDER_FAILED,
)
from paperpilot.paper_slides.generator_budget import SlideGenerationBudgetError
from paperpilot.paper_slides.provider_execution import ProviderExecutionError
from paperpilot.paper_slides.service import (
    PaperSlidePreviewRequest,
    SlidePreviewServiceError,
    generate_paper_slide_preview,
)
from paperpilot.paper_slides.sol_local import (
    SOL_LOCAL_PROFILE_PATH,
    SOL_LOCAL_SOURCE_CONSTRAINT,
    SOL_PILOT_PAPER_ID,
    load_sol_local_execution,
    sol_local_profile,
)
from paperpilot.replay import canonical_json_bytes
from paperpilot.tests.test_slide_sol_provider import FakeTransport, _response

PROJECT = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 5, tzinfo=timezone.utc)


def _responses() -> list[object]:
    summary = canonical_json_bytes(
        {
            "schema_version": "chunk-summary-v1",
            "claims": [
                {
                    "claim_id": "k01",
                    "claim_kind": "method",
                    "text": "Validated local method claim.",
                    "record_ids": ["abstract"],
                }
            ],
        }
    )
    deck = canonical_json_bytes(
        {
            "schema_version": "deck-content-v1",
            "slides": [
                {"kind": "title", "title": "title", "bullets": [], "speaker_notes": []},
                *[
                    {
                        "kind": kind,
                        "title": kind,
                        "bullets": [
                            {
                                "text": f"Grounded {kind} statement.",
                                "record_ids": ["abstract"],
                            }
                        ],
                        "speaker_notes": [],
                    }
                    for kind in ("problem", "method", "evidence")
                ],
            ],
            "limitations": [],
        }
    )
    return [
        _response_with_text(summary, response_id="resp_summary"),
        _response_with_text(deck, response_id="resp_deck"),
    ]


def _response_with_text(payload: bytes, *, response_id: str):
    body = {
        "id": response_id,
        "status": "completed",
        "incomplete_details": None,
        "error": None,
        "model": "gpt-5.6-sol",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": payload.decode("utf-8")}],
            }
        ],
        "usage": {
            "input_tokens": 100,
            "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 0},
            "output_tokens": 100,
            "total_tokens": 200,
            "output_tokens_details": {"reasoning_tokens": 40},
        },
    }
    return _response(canonical_json_bytes(body))


def test_profile_key_and_price_failures_never_call_transport(tmp_path: Path) -> None:
    transport = FakeTransport([])
    with pytest.raises(ProviderExecutionError, match="provider_credentials_missing"):
        load_sol_local_execution(SOL_LOCAL_PROFILE_PATH, NOW, environ={}, transport=transport)

    changed = sol_local_profile()
    changed["paper_id"] = "0" * 40
    profile = tmp_path / "changed.json"
    profile.write_bytes(canonical_json_bytes(changed))
    with pytest.raises(ProviderExecutionError, match="provider_profile_invalid"):
        load_sol_local_execution(
            profile, NOW, environ={"PAPERPILOT_OPENAI_API_KEY": "test-key"}, transport=transport
        )

    with pytest.raises(ProviderExecutionError, match="pricing_expired"):
        load_sol_local_execution(
            SOL_LOCAL_PROFILE_PATH,
            datetime(2026, 9, 12, tzinfo=timezone.utc),
            environ={"PAPERPILOT_OPENAI_API_KEY": "test-key"},
            transport=transport,
        )
    assert transport.calls == 0


def test_fake_http_runs_real_sol_adapter_generator_and_renderer(tmp_path: Path) -> None:
    transport = FakeTransport(_responses())
    execution = load_sol_local_execution(
        SOL_LOCAL_PROFILE_PATH,
        NOW,
        environ={"PAPERPILOT_OPENAI_API_KEY": "test-key"},
        transport=transport,
    )
    output = tmp_path / "preview"

    result = generate_paper_slide_preview(
        PaperSlidePreviewRequest(SOL_PILOT_PAPER_ID, "ja"),
        execution=execution,
        catalog_paths=[PROJECT / "docs" / "cvpr-2025" / "papers.json"],
        detail_dir=PROJECT / "docs" / "paper-details-v1",
        asset_dir=PROJECT / "docs" / "assets",
        output_dir=output,
        at=NOW,
        source_constraint=SOL_LOCAL_SOURCE_CONSTRAINT,
    )

    assert transport.calls == 2
    assert result.calls == 2
    assert result.input_tokens == 200
    assert result.output_tokens == 200
    assert result.cost_micro_units == 4_800
    assert (output / "index.html").is_file()
    assert json.loads((output / "manifest.json").read_bytes())["review_status"] == "provisional"
    composition_wire = json.loads(transport.bodies[1])
    schema = composition_wire["text"]["format"]["schema"]
    assert schema["properties"]["limitations"]["maxItems"] == 0
    variants = schema["properties"]["slides"]["items"]["anyOf"]
    title = next(item for item in variants if item["properties"]["kind"]["const"] == "title")
    assert title["properties"]["bullets"]["maxItems"] == 0
    assert title["properties"]["speaker_notes"]["maxItems"] == 0
    assert all(
        item["properties"]["bullets"].get("minItems") == 1 for item in variants if item is not title
    )


def test_pinned_source_mismatch_leaves_no_bundle_and_no_http_call(tmp_path: Path) -> None:
    detail_dir = tmp_path / "details"
    detail_dir.mkdir()
    original = (PROJECT / "docs" / "paper-details-v1" / "2e.json").read_bytes()
    (detail_dir / "2e.json").write_bytes(original + b" ")
    transport = FakeTransport(_responses())
    execution = load_sol_local_execution(
        SOL_LOCAL_PROFILE_PATH,
        NOW,
        environ={"OPENAI_API_KEY": "test-key"},
        transport=transport,
    )
    output = tmp_path / "preview"

    with pytest.raises(SlidePreviewServiceError, match="source_constraint_mismatch"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(SOL_PILOT_PAPER_ID, "ja"),
            execution=execution,
            catalog_paths=[PROJECT / "docs" / "cvpr-2025" / "papers.json"],
            detail_dir=detail_dir,
            asset_dir=PROJECT / "docs" / "assets",
            output_dir=output,
            at=NOW,
            source_constraint=SOL_LOCAL_SOURCE_CONSTRAINT,
        )
    assert transport.calls == 0
    assert not output.exists()


@pytest.mark.parametrize(
    ("first_payload", "input_tokens", "cache_write_tokens"),
    [(b"{", 100, 0), (_responses()[0].body, 120_001, 0), (_responses()[0].body, 100, 1)],
)
def test_invalid_output_or_actual_usage_excess_stops_after_one_call_without_bundle(
    tmp_path: Path, first_payload: bytes, input_tokens: int, cache_write_tokens: int
) -> None:
    if input_tokens > 100 or cache_write_tokens:
        value = json.loads(first_payload)
        value["usage"]["input_tokens"] = input_tokens
        value["usage"]["input_tokens_details"]["cache_write_tokens"] = cache_write_tokens
        value["usage"]["total_tokens"] = input_tokens + value["usage"]["output_tokens"]
        response = _response(canonical_json_bytes(value))
    else:
        response = _response_with_text(first_payload, response_id="resp_invalid")
    transport = FakeTransport([response, *_responses()[1:]])
    execution = load_sol_local_execution(
        SOL_LOCAL_PROFILE_PATH,
        NOW,
        environ={"OPENAI_API_KEY": "test-key"},
        transport=transport,
    )
    output = tmp_path / "preview"

    with pytest.raises(SlidePreviewServiceError) as captured:
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(SOL_PILOT_PAPER_ID, "ja"),
            execution=execution,
            catalog_paths=[PROJECT / "docs" / "cvpr-2025" / "papers.json"],
            detail_dir=PROJECT / "docs" / "paper-details-v1",
            asset_dir=PROJECT / "docs" / "assets",
            output_dir=output,
            at=NOW,
            source_constraint=SOL_LOCAL_SOURCE_CONSTRAINT,
        )
    assert captured.value.error_code in {PAPER_SLIDE_PROVIDER_FAILED, PAPER_SLIDE_OUTPUT_INVALID}
    assert transport.calls == 1
    assert not output.exists()
    if input_tokens > 100:
        ledger = execution.new_usage_ledger()
        with pytest.raises(SlideGenerationBudgetError, match="reservation_pending"):
            ledger.reserve_call(
                input_tokens=1,
                requested_output_tokens=1,
                elapsed_wall_ms=ledger.usage.elapsed_wall_ms,
            )
