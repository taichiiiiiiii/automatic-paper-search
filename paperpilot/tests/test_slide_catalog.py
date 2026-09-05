"""Approved Paper Slide catalog producer and Worker adapter parity."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from paperpilot.identity import make_paper_id
from paperpilot.paper_slides.catalog import (
    MANIFEST_SCHEMA,
    RECORD_SCHEMA,
    CatalogBuildError,
    CatalogConfig,
    build_catalog_snapshot,
    canonical_job_key,
    canonical_json_bytes,
    check_snapshot,
    write_snapshot,
)
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_EXTRACTION_INSUFFICIENT,
    PAPER_SLIDE_SOURCE_UNTRUSTED,
)
from paperpilot.scripts.build_paper_slide_catalog import main

ROOT = Path(__file__).resolve().parents[2]


def _config(**updates: object) -> CatalogConfig:
    value: dict[str, object] = {
        "deck_profile": "fixture-deck-v1",
        "deck_schema_version": "slide-deck-v1",
        "extractor_version": "abstract-only:1",
        "license_policy_version": "fixture-license-v1",
        "manifest_key": "approved/paper-slides/manifest.json",
        "model": "fixture-model",
        "prompt_version": "fixture-prompt-v1",
        "provider": "fixture-provider",
        "records_prefix": "approved/paper-slides/records/",
        "snapshot_version": "fixture-2026-09-04.1",
    }
    value.update(updates)
    return CatalogConfig.from_mapping(value)


def _row(source: str, source_id: str, **updates: object) -> dict[str, object]:
    paper_id = make_paper_id(source, source_id)
    row: dict[str, object] = {
        "abstract": "preview only",
        "arxiv_url": "https://attacker.invalid/not-trusted",
        "paper_id": paper_id,
        "pdf_url": "https://attacker.invalid/not-trusted.pdf",
        "source": source,
        "source_id": source_id,
        "title": "fixture",
    }
    row.update(updates)
    return row


def _write_catalog(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def _write_details(root: Path, entries: list[tuple[str, str]]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[list[str]]] = {f"{value:02x}": [] for value in range(256)}
    for paper_id, abstract in entries:
        grouped[paper_id[:2]].append([paper_id, abstract])
    for prefix, papers in grouped.items():
        value = {"schema_version": "paper-details-v1", "prefix": prefix, "papers": papers}
        (root / f"{prefix}.json").write_bytes(canonical_json_bytes(value))
    return root


def _build(
    tmp_path: Path,
    rows: list[dict[str, object]],
    details: list[tuple[str, str]],
):
    catalog = tmp_path / "conference" / "papers.json"
    _write_catalog(catalog, rows)
    return build_catalog_snapshot(
        config=_config(),
        catalog_paths=[catalog],
        detail_dir=_write_details(tmp_path / "paper-details-v1", details),
    )


def _abstract(label: str = "full") -> str:
    return f"{label}: " + ("trusted full abstract content " * 30)


def test_config_is_closed_required_and_canonical_bytes_have_one_lf(tmp_path: Path) -> None:
    with pytest.raises(CatalogBuildError, match="config_schema_invalid"):
        CatalogConfig.from_mapping({})
    with pytest.raises(CatalogBuildError, match="config_schema_invalid"):
        CatalogConfig.from_mapping({**_config().__dict__, "unexpected": "value"})
    with pytest.raises(CatalogBuildError, match="config_records_prefix_invalid"):
        _config(records_prefix="approved/../records/")
    with pytest.raises(CatalogBuildError, match="config_key_collision"):
        _config(records_prefix="pin.json/records/")
    with pytest.raises(CatalogBuildError, match="config_key_collision"):
        _config(manifest_key="approved/records", records_prefix="approved/records/items/")

    config_path = tmp_path / "config.json"
    config_path.write_text('{"provider":"first","provider":"second"}', encoding="utf-8")
    with pytest.raises(CatalogBuildError, match="config_invalid"):
        CatalogConfig.from_json_file(config_path)

    assert canonical_json_bytes({"z": "日本語", "a": 1}) == '{"a":1,"z":"日本語"}\n'.encode()


def test_json_inputs_reject_final_symlinks(tmp_path: Path) -> None:
    real_config = tmp_path / "real-config.json"
    real_config.write_bytes(canonical_json_bytes(_config().__dict__))
    linked_config = tmp_path / "linked-config.json"
    linked_config.symlink_to(real_config)

    with pytest.raises(CatalogBuildError, match="config_invalid"):
        CatalogConfig.from_json_file(linked_config)


@pytest.mark.parametrize(
    ("source", "source_id", "row_updates", "landing_url"),
    [
        ("arxiv", "2601.01234", {}, "https://arxiv.org/abs/2601.01234"),
        (
            "openreview",
            "AbC_123-x",
            {},
            "https://openreview.net/forum?id=AbC_123-x",
        ),
        (
            "acl_anthology",
            "2025.acl-long.153",
            {},
            "https://aclanthology.org/2025.acl-long.153/",
        ),
        (
            "cvf",
            "Paper_CVPR_2025_paper",
            {
                "arxiv_url": (
                    "https://openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html"
                ),
                "pdf_url": (
                    "https://openaccess.thecvf.com/content/CVPR2025/papers/"
                    "Paper_CVPR_2025_paper.pdf"
                ),
            },
            ("https://openaccess.thecvf.com/content/CVPR2025/html/Paper_CVPR_2025_paper.html"),
        ),
    ],
)
def test_registry_revalidates_identity_and_emits_abstract_only_material(
    tmp_path: Path,
    source: str,
    source_id: str,
    row_updates: dict[str, object],
    landing_url: str,
) -> None:
    row = _row(source, source_id, **row_updates)
    abstract = _abstract(source)
    snapshot = _build(tmp_path, [row], [(str(row["paper_id"]), abstract)])
    payload = snapshot.record_bytes[str(row["paper_id"])]
    record = json.loads(payload)
    material = record["canonical_material"]

    assert payload.endswith(b"\n") and not payload.endswith(b"\n\n")
    assert record["schema_version"] == RECORD_SCHEMA
    assert record["eligible"] is True
    assert material["source"] == {
        "landing_url": landing_url,
        "source": source,
        "source_id": source_id,
    }
    assert material["input"] == {
        "content_sha256": hashlib.sha256(abstract.encode()).hexdigest(),
        "coverage": "abstract_only",
        "pdf_url": None,
    }
    assert (
        material["input"]["content_sha256"]
        != hashlib.sha256(str(row["abstract"]).encode()).hexdigest()
    )


def test_manifest_is_strictly_sorted_and_digests_exact_record_bytes(tmp_path: Path) -> None:
    first = _row("arxiv", "2601.01234")
    second = _row("openreview", "AbC_123-x")
    rows = sorted([first, second], key=lambda row: str(row["paper_id"]), reverse=True)
    details = [(str(row["paper_id"]), _abstract(str(row["source"]))) for row in rows]
    snapshot = _build(tmp_path, rows, list(reversed(details)))
    manifest = json.loads(snapshot.manifest_bytes)

    assert manifest["schema_version"] == MANIFEST_SCHEMA
    assert manifest["record_count"] == 2
    assert [entry["paper_id"] for entry in manifest["records"]] == sorted(
        str(row["paper_id"]) for row in rows
    )
    assert manifest["records"] == [
        {
            "paper_id": paper_id,
            "sha256": hashlib.sha256(snapshot.record_bytes[paper_id]).hexdigest(),
        }
        for paper_id in sorted(snapshot.record_bytes)
    ]
    assert (
        json.loads(snapshot.pin_bytes)["manifest_sha256"]
        == hashlib.sha256(snapshot.manifest_bytes).hexdigest()
    )
    repeated = build_catalog_snapshot(
        config=snapshot.config,
        catalog_paths=[tmp_path / "conference" / "papers.json"],
        detail_dir=tmp_path / "paper-details-v1",
    )
    assert repeated.pin_bytes == snapshot.pin_bytes
    assert repeated.manifest_bytes == snapshot.manifest_bytes
    assert repeated.record_bytes == snapshot.record_bytes
    with pytest.raises(TypeError):
        snapshot.record_bytes[str(first["paper_id"])] = b"mutated"  # type: ignore[index]
    with pytest.raises(TypeError):
        snapshot.report.pin["manifest_sha256"] = "0" * 64  # type: ignore[index]


def test_output_files_reject_file_directory_collisions(tmp_path: Path) -> None:
    row = _row("arxiv", "2601.01234")
    paper_id = str(row["paper_id"])
    config = _config(manifest_key=f"approved/paper-slides/records/{paper_id}.json/manifest.json")
    catalog = tmp_path / "conference" / "papers.json"
    _write_catalog(catalog, [row])
    snapshot = build_catalog_snapshot(
        config=config,
        catalog_paths=[catalog],
        detail_dir=_write_details(tmp_path / "paper-details-v1", [(paper_id, _abstract())]),
    )

    with pytest.raises(CatalogBuildError, match="output_key_collision"):
        snapshot.files()


def test_missing_duplicate_and_ambiguous_inputs_become_stable_unavailable_records(
    tmp_path: Path,
) -> None:
    duplicate = _row("arxiv", "2601.01234")
    missing_source = _row("arxiv", "2602.01234")
    del missing_source["source"]
    missing_abstract = _row("openreview", "missingAbstract")
    duplicate_abstract = _row("acl_anthology", "2025.acl-long.153")
    rows = [duplicate, dict(duplicate), missing_source, missing_abstract, duplicate_abstract]
    details = [
        (str(duplicate["paper_id"]), _abstract("duplicate source")),
        (str(missing_source["paper_id"]), _abstract("missing source")),
        (str(duplicate_abstract["paper_id"]), _abstract("first")),
        (str(duplicate_abstract["paper_id"]), _abstract("second")),
    ]
    snapshot = _build(tmp_path, rows, details)
    failures = {
        paper_id: json.loads(payload)["failure_code"]
        for paper_id, payload in snapshot.record_bytes.items()
    }

    assert snapshot.report.record_count == 4
    assert snapshot.report.eligible_count == 0
    assert failures[str(duplicate["paper_id"])] == PAPER_SLIDE_SOURCE_UNTRUSTED
    assert failures[str(missing_source["paper_id"])] == PAPER_SLIDE_SOURCE_UNTRUSTED
    assert failures[str(missing_abstract["paper_id"])] == PAPER_SLIDE_EXTRACTION_INSUFFICIENT
    assert failures[str(duplicate_abstract["paper_id"])] == PAPER_SLIDE_EXTRACTION_INSUFFICIENT
    for payload in snapshot.record_bytes.values():
        assert json.loads(payload)["canonical_material"] is None


def test_write_is_atomic_immutable_and_check_is_byte_exact(tmp_path: Path) -> None:
    row = _row("arxiv", "2601.01234")
    snapshot = _build(tmp_path, [row], [(str(row["paper_id"]), _abstract())])
    output = tmp_path / "approved-snapshot"
    write_snapshot(snapshot, output)

    assert check_snapshot(snapshot, output)
    write_snapshot(snapshot, output)
    assert not list(tmp_path.glob(".approved-snapshot.tmp-*"))

    manifest_path = output / snapshot.config.manifest_key
    manifest_path.write_bytes(manifest_path.read_bytes() + b" ")
    assert not check_snapshot(snapshot, output)
    with pytest.raises(CatalogBuildError, match="output_exists_different"):
        write_snapshot(snapshot, output)


def test_write_never_follows_an_output_symlink(tmp_path: Path) -> None:
    row = _row("arxiv", "2601.01234")
    snapshot = _build(tmp_path, [row], [(str(row["paper_id"]), _abstract())])
    real_output = tmp_path / "real-snapshot"
    write_snapshot(snapshot, real_output)
    linked_output = tmp_path / "linked-snapshot"
    linked_output.symlink_to(real_output, target_is_directory=True)

    with pytest.raises(CatalogBuildError, match="output_path_invalid"):
        write_snapshot(snapshot, linked_output)


def test_cli_dry_run_writes_nothing_and_check_never_repairs(tmp_path: Path, capsys) -> None:
    row = _row("arxiv", "2601.01234")
    docs = tmp_path / "docs"
    catalog = docs / "fixture" / "papers.json"
    _write_catalog(catalog, [row])
    _write_details(docs / "paper-details-v1", [(str(row["paper_id"]), _abstract())])
    config_path = tmp_path / "config.json"
    config_path.write_bytes(canonical_json_bytes(_config().__dict__))
    output = tmp_path / "snapshot"
    arguments = [
        "--config",
        str(config_path),
        "--output",
        str(output),
        "--docs-root",
        str(docs),
        "--catalog",
        str(catalog),
    ]

    assert main([*arguments, "--dry-run"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["record_count"] == report["eligible_count"] == 1
    assert not output.exists()
    assert main([*arguments, "--check"]) == 1
    assert "check_mismatch" in capsys.readouterr().out
    assert not output.exists()
    assert main(arguments) == 0
    capsys.readouterr()
    assert main([*arguments, "--check"]) == 0


def test_byte_ceiling_fails_before_publication(tmp_path: Path, monkeypatch) -> None:
    row = _row("arxiv", "2601.01234")
    monkeypatch.setattr("paperpilot.paper_slides.catalog.MAX_RECORD_BYTES", 128)
    with pytest.raises(CatalogBuildError, match="record_bytes_exceeded"):
        _build(tmp_path, [row], [(str(row["paper_id"]), _abstract())])


def test_total_input_rows_are_bounded_even_when_ids_repeat(tmp_path: Path, monkeypatch) -> None:
    row = _row("arxiv", "2601.01234")
    monkeypatch.setattr("paperpilot.paper_slides.catalog.MAX_RECORDS", 1)
    with pytest.raises(CatalogBuildError, match="catalog_record_count_exceeded"):
        _build(tmp_path, [row, dict(row)], [(str(row["paper_id"]), _abstract())])

    another = _row("openreview", "another")
    with pytest.raises(CatalogBuildError, match="detail_record_count_exceeded"):
        _build(
            tmp_path,
            [row],
            [
                (str(row["paper_id"]), _abstract()),
                (str(another["paper_id"]), _abstract("unused")),
            ],
        )


def test_python_job_key_validation_is_as_closed_as_worker_validation(tmp_path: Path) -> None:
    row = _row("openreview", "AbC_123-x")
    paper_id = str(row["paper_id"])
    snapshot = _build(tmp_path, [row], [(paper_id, _abstract())])
    material = json.loads(snapshot.record_bytes[paper_id])["canonical_material"]

    assert len(canonical_job_key(material, "ja")) == 64
    with pytest.raises(CatalogBuildError, match="job_material_invalid"):
        canonical_job_key({**material, "unexpected": True}, "ja")
    with pytest.raises(CatalogBuildError, match="job_material_invalid"):
        canonical_job_key({**material, "paper_id": paper_id.upper()}, "ja")
    with pytest.raises(CatalogBuildError, match="job_material_invalid"):
        canonical_job_key(
            {
                **material,
                "source": {**material["source"], "landing_url": "https://OPENREVIEW.net/"},
            },
            "ja",
        )


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is required for Worker parity")
def test_generated_snapshot_is_consumed_by_js_adapter_with_identical_job_key(
    tmp_path: Path,
) -> None:
    row = _row("openreview", "AbC_123-x")
    paper_id = str(row["paper_id"])
    snapshot = _build(tmp_path, [row], [(paper_id, _abstract())])
    output = tmp_path / "snapshot"
    write_snapshot(snapshot, output)
    record = json.loads(snapshot.record_bytes[paper_id])

    script = tmp_path / "verify.mjs"
    script.write_text(
        """
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, modulePath, paperId] = process.argv.slice(2);
const { createPaperSlideCatalogAdapter } = await import(pathToFileURL(modulePath));
const pin = JSON.parse(await fs.readFile(path.join(root, "pin.json"), "utf8"));
const binding = { async get(key) {
  try { return new Uint8Array(await fs.readFile(path.join(root, ...key.split("/")))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}};
const result = await createPaperSlideCatalogAdapter({ binding, pin }).resolve(paperId, "ja");
process.stdout.write(JSON.stringify(result));
""".strip(),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [
            "node",
            str(script),
            str(output),
            str(ROOT / "worker" / "paper-slide-catalog.js"),
            paper_id,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    result = json.loads(completed.stdout)

    assert result == {
        "paper_id": paper_id,
        "eligible": True,
        "snapshot_version": snapshot.config.snapshot_version,
        "job_key": canonical_job_key(record["canonical_material"], "ja"),
    }
