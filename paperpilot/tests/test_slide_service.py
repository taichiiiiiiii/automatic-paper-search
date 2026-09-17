"""One-paper abstract-only local preview service tests."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import paperpilot.paper_slides.service as service_module
from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.generate import ProviderJsonResponse, _request_sha256
from paperpilot.paper_slides.generator_budget import (
    GenerationBudget,
    PricingSnapshot,
    ProviderIdentity,
)
from paperpilot.paper_slides.provider_execution import (
    CONFIG_VERSION,
    ApprovedProviderRegistration,
    ProviderRegistry,
    prepare_provider_execution,
    pricing_snapshot_sha256,
)
from paperpilot.paper_slides.service import (
    PaperSlidePreviewRequest,
    SlidePreviewServiceError,
    generate_paper_slide_preview,
)
from paperpilot.replay import canonical_json_bytes

NOW = datetime(2026, 9, 5, tzinfo=timezone.utc)
IDENTITY = ProviderIdentity("fixture-provider", "fixture-model", "fixture-adapter-v1")


def _summary(record_id: str) -> bytes:
    return canonical_json_bytes(
        {
            "schema_version": "chunk-summary-v1",
            "claims": [
                {
                    "claim_id": "k01",
                    "claim_kind": "method",
                    "text": "Validated fixture claim.",
                    "record_ids": [record_id],
                }
            ],
        }
    )


def _deck(record_id: str) -> bytes:
    return canonical_json_bytes(
        {
            "schema_version": "deck-content-v1",
            "slides": [
                {"kind": "title", "title": "title", "bullets": [], "speaker_notes": []},
                *[
                    {
                        "kind": kind,
                        "title": kind,
                        "bullets": [
                            {"text": f"Grounded {kind} statement.", "record_ids": [record_id]}
                        ],
                        "speaker_notes": [],
                    }
                    for kind in ("problem", "method", "evidence")
                ],
            ],
            "limitations": [],
        }
    )


class FixtureProvider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def identity(self) -> ProviderIdentity:
        return IDENTITY

    def count_tokens(self, request, *, remaining_wall_ms: int) -> int:
        assert remaining_wall_ms > 0
        return 100

    def generate_json(
        self, request, *, max_output_tokens: int, remaining_wall_ms: int
    ) -> ProviderJsonResponse:
        assert max_output_tokens > 0 and remaining_wall_ms > 0
        self.calls += 1
        record_id = (
            request.untrusted_records[0].record_id
            if request.stage == "chunk_summary"
            else request.prior_claims[0].record_ids[0]
        )
        return ProviderJsonResponse(
            identity=IDENTITY,
            request_sha256=_request_sha256(request),
            payload=_summary(record_id) if request.stage == "chunk_summary" else _deck(record_id),
            input_tokens=100,
            output_tokens=100,
            provider_request_id_sha256=hashlib.sha256(f"fixture-{self.calls}".encode()).hexdigest(),
        )


def prepared_execution(provider: FixtureProvider, at: datetime = NOW):
    pricing = PricingSnapshot(
        provider=IDENTITY.provider,
        model=IDENTITY.model,
        currency="USD",
        input_per_million_micro_units=0,
        output_per_million_micro_units=0,
        request_cost_ceiling_micro_units=1_000_000,
        effective_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        expires_at=datetime(2027, 1, 1, tzinfo=timezone.utc),
        version="fixture-pricing-v1",
    )
    budget = GenerationBudget()
    registry = ProviderRegistry(
        (
            ApprovedProviderRegistration(
                identity=IDENTITY,
                adapter_type=FixtureProvider,
                pricing=pricing,
                pricing_snapshot_sha256=pricing_snapshot_sha256(pricing),
                maximum_budget=budget,
            ),
        )
    )
    config = {
        "schema_version": CONFIG_VERSION,
        "provider": IDENTITY.provider,
        "model": IDENTITY.model,
        "adapter_version": IDENTITY.adapter_version,
        "pricing_snapshot_sha256": pricing_snapshot_sha256(pricing),
        "budget": {
            "max_calls": budget.max_calls,
            "max_input_tokens": budget.max_input_tokens,
            "max_output_tokens": budget.max_output_tokens,
            "max_output_tokens_per_call": budget.max_output_tokens_per_call,
            "max_wall_seconds": budget.max_wall_seconds,
            "max_cost_micro_units": budget.max_cost_micro_units,
        },
    }
    return prepare_provider_execution(config, registry=registry, provider=provider, at=at)


def source_tree(tmp_path: Path) -> tuple[str, Path, Path, Path]:
    source_id = "2601.01234"
    paper_id = make_paper_id("arxiv", source_id)
    catalog = tmp_path / "catalog" / "papers.json"
    catalog.parent.mkdir()
    catalog.write_bytes(
        canonical_json_bytes(
            [
                {
                    "paper_id": paper_id,
                    "source": "arxiv",
                    "source_id": source_id,
                    "title": "Grounded Fixture Paper",
                    "authors": ["Ada Example"],
                }
            ]
        )
    )
    details = tmp_path / "details"
    details.mkdir()
    abstract = "This is grounded abstract evidence for the fixture paper. " * 12
    (details / f"{paper_id[:2]}.json").write_bytes(
        canonical_json_bytes(
            {
                "schema_version": "paper-details-v1",
                "prefix": paper_id[:2],
                "papers": [[paper_id, abstract]],
            }
        )
    )
    assets = tmp_path / "source-assets"
    assets.mkdir()
    (assets / "paper-slides.css").write_bytes(b"body { color: black; }\n")
    (assets / "paper-slides.js").write_bytes(b"document.documentElement.dataset.ready = '1';\n")
    return paper_id, catalog, details, assets


def test_service_runs_real_generator_and_renderer_into_atomic_local_bundle(
    tmp_path: Path,
) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    provider = FixtureProvider()
    output = tmp_path / "preview"

    result = generate_paper_slide_preview(
        PaperSlidePreviewRequest(paper_id=paper_id, language="ja"),
        execution=prepared_execution(provider),
        catalog_paths=[catalog],
        detail_dir=details,
        asset_dir=assets,
        output_dir=output,
        at=NOW,
    )

    assert provider.calls == 2
    assert result.output_dir == output.absolute()
    assert sorted(
        path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()
    ) == [
        f"assets/paper-slides.{result.stylesheet_sha256}.css",
        f"assets/paper-slides.{result.script_sha256}.js",
        "deck.json",
        "index.html",
        "manifest.json",
    ]
    deck = json.loads((output / "deck.json").read_bytes())
    manifest = json.loads((output / "manifest.json").read_bytes())
    html = (output / "index.html").read_text(encoding="utf-8")
    assert deck["review"] == {"status": "provisional", "review_record": None}
    assert deck["coverage"]["kind"] == "abstract_only"
    assert "未レビュー" in html
    assert f"/assets/paper-slides.{result.stylesheet_sha256}.css" in html
    assert f"/assets/paper-slides.{result.script_sha256}.js" in html
    assert manifest["paper_id"] == paper_id
    assert "abstract" not in manifest
    assert "prompt" not in manifest
    assert "response" not in manifest
    assert result.calls == 2
    assert result.input_tokens == 200
    assert result.output_tokens == 200
    assert result.cost_micro_units == 0


def test_invalid_request_and_unknown_paper_fail_before_provider_call(tmp_path: Path) -> None:
    _paper_id, catalog, details, assets = source_tree(tmp_path)
    provider = FixtureProvider()
    execution = prepared_execution(provider)
    with pytest.raises(SlidePreviewServiceError, match="paper_id_invalid"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id="../paper", language="ja"),
            execution=execution,
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=tmp_path / "bad",
            at=NOW,
        )
    with pytest.raises(SlidePreviewServiceError, match="paper_not_found"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id="0" * 40, language="ja"),
            execution=execution,
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=tmp_path / "unknown",
            at=NOW,
        )
    assert provider.calls == 0


def test_non_string_language_is_a_stable_request_failure(tmp_path: Path) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    provider = FixtureProvider()
    with pytest.raises(SlidePreviewServiceError, match="language_invalid"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id=paper_id, language=["ja"]),  # type: ignore[arg-type]
            execution=prepared_execution(provider),
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=tmp_path / "bad-language",
            at=NOW,
        )
    assert provider.calls == 0


def test_output_must_be_new_and_cannot_cross_symlink(tmp_path: Path) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    existing = tmp_path / "existing"
    existing.mkdir()
    provider = FixtureProvider()
    with pytest.raises(SlidePreviewServiceError, match="output_exists"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id, "ja"),
            execution=prepared_execution(provider),
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=existing,
            at=NOW,
        )
    assert provider.calls == 0

    provider = FixtureProvider()
    with pytest.raises(SlidePreviewServiceError, match="output_path_invalid"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id, "ja"),
            execution=prepared_execution(provider),
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=tmp_path / "nested" / ".." / "preview",
            at=NOW,
        )
    assert provider.calls == 0

    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    provider = FixtureProvider()
    with pytest.raises(SlidePreviewServiceError, match="output_path_invalid"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id, "ja"),
            execution=prepared_execution(provider),
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=linked / "preview",
            at=NOW,
        )
    assert provider.calls == 0


def test_source_inputs_reject_symlinks_and_abstract_hash_is_rechecked(tmp_path: Path) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    linked = tmp_path / "catalog-link.json"
    linked.symlink_to(catalog)
    provider = FixtureProvider()
    with pytest.raises(SlidePreviewServiceError, match="catalog_invalid"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id, "ja"),
            execution=prepared_execution(provider),
            catalog_paths=[linked],
            detail_dir=details,
            asset_dir=assets,
            output_dir=tmp_path / "preview",
            at=NOW,
        )
    assert provider.calls == 0


def test_atomic_commit_does_not_replace_concurrently_created_directory(
    tmp_path: Path, monkeypatch
) -> None:
    paper_id, catalog, details, assets = source_tree(tmp_path)
    provider = FixtureProvider()
    output = tmp_path / "preview"
    real_commit = service_module._atomic_rename_noreplace
    competitor_inode: list[int] = []

    def create_competitor_then_commit(source: Path, destination: Path) -> None:
        destination.mkdir()
        competitor_inode.append(destination.stat().st_ino)
        real_commit(source, destination)

    monkeypatch.setattr(service_module, "_atomic_rename_noreplace", create_competitor_then_commit)

    with pytest.raises(SlidePreviewServiceError, match="output_exists"):
        generate_paper_slide_preview(
            PaperSlidePreviewRequest(paper_id, "ja"),
            execution=prepared_execution(provider),
            catalog_paths=[catalog],
            detail_dir=details,
            asset_dir=assets,
            output_dir=output,
            at=NOW,
        )

    assert provider.calls == 2
    assert output.stat().st_ino == competitor_inode[0]
    assert not list(output.iterdir())
    assert not list(tmp_path.glob(".preview.tmp-*"))
