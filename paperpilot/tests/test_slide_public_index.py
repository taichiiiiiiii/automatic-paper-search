"""Reviewed-only public index projection for paper slide decks."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from typing import cast

import jsonschema
import pytest

import paperpilot.paper_slides.public_index as public_index_module
from paperpilot.paper_slides.contract import (
    REVIEW_CHECKLIST,
    LineageClaimReference,
    PdfChunkReference,
    ReviewRecordReference,
    SlideDeckValidationContext,
    derive_candidate_sha256,
    public_review_record_path,
    trusted_envelope_sha256,
)
from paperpilot.paper_slides.public_index import (
    MAX_PUBLIC_BUNDLE_BYTES,
    MAX_PUBLIC_INDEX_ENTRIES,
    MAX_PUBLIC_INDEX_SHARD_BYTES,
    MAX_PUBLIC_MANIFEST_BYTES,
    PAPER_SLIDES_PUBLIC_ROOT,
    PUBLIC_INDEX_SCHEMA_VERSION,
    PUBLIC_MANIFEST_PATH,
    PUBLIC_MANIFEST_SCHEMA_VERSION,
    PublicAssetSnapshot,
    PublicDeckProjection,
    ReviewedDeckCandidate,
    SlidePublicIndexError,
    build_public_index_shards,
    project_reviewed_deck,
    snapshot_slide_validation_context,
)
from paperpilot.paper_slides.render import AssetReferences, RenderedSlideDeck

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "paperpilot" / "tests" / "fixtures" / "paper-slides-v1" / "full-text.json"
SCHEMA = ROOT / "schemas" / "paper-slide-public-index-v1.schema.json"
MANIFEST_SCHEMA = ROOT / "schemas" / "paper-slide-public-manifest-v1.schema.json"


def _public_asset_state(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    stylesheet_version: int = 1,
    script_version: int = 1,
) -> Path:
    assets = root / "assets"
    assets.mkdir(parents=True)
    payloads = {
        "paper-slides.css": b"body { color: #123; }\n",
        "paper-slides.js": b"document.body.dataset.ready = '1';\n",
    }
    for filename, payload in payloads.items():
        (assets / filename).write_bytes(payload)
    versions = {
        filename: {
            "sha": hashlib.sha256(payload).hexdigest()[:12],
            "v": stylesheet_version if filename.endswith(".css") else script_version,
        }
        for filename, payload in payloads.items()
    }
    versions_path = assets / "versions.json"
    versions_path.write_text(json.dumps(versions), encoding="utf-8")
    monkeypatch.setattr(public_index_module, "_PUBLIC_ASSET_VERSIONS_PATH", versions_path)
    return versions_path


def _reviewed() -> tuple[dict, SlideDeckValidationContext]:
    deck = json.loads(FIXTURE.read_text(encoding="utf-8"))
    citation = deck["citations"][0]
    record = ReviewRecordReference(
        deck_id=deck["deck_id"],
        candidate_sha256=derive_candidate_sha256(deck),
        pdf_sha256=deck["source"]["pdf_sha256"],
        reviewer_id="reviewer-1",
        decision="approved",
        reviewed_at="2026-08-30T01:00:00Z",
        checklist=REVIEW_CHECKLIST,
        reason="引用と表示を確認済み",
    )
    review_path = public_review_record_path(record)
    deck["review"] = {"status": "reviewed", "review_record": review_path}
    context = SlideDeckValidationContext(
        expected_envelope_sha256=trusted_envelope_sha256(deck),
        pdf_chunks={
            citation["chunk_id"]: PdfChunkReference(
                page=citation["page"],
                sha256=citation["chunk_sha256"],
                source_anchor=citation["source_anchor"],
                pdf_sha256=deck["source"]["pdf_sha256"],
            )
        },
        review_records={review_path: record},
        review_as_of="2026-08-30T02:00:00Z",
    )
    return deck, context


def test_reviewed_deck_projects_exact_public_artifacts_and_safe_index_entry() -> None:
    deck, context = _reviewed()

    projected = project_reviewed_deck(deck, context=context)
    revision = f"{projected.entry.deck_sha256}-{projected.entry.html_sha256}"
    revision_root = f"{PAPER_SLIDES_PUBLIC_ROOT}/decks/{deck['deck_id']}/{revision}"

    assert projected.deck_bytes.endswith(b"\n")
    assert projected.html_bytes.endswith(b"\n")
    assert projected.entry.as_dict() == {
        "paper_id": deck["paper_id"],
        "language": "ja",
        "deck_id": deck["deck_id"],
        "deck_path": f"{revision_root}.html",
        "deck_json_path": f"{revision_root}.deck.json",
        "deck_sha256": hashlib.sha256(projected.deck_bytes).hexdigest(),
        "html_sha256": hashlib.sha256(projected.html_bytes).hexdigest(),
        "coverage": "full_text",
        "reviewed_at": "2026-08-30T01:00:00Z",
    }
    serialized = json.dumps(projected.entry.as_dict(), sort_keys=True)
    assert "reviewer" not in serialized
    assert "request" not in serialized
    assert "provider" not in serialized
    assert "title" not in serialized
    assert projected.files[projected.entry.deck_path] == projected.html_bytes
    assert projected.files[projected.entry.deck_json_path] == projected.deck_bytes
    review_path = deck["review"]["review_record"]
    assert review_path.encode() in projected.html_bytes
    assert review_path not in projected.files
    assert re.fullmatch(
        rf"{re.escape(PAPER_SLIDES_PUBLIC_ROOT)}/reviews/"
        rf"{re.escape(deck['deck_id'])}/[0-9a-f]{{64}}\.json",
        review_path,
    )
    assert len(projected.files) == 4
    with pytest.raises(TypeError):
        cast(dict[str, bytes], projected.files)[projected.entry.deck_path] = b"forged"


def test_public_projection_content_addresses_exact_asset_bytes_and_changes_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    versions_path = _public_asset_state(
        tmp_path,
        monkeypatch,
        stylesheet_version=7,
        script_version=11,
    )
    deck, context = _reviewed()

    first = project_reviewed_deck(deck, context=context)
    first_css_path = next(path for path in first.files if path.endswith(".css"))
    first_js_path = next(path for path in first.files if path.endswith(".js"))
    assert first_css_path.encode() in first.html_bytes
    assert first_js_path.encode() in first.html_bytes
    assert b"?v=" not in first.html_bytes
    assert first.entry.html_sha256 == hashlib.sha256(first.html_bytes).hexdigest()

    state = json.loads(versions_path.read_text(encoding="utf-8"))
    changed_css = b"body { color: #456; }\n"
    (versions_path.parent / "paper-slides.css").write_bytes(changed_css)
    state["paper-slides.css"]["sha"] = hashlib.sha256(changed_css).hexdigest()[:12]
    state["paper-slides.css"]["v"] = 8
    versions_path.write_text(json.dumps(state), encoding="utf-8")
    second = project_reviewed_deck(deck, context=context)

    second_css_path = next(path for path in second.files if path.endswith(".css"))
    assert second_css_path != first_css_path
    assert second.files[second_css_path] == changed_css
    assert first.files[first_css_path] != second.files[second_css_path]
    assert second.html_bytes != first.html_bytes
    assert second.entry.deck_path != first.entry.deck_path
    assert second.entry.deck_json_path != first.entry.deck_json_path
    assert second.entry.html_sha256 == hashlib.sha256(second.html_bytes).hexdigest()


@pytest.mark.parametrize("bad_version", [0, True, 2_147_483_648, "2"])
def test_public_asset_version_errors_fail_closed_before_render(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bad_version: object,
) -> None:
    versions_path = _public_asset_state(tmp_path, monkeypatch)
    state = json.loads(versions_path.read_text(encoding="utf-8"))
    state["paper-slides.css"]["v"] = bad_version
    versions_path.write_text(json.dumps(state), encoding="utf-8")
    deck, context = _reviewed()
    rendered = False

    def unexpected_render(*args: object, **kwargs: object) -> RenderedSlideDeck:
        nonlocal rendered
        rendered = True
        raise AssertionError("renderer must not receive unresolved assets")

    monkeypatch.setattr(public_index_module, "render_slide_deck_html", unexpected_render)
    with pytest.raises(SlidePublicIndexError) as captured:
        project_reviewed_deck(deck, context=context)

    assert captured.value.code == "public_asset_versions_invalid"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert rendered is False


def test_public_asset_content_mismatch_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    versions_path = _public_asset_state(tmp_path, monkeypatch)
    (versions_path.parent / "paper-slides.js").write_bytes(b"changed after version sync\n")
    deck, context = _reviewed()

    with pytest.raises(SlidePublicIndexError) as captured:
        project_reviewed_deck(deck, context=context)

    assert captured.value.code == "public_asset_hash_mismatch"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


def test_import_does_not_read_assets_but_projection_requires_them(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe = """
from pathlib import Path

original_open = Path.open

def reject_asset_read(path, *args, **kwargs):
    if path.name in {"versions.json", "paper-slides.css", "paper-slides.js"}:
        raise AssertionError("asset read during import")
    return original_open(path, *args, **kwargs)

Path.open = reject_asset_read
import paperpilot.paper_slides
import paperpilot.paper_slides.public_index
"""
    completed = subprocess.run(
        [sys.executable, "-c", probe],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr

    monkeypatch.setattr(
        public_index_module,
        "_PUBLIC_ASSET_VERSIONS_PATH",
        tmp_path / "absent" / "versions.json",
    )
    deck, context = _reviewed()
    with pytest.raises(SlidePublicIndexError) as captured:
        project_reviewed_deck(deck, context=context)

    assert captured.value.code == "public_asset_versions_invalid"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


def test_provisional_deck_never_enters_the_public_index() -> None:
    deck, context = _reviewed()
    deck["review"] = {"status": "provisional", "review_record": None}

    with pytest.raises(SlidePublicIndexError) as captured:
        project_reviewed_deck(deck, context=context)

    assert captured.value.code == "public_review_required"
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


def test_public_projection_rejects_a_review_record_changed_under_the_pinned_path() -> None:
    deck, context = _reviewed()
    review_path = deck["review"]["review_record"]
    record = context.review_records[review_path]
    changed_record = replace(record, reason="別のレビュー記録")
    tampered_context = replace(
        context,
        review_records={review_path: changed_record},
    )

    with pytest.raises(SlidePublicIndexError) as captured:
        project_reviewed_deck(deck, context=tampered_context)

    assert captured.value.code == "review_record_mismatch"
    assert public_review_record_path(changed_record) != review_path


def test_public_index_shards_are_canonical_sorted_and_schema_valid() -> None:
    deck, context = _reviewed()
    projected = project_reviewed_deck(deck, context=context)

    bundle = build_public_index_shards([ReviewedDeckCandidate(deck, context)])

    assert len(bundle.shards) == 256
    assert list(bundle.shards) == [f"{value:02x}" for value in range(256)]
    payload = json.loads(bundle.shards[deck["paper_id"][:2]])
    assert payload == {
        "entries": [projected.entry.as_dict()],
        "schema_version": PUBLIC_INDEX_SCHEMA_VERSION,
    }
    jsonschema.validate(payload, json.loads(SCHEMA.read_text(encoding="utf-8")))
    manifest = json.loads(bundle.manifest_bytes)
    jsonschema.validate(manifest, json.loads(MANIFEST_SCHEMA.read_text(encoding="utf-8")))
    row = manifest["shards"][int(deck["paper_id"][:2], 16)]
    assert row == {
        "entry_count": 1,
        "path": f"{PAPER_SLIDES_PUBLIC_ROOT}/index/{deck['paper_id'][:2]}.json",
        "prefix": deck["paper_id"][:2],
        "sha256": hashlib.sha256(bundle.shards[deck["paper_id"][:2]]).hexdigest(),
    }
    assert bundle.manifest_sha256 == hashlib.sha256(bundle.manifest_bytes).hexdigest()
    assert bundle.files[PUBLIC_MANIFEST_PATH] == bundle.manifest_bytes
    assert bundle.files[projected.entry.deck_path] == projected.html_bytes
    assert bundle.files[projected.entry.deck_json_path] == projected.deck_bytes
    for prefix, shard_bytes in bundle.shards.items():
        assert bundle.files[f"{PAPER_SLIDES_PUBLIC_ROOT}/index/{prefix}.json"] == shard_bytes
    assert sum(map(len, bundle.files.values())) == bundle.total_bytes
    assert bundle.total_bytes <= MAX_PUBLIC_BUNDLE_BYTES
    assert len(bundle.files) == 261
    with pytest.raises(TypeError):
        cast(dict[str, bytes], bundle.files)[PUBLIC_MANIFEST_PATH] = b"forged"


def test_empty_catalog_still_emits_all_canonical_shards_and_manifest() -> None:
    bundle = build_public_index_shards([])

    assert len(bundle.shards) == 256
    assert all(
        json.loads(payload) == {"entries": [], "schema_version": PUBLIC_INDEX_SCHEMA_VERSION}
        for payload in bundle.shards.values()
    )
    manifest = json.loads(bundle.manifest_bytes)
    assert manifest["schema_version"] == PUBLIC_MANIFEST_SCHEMA_VERSION
    assert [row["prefix"] for row in manifest["shards"]] == [f"{value:02x}" for value in range(256)]
    assert all(row["entry_count"] == 0 for row in manifest["shards"])
    for row in manifest["shards"]:
        prefix = row["prefix"]
        assert row["path"] == f"{PAPER_SLIDES_PUBLIC_ROOT}/index/{prefix}.json"
        assert row["sha256"] == hashlib.sha256(bundle.shards[prefix]).hexdigest()

    with pytest.raises(TypeError):
        cast(dict[str, bytes], bundle.shards)["00"] = b"forged"
    assert len(bundle.files) == 259
    assert bundle.files[PUBLIC_MANIFEST_PATH] == bundle.manifest_bytes


def test_duplicate_paper_language_fails_closed() -> None:
    deck, context = _reviewed()
    with pytest.raises(SlidePublicIndexError, match="duplicate_paper_language"):
        build_public_index_shards(
            [ReviewedDeckCandidate(deck, context), ReviewedDeckCandidate(deck, context)]
        )


def test_public_index_build_uses_one_verified_asset_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    versions_path = _public_asset_state(
        tmp_path,
        monkeypatch,
        stylesheet_version=17,
        script_version=19,
    )
    deck, context = _reviewed()
    real_resolver = public_index_module.resolve_public_slide_assets
    real_renderer = public_index_module.render_slide_deck_html
    resolve_calls = 0
    rendered_assets: list[AssetReferences] = []

    def counted_resolver() -> PublicAssetSnapshot:
        nonlocal resolve_calls
        resolve_calls += 1
        return real_resolver()

    def mutate_versions_after_first_render(
        candidate: object,
        *,
        context: SlideDeckValidationContext,
        mode: str,
        assets: AssetReferences,
    ) -> RenderedSlideDeck:
        rendered_assets.append(assets)
        if len(rendered_assets) == 1:
            state = json.loads(versions_path.read_text(encoding="utf-8"))
            state["paper-slides.css"]["v"] = 99
            state["paper-slides.js"]["v"] = 101
            versions_path.write_text(json.dumps(state), encoding="utf-8")
        return real_renderer(candidate, context=context, mode=mode, assets=assets)

    monkeypatch.setattr(public_index_module, "resolve_public_slide_assets", counted_resolver)
    monkeypatch.setattr(
        public_index_module,
        "render_slide_deck_html",
        mutate_versions_after_first_render,
    )
    with pytest.raises(SlidePublicIndexError, match="duplicate_paper_language"):
        build_public_index_shards(
            [ReviewedDeckCandidate(deck, context), ReviewedDeckCandidate(deck, context)]
        )

    assert resolve_calls == 1
    assert len(rendered_assets) == 2
    assert rendered_assets[0] is rendered_assets[1]
    assert rendered_assets[0].stylesheet_sha256 == rendered_assets[1].stylesheet_sha256
    assert rendered_assets[0].script_sha256 == rendered_assets[1].script_sha256


def test_projection_integrity_is_rechecked_before_indexing() -> None:
    deck, context = _reviewed()
    projected = project_reviewed_deck(deck, context=context)
    entry = replace(projected.entry, html_sha256="0" * 64)
    forged = PublicDeckProjection(
        entry=entry,
        deck_bytes=projected.deck_bytes,
        html_bytes=projected.html_bytes,
        files=projected.files,
    )

    with pytest.raises(SlidePublicIndexError, match="candidate_type"):
        build_public_index_shards([forged])


def test_forged_reviewed_deck_with_original_html_and_rehash_is_rejected() -> None:
    deck, context = _reviewed()
    projected = project_reviewed_deck(deck, context=context)
    deck["slides"][0]["title"] = "FORGED CONTENT"

    with pytest.raises(SlidePublicIndexError):
        build_public_index_shards([ReviewedDeckCandidate(deck, context)])

    # The builder has no API that accepts caller-supplied artifact bytes or hashes.
    assert projected.html_bytes


def test_context_is_detached_before_validation_and_caller_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deck, context = _reviewed()
    review_records = dict(context.review_records)
    mutable_context = replace(context, review_records=review_records)
    real_renderer = public_index_module.render_slide_deck_html

    def mutate_caller_then_render(
        candidate: object,
        *,
        context: SlideDeckValidationContext,
        mode: str,
        assets: AssetReferences,
    ) -> RenderedSlideDeck:
        review_records.clear()
        return real_renderer(candidate, context=context, mode=mode, assets=assets)

    monkeypatch.setattr(public_index_module, "render_slide_deck_html", mutate_caller_then_render)
    projected = project_reviewed_deck(deck, context=mutable_context)

    assert review_records == {}
    assert projected.entry.reviewed_at == "2026-08-30T01:00:00Z"


def test_public_context_snapshot_deep_copies_every_reference_value() -> None:
    deck, reviewed_context = _reviewed()
    review_path = deck["review"]["review_record"]
    pdf = next(iter(reviewed_context.pdf_chunks.values()))
    review = reviewed_context.review_records[review_path]
    lineage = LineageClaimReference(
        artifact_sha256="1" * 64,
        quality_path="/automatic-paper-search/lineage/quality.json",
        quality_sha256="2" * 64,
        source_anchor="/automatic-paper-search/lineage/evidence.json",
        decision="accepted",
        trust_tier="corroborated",
        quality_status="ready",
        quality_result="passed",
        claim_family="genealogy",
        calibrated_probability=0.8,
        calibration_id="calibration-v1",
        independent_source_work_ids=("arxiv:one", "doi:10.1/two"),
        verified_by_review=False,
    )
    context = replace(
        reviewed_context,
        lineage_claims={("/automatic-paper-search/lineage.json", "claim-1"): lineage},
    )
    snapshot = snapshot_slide_validation_context(context)

    snapshot_pdf = next(iter(snapshot.pdf_chunks.values()))
    snapshot_lineage = next(iter(snapshot.lineage_claims.values()))
    snapshot_review = snapshot.review_records[review_path]
    assert snapshot_pdf is not pdf
    assert snapshot_lineage is not lineage
    assert snapshot_review is not review

    object.__setattr__(pdf, "sha256", "f" * 64)
    object.__setattr__(lineage, "artifact_sha256", "e" * 64)
    object.__setattr__(review, "reason", "mutated")
    assert snapshot_pdf.sha256 != pdf.sha256
    assert snapshot_lineage.artifact_sha256 != lineage.artifact_sha256
    assert snapshot_review.reason != review.reason


def test_context_snapshot_has_a_reference_limit() -> None:
    deck, context = _reviewed()
    chunk = next(iter(context.pdf_chunks.values()))
    context = replace(
        context,
        pdf_chunks={f"chunk-{value}": chunk for value in range(129)},
    )

    with pytest.raises(SlidePublicIndexError, match="context_snapshot"):
        project_reviewed_deck(deck, context=context)


def test_public_entry_is_deeply_immutable() -> None:
    deck, context = _reviewed()
    projected = project_reviewed_deck(deck, context=context)

    with pytest.raises(FrozenInstanceError):
        type(projected.entry).__setattr__(
            projected.entry,
            "reviewed_at",
            "2026-08-30T02:00:00Z",
        )


@pytest.mark.parametrize(
    "reviewed_at",
    [
        "9999-99-99T99:99:99Z",
        "2026-08-30T01:00:00.1234567Z",
    ],
)
def test_invalid_or_overprecise_review_timestamp_is_rejected(reviewed_at: str) -> None:
    deck, context = _reviewed()
    review_path = deck["review"]["review_record"]
    record = context.review_records[review_path]
    context = replace(
        context,
        review_records={review_path: replace(record, reviewed_at=reviewed_at)},
    )

    with pytest.raises(SlidePublicIndexError):
        project_reviewed_deck(deck, context=context)


def test_public_index_shard_has_an_explicit_byte_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    deck, context = _reviewed()
    monkeypatch.setattr("paperpilot.paper_slides.public_index.MAX_PUBLIC_INDEX_SHARD_BYTES", 1)

    with pytest.raises(SlidePublicIndexError, match="shard_size"):
        build_public_index_shards([ReviewedDeckCandidate(deck, context)])

    assert MAX_PUBLIC_INDEX_SHARD_BYTES > 1


def test_public_manifest_has_an_explicit_byte_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("paperpilot.paper_slides.public_index.MAX_PUBLIC_MANIFEST_BYTES", 1)

    with pytest.raises(SlidePublicIndexError, match="manifest_size"):
        build_public_index_shards([])

    assert MAX_PUBLIC_MANIFEST_BYTES > 1


def test_public_bundle_has_an_aggregate_byte_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("paperpilot.paper_slides.public_index.MAX_PUBLIC_BUNDLE_BYTES", 1)

    with pytest.raises(SlidePublicIndexError, match="bundle_size"):
        build_public_index_shards([])

    assert MAX_PUBLIC_BUNDLE_BYTES > 1


def test_public_file_paths_cannot_be_overwritten_even_with_identical_bytes() -> None:
    files = {"/immutable": b"same"}

    with pytest.raises(SlidePublicIndexError, match="public_file_collision"):
        public_index_module._add_public_file(files, "/immutable", b"same", 4)

    assert files == {"/immutable": b"same"}


def test_public_index_rejects_more_than_global_entry_limit() -> None:
    with pytest.raises(SlidePublicIndexError, match="projection_limit"):
        build_public_index_shards([object()] * (MAX_PUBLIC_INDEX_ENTRIES + 1))


@pytest.mark.parametrize("value", [None, {}, "entry", [object()]])
def test_public_index_builder_is_total_for_invalid_input(value: object) -> None:
    with pytest.raises(SlidePublicIndexError) as captured:
        build_public_index_shards(value)

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
