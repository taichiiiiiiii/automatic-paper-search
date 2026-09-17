from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import replace
from pathlib import Path

import jsonschema
import pytest

import paperpilot.lineage_pilot.bundle as bundle_module
from paperpilot.lineage_pilot import (
    LineagePilotError,
    PilotBundle,
    build_pilot_bundle,
    build_pilot_index,
    validate_pilot_index,
    write_local_pilot_bundle,
)
from paperpilot.replay import canonical_json_bytes, strict_json_loads

ROOT = Path(__file__).resolve().parents[2]
PAPER_ID = "1" * 40
CONFERENCE = "synthetic-pilot"
COLLECTION_ID = f"deep:{CONFERENCE}:paper:{PAPER_ID}"
POSITIVE_RELEASE = Path(__file__).parent / "fixtures" / "lineage-pilot" / "positive-release"


def _load_release_json(relative: str) -> object:
    return strict_json_loads((POSITIVE_RELEASE / relative).read_bytes())


def _load_release_object(relative: str) -> dict[str, object]:
    value = _load_release_json(relative)
    assert isinstance(value, dict)
    return value


def _inputs() -> tuple[dict[str, object], dict[str, object], dict[str, object], list[object]]:
    index = _load_release_object("lineage-pilot-index-v1.json")
    entry = index["entries"][0]  # type: ignore[index]
    artifact = _load_release_object(entry["artifact"]["path"])
    fixture = _load_release_object(entry["fixture"]["path"])
    quality = _load_release_object(entry["quality"]["path"])
    row = quality["collections"][0]  # type: ignore[index]
    row["path"] = "staging/synthetic-pilot/deep-lineage-v2.json"
    catalog = _load_release_json("catalog.json")
    assert isinstance(catalog, list)
    return artifact, fixture, quality, catalog


def _build():
    artifact, fixture, quality, catalog = _inputs()
    return build_pilot_bundle(
        artifact=artifact,
        fixture=fixture,
        quality=quality,
        catalog=catalog,
        conference=CONFERENCE,
        paper_id=PAPER_ID,
    )


def test_builds_content_addressed_bound_bundle() -> None:
    bundle = _build()
    entry = bundle.index_entry
    assert entry.collection_id == COLLECTION_ID
    assert set(bundle.files) == {
        entry.artifact.path,
        entry.fixture.path,
        entry.quality.path,
    }
    for reference in (entry.artifact, entry.fixture, entry.quality):
        payload = bundle.files[reference.path]
        assert payload.endswith(b"\n") and not payload.endswith(b"\n\n")
        assert hashlib.sha256(payload).hexdigest() == reference.sha256
        assert reference.path.endswith(f"/{reference.sha256}.json")
    projected_quality = strict_json_loads(bundle.files[entry.quality.path])
    assert projected_quality["collections"][0]["path"] == entry.artifact.path  # type: ignore[index]


def build_synthetic_comparison_bundle(stale_review: bool = False) -> PilotBundle:
    """A comparison-only synthetic case must use the real bundle validator."""
    artifact, fixture, quality, catalog = _inputs()
    claims = artifact["claims"]
    assert isinstance(claims, list)
    claim = claims[0]
    claim["claim_family"] = "comparison"
    claim["relation"] = "contrasts"
    claim["rationale"] = "Synthetic comparison only; not a scientific assertion."
    collections = fixture["collections"]
    assert isinstance(collections, list)
    edge = collections[0]["edge_labels"][0]
    for review in [*edge["reviews"], edge["adjudication"]]:
        review["gold_family"] = "comparison"
        review["gold_relation"] = "contrasts"
    if stale_review:
        edge["adjudication"]["gold_family"] = "genealogy"
        edge["adjudication"]["gold_relation"] = "extends"
    digest = hashlib.sha256(canonical_json_bytes(artifact)).hexdigest()
    collections[0]["artifact_sha256"] = digest
    quality_rows = quality["collections"]
    assert isinstance(quality_rows, list)
    row = quality_rows[0]
    row["artifact_sha256"] = digest
    row["fixture_sha256"] = hashlib.sha256(canonical_json_bytes(fixture)).hexdigest()
    row["accepted_genealogy_count"] = 0
    row["accepted_comparison_count"] = 1
    return build_pilot_bundle(artifact=artifact, fixture=fixture, quality=quality,
                               catalog=catalog, conference=CONFERENCE, paper_id=PAPER_ID)


@pytest.mark.parametrize("stale_review", [False, True])
def test_synthetic_comparison_bundle_preserves_review_and_hash_binding(stale_review: bool) -> None:
    if stale_review:
        with pytest.raises(LineagePilotError):
            build_synthetic_comparison_bundle(stale_review=True)
        return
    result = build_synthetic_comparison_bundle()
    emitted = strict_json_loads(result.files[result.index_entry.artifact.path])
    assert isinstance(emitted, dict)
    assert emitted["claims"][0]["claim_family"] == "comparison"
    assert emitted["claims"][0]["relation"] == "contrasts"


def test_build_is_deterministic_immutable_and_does_not_mutate_inputs() -> None:
    artifact, fixture, quality, catalog = _inputs()
    originals = copy.deepcopy((artifact, fixture, quality, catalog))
    first = build_pilot_bundle(
        artifact=artifact,
        fixture=fixture,
        quality=quality,
        catalog=catalog,
        conference=CONFERENCE,
        paper_id=PAPER_ID,
    )
    second = _build()
    assert (artifact, fixture, quality, catalog) == originals
    assert first.index_entry == second.index_entry
    assert dict(first.files) == dict(second.files)
    with pytest.raises(TypeError):
        first.files["extra.json"] = b"{}\n"  # type: ignore[index]


def test_build_validates_and_emits_one_private_snapshot(monkeypatch) -> None:
    artifact, fixture, quality, catalog = _inputs()
    original_release = artifact["release_id"]
    real_validator = bundle_module.validate_lineage_artifact_v2

    def mutate_caller_after_snapshot(value, **kwargs):
        artifact["release_id"] = "caller-raced-after-snapshot"
        return real_validator(value, **kwargs)

    monkeypatch.setattr(bundle_module, "validate_lineage_artifact_v2", mutate_caller_after_snapshot)
    bundle = build_pilot_bundle(
        artifact=artifact,
        fixture=fixture,
        quality=quality,
        catalog=catalog,
        conference=CONFERENCE,
        paper_id=PAPER_ID,
    )
    emitted = strict_json_loads(bundle.files[bundle.index_entry.artifact.path])
    assert artifact["release_id"] == "caller-raced-after-snapshot"
    assert bundle.index_entry.release_id == original_release
    assert emitted["release_id"] == original_release  # type: ignore[index]


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (lambda a, f, q, c: a["meta"].__setitem__("kind", "theme"), "artifact_v2_artifact_kind"),
        (
            lambda a, f, q, c: q["collections"][0].__setitem__("collection_id", "deep:bad"),
            "quality_selector_invalid",
        ),
        (
            lambda a, f, q, c: q["collections"].append(copy.deepcopy(q["collections"][0])),
            "quality_selector_invalid",
        ),
        (lambda a, f, q, c: c[0].__setitem__("paper_id", "2" * 40), "paper_absent_from_catalog"),
    ],
)
def test_rejects_non_deep_non_singleton_and_catalog_mismatch(mutation, code: str) -> None:
    artifact, fixture, quality, catalog = _inputs()
    mutation(artifact, fixture, quality, catalog)
    with pytest.raises(LineagePilotError) as caught:
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )
    assert caught.value.code == code


def test_rejects_catalog_duplicates_and_invalid_source_quality_binding() -> None:
    artifact, fixture, quality, catalog = _inputs()
    catalog.append(copy.deepcopy(catalog[0]))
    with pytest.raises(LineagePilotError, match=r"^catalog_duplicate_paper$"):
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )

    artifact, fixture, quality, catalog = _inputs()
    quality["collections"][0]["artifact_sha256"] = "0" * 64  # type: ignore[index]
    with pytest.raises(LineagePilotError, match=r"^quality_v2_artifact_hash_mismatch$"):
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )


def test_normalizes_expected_validator_exception(monkeypatch) -> None:
    artifact, fixture, quality, catalog = _inputs()

    def fail_validation(*_args, **_kwargs):
        raise ValueError("untrusted detail must not cross the boundary")

    monkeypatch.setattr(bundle_module, "validate_lineage_artifact_v2", fail_validation)
    with pytest.raises(LineagePilotError) as caught:
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )
    assert caught.value.code == "artifact_v2_validation_error"
    assert "untrusted detail" not in str(caught.value)


def test_bounds_fail_closed() -> None:
    artifact, fixture, quality, catalog = _inputs()
    catalog[0]["abstract"] = "x" * bundle_module.MAX_CATALOG_BYTES  # type: ignore[index]
    with pytest.raises(LineagePilotError, match=r"^catalog_invalid$"):
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )
    with pytest.raises(LineagePilotError, match=r"^index_invalid$"):
        validate_pilot_index(
            {
                "schema_version": "lineage-pilot-index-v1",
                "entries": [_build().index_entry.as_dict()] * 101,
            }
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", ""),
        ("authors", []),
        ("authors", ["Synthetic Author", 7]),
        ("tags", "Synthetic"),
        ("abstract", None),
    ],
)
def test_rejects_catalog_metadata_not_accepted_by_catalog_core_or_server(
    field: str, value: object
) -> None:
    artifact, fixture, quality, catalog = _inputs()
    catalog[0][field] = value  # type: ignore[index]
    with pytest.raises(LineagePilotError, match=r"^catalog_metadata_invalid$"):
        build_pilot_bundle(
            artifact=artifact,
            fixture=fixture,
            quality=quality,
            catalog=catalog,
            conference=CONFERENCE,
            paper_id=PAPER_ID,
        )


def test_index_is_closed_bounded_and_schema_valid() -> None:
    bundle = _build()
    payload = build_pilot_index((bundle.index_entry,))
    value = strict_json_loads(payload)
    assert validate_pilot_index(value).entries == (bundle.index_entry,)
    schema = json.loads(
        (ROOT / "schemas" / "lineage-pilot-index-v1.schema.json").read_text(encoding="utf-8")
    )
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.Draft202012Validator(schema).validate(value)

    duplicate = {
        "schema_version": "lineage-pilot-index-v1",
        "entries": [bundle.index_entry.as_dict(), bundle.index_entry.as_dict()],
    }
    with pytest.raises(LineagePilotError, match=r"^index_duplicate_paper$"):
        validate_pilot_index(duplicate)

    bad_path = bundle.index_entry.as_dict()
    bad_path["artifact"]["path"] += "?download=1"  # type: ignore[index]
    with pytest.raises(LineagePilotError, match=r"^index_reference_invalid$"):
        validate_pilot_index({"schema_version": "lineage-pilot-index-v1", "entries": [bad_path]})


def test_index_builder_reads_at_most_limit_plus_one_entries() -> None:
    entry = _build().index_entry

    def too_many_entries():
        for _ in range(101):
            yield entry
        raise AssertionError("producer read beyond the bounded rejection point")

    with pytest.raises(LineagePilotError, match=r"^index_invalid$"):
        build_pilot_index(too_many_entries())


def test_repository_index_is_canonical_and_empty() -> None:
    payload = (ROOT / "docs" / "lineage-pilot-index-v1.json").read_bytes()
    assert payload == canonical_json_bytes(
        {"schema_version": "lineage-pilot-index-v1", "entries": []}
    )
    assert validate_pilot_index(strict_json_loads(payload)).entries == ()


def test_cross_language_positive_release_is_exact_real_producer_output() -> None:
    bundle = _build()
    expected = dict(bundle.files)
    expected["lineage-pilot-index-v1.json"] = build_pilot_index((bundle.index_entry,))
    actual = {
        path.relative_to(POSITIVE_RELEASE).as_posix(): path.read_bytes()
        for path in POSITIVE_RELEASE.rglob("*.json")
        if path.name != "catalog.json"
    }
    assert actual == expected
    catalog = strict_json_loads((POSITIVE_RELEASE / "catalog.json").read_bytes())
    assert catalog == _inputs()[3]


def test_writer_is_fresh_atomic_and_rejects_docs(tmp_path: Path) -> None:
    bundle = _build()
    output = tmp_path / "pilot"
    assert write_local_pilot_bundle(bundle, output) == output.resolve()
    assert (output / "lineage-pilot-index-v1.json").read_bytes() == build_pilot_index(
        (bundle.index_entry,)
    )
    with pytest.raises(LineagePilotError, match=r"^output_exists$"):
        write_local_pilot_bundle(bundle, output)
    with pytest.raises(LineagePilotError, match=r"^output_canonical_forbidden$"):
        write_local_pilot_bundle(bundle, ROOT / "docs" / "not-a-publication-path")
    with pytest.raises(LineagePilotError, match=r"^output_canonical_forbidden$"):
        write_local_pilot_bundle(bundle, ROOT / "paperpilot" / "data" / "pilot")


def test_writer_rejects_manually_constructed_bundle_bypass(tmp_path: Path) -> None:
    built = _build()
    forged = PilotBundle(files=built.files, index_entry=built.index_entry)
    with pytest.raises(LineagePilotError, match=r"^bundle_invalid$"):
        write_local_pilot_bundle(forged, tmp_path / "forged")
    replaced = replace(built, files=dict(built.files))
    with pytest.raises(LineagePilotError, match=r"^bundle_invalid$"):
        write_local_pilot_bundle(replaced, tmp_path / "replaced")


def test_writer_rejects_symlink_ancestor_and_target(tmp_path: Path) -> None:
    bundle = _build()
    real = tmp_path / "real"
    real.mkdir()
    linked_parent = tmp_path / "linked"
    linked_parent.symlink_to(real, target_is_directory=True)
    with pytest.raises(LineagePilotError, match=r"^output_path_invalid$"):
        write_local_pilot_bundle(bundle, linked_parent / "created-by-bug" / "pilot")
    assert not (real / "created-by-bug").exists()

    target = tmp_path / "pilot-link"
    target.symlink_to(tmp_path / "missing", target_is_directory=True)
    with pytest.raises(LineagePilotError, match=r"^output_path_invalid$"):
        write_local_pilot_bundle(bundle, target)


def test_writer_loses_race_without_overwriting(monkeypatch, tmp_path: Path) -> None:
    bundle = _build()
    output = tmp_path / "pilot"
    real_rename = bundle_module._rename_noreplace

    def create_competitor(source: Path, destination: Path) -> None:
        destination.mkdir()
        (destination / "winner.txt").write_text("winner", encoding="utf-8")
        real_rename(source, destination)

    monkeypatch.setattr(bundle_module, "_rename_noreplace", create_competitor)
    with pytest.raises(LineagePilotError, match=r"^output_exists$"):
        write_local_pilot_bundle(bundle, output)
    assert (output / "winner.txt").read_text(encoding="utf-8") == "winner"
    assert not list(tmp_path.glob(".pilot.tmp-*"))
