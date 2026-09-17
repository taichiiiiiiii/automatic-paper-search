from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from paperpilot.conference_watch.candidate import build_catalog_candidate
from paperpilot.conference_watch.dry_run import (
    MAX_CATALOG_BYTES,
    CatalogDryRunError,
    build_catalog_update_dry_run,
)
from paperpilot.conference_watch.fingerprint import source_fingerprint
from paperpilot.identity.source_ids import make_paper_id
from paperpilot.replay import canonical_json_bytes, strict_json_loads
from paperpilot.scripts.build_pages import _abstract_preview, load_summary_with_details
from paperpilot.tests.test_conference_watch_candidate import _edition, _ready, _snapshot


def _candidate(snapshot=None):
    snapshot = snapshot or _snapshot()
    return build_catalog_candidate(_edition(), _ready(snapshot), snapshot)


def _public_rows(candidate=None) -> list[dict[str, object]]:
    candidate = candidate or _candidate()
    return [
        {
            "title": row.title,
            "type": row.paper_type,
            "tags": list(row.tags),
            "venue": row.venue,
            "authors": list(row.authors),
            "arxiv_url": row.landing_url,
            "pdf_url": row.pdf_url,
            "abstract": _abstract_preview(row.abstract),
            "arxiv_id": row.arxiv_id,
            "citation_count": row.citation_count,
            "venue_tier": row.venue_tier,
            "github_stars": row.github_stars,
            "paper_id": row.paper_id,
            "source": row.source,
            "source_id": row.source_id,
        }
        for row in candidate.rows
    ]


def _catalog_bytes(rows: list[dict[str, object]]) -> bytes:
    return json.dumps(rows, ensure_ascii=False, indent=0).encode("utf-8")


def _details_bytes(candidate=None, *, papers: list[list[str]] | None = None) -> bytes:
    candidate = candidate or _candidate()
    payload: bytes = canonical_json_bytes(
        {
            "schema_version": "conference-current-details-v1",
            "edition_id": candidate.edition_id,
            "papers": papers
            if papers is not None
            else [[detail.paper_id, detail.abstract] for detail in candidate.details],
        }
    )
    return payload


def _run(
    *,
    snapshot=None,
    current_rows: list[dict[str, object]] | None = None,
    current_catalog_bytes: bytes | None = None,
    current_details_bytes: bytes | object | None = ...,
):
    snapshot = snapshot or _snapshot()
    candidate = _candidate(snapshot)
    catalog = (
        current_catalog_bytes
        if current_catalog_bytes is not None
        else _catalog_bytes(current_rows if current_rows is not None else _public_rows(candidate))
    )
    details = _details_bytes(candidate) if current_details_bytes is ... else current_details_bytes
    assert details is None or isinstance(details, bytes)
    return build_catalog_update_dry_run(
        _edition(),
        _ready(snapshot),
        snapshot,
        current_catalog_bytes=catalog,
        current_details_bytes=details,
    )


def _json(payload: bytes) -> dict[str, object]:
    value = strict_json_loads(payload)
    assert isinstance(value, dict)
    return value


def _refingerprint(snapshot, rows):
    rows = tuple(rows)
    fingerprint = source_fingerprint(
        adapter_version=snapshot.adapter_version,
        edition_id=snapshot.edition_id,
        source_id=snapshot.source_id,
        rows=rows,
    )
    duplicate_titles = sum(
        amount - 1 for amount in Counter(row.title for row in rows).values() if amount > 1
    )
    return replace(
        snapshot,
        rows=rows,
        source_fingerprint=fingerprint,
        duplicate_title_count=duplicate_titles,
    )


def _delta(result) -> dict[str, object]:
    report = _json(result.report_bytes)
    value = report["delta"]
    assert isinstance(value, dict)
    return value


def test_complete_identical_baseline_is_deterministic_no_change_and_immutable() -> None:
    edition = _edition()
    snapshot = _snapshot()
    readiness = _ready(snapshot)
    catalog_bytes = _catalog_bytes(_public_rows())
    details_bytes = _details_bytes()
    originals = copy.deepcopy((edition, readiness, snapshot, catalog_bytes, details_bytes))

    first = build_catalog_update_dry_run(
        edition,
        readiness,
        snapshot,
        current_catalog_bytes=catalog_bytes,
        current_details_bytes=details_bytes,
    )
    second = build_catalog_update_dry_run(
        edition,
        readiness,
        snapshot,
        current_catalog_bytes=catalog_bytes,
        current_details_bytes=details_bytes,
    )

    assert first == second
    assert first.outcome == "no_change"
    assert first.candidate_catalog_bytes == catalog_bytes
    assert (edition, readiness, snapshot, catalog_bytes, details_bytes) == originals
    report = _json(first.report_bytes)
    assert report["changed"] is False
    assert report["detail_comparison"] == "complete"
    assert _delta(first) == {
        "added": [],
        "removed": [],
        "metadata_changed": [],
        "unchanged": sorted(row.paper_id for row in snapshot.rows),
        "full_abstract_changed": [],
        "catalog_bytes_changed": False,
        "order_changed": False,
    }
    assert _json(first.staging_plan_bytes)["status"] == "not_required"


def test_missing_full_details_is_indeterminate_even_when_preview_bytes_match() -> None:
    result = _run(current_details_bytes=None)
    assert result.outcome == "indeterminate"
    report = _json(result.report_bytes)
    assert report["changed"] is None
    assert report["detail_comparison"] == "not_checked"
    assert _json(result.staging_plan_bytes)["status"] == "blocked"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "Changed synthetic title"),
        ("type", "Poster"),
        ("authors", ["Changed Author"]),
        ("citation_count", 17),
    ],
)
def test_metadata_changes_are_id_joined_and_field_only(field: str, value: object) -> None:
    rows = _public_rows()
    target_id = rows[0]["paper_id"]
    rows[0][field] = value
    result = _run(current_rows=rows)
    changed = _delta(result)["metadata_changed"]
    assert result.outcome == "changes_detected"
    assert changed == [{"paper_id": target_id, "fields": [field]}]
    rendered = result.report_bytes.decode()
    assert "Changed synthetic title" not in rendered
    assert "Changed Author" not in rendered


def test_added_and_removed_are_distinct_and_removal_is_blocked() -> None:
    rows = _public_rows()
    details = _candidate().details
    added_id = rows[-1]["paper_id"]
    added = _run(
        current_rows=rows[:-1],
        current_details_bytes=_details_bytes(
            papers=[
                [detail.paper_id, detail.abstract]
                for detail in details
                if detail.paper_id != added_id
            ]
        ),
    )
    assert added.outcome == "changes_detected"
    assert _delta(added)["added"] == [rows[-1]["paper_id"]]

    removed_source_id = "removedD4"
    removed_id = make_paper_id("openreview", removed_source_id)
    removed_row = {
        **rows[-1],
        "title": "Removed synthetic paper",
        "paper_id": removed_id,
        "source_id": removed_source_id,
        "arxiv_url": f"https://openreview.net/forum?id={removed_source_id}",
        "pdf_url": f"https://openreview.net/pdf?id={removed_source_id}",
    }
    removed_details = [[detail.paper_id, detail.abstract] for detail in details] + [
        [removed_id, str(removed_row["abstract"])]
    ]
    removed = _run(
        current_rows=[*rows, removed_row],
        current_details_bytes=_details_bytes(papers=removed_details),
    )
    assert removed.outcome == "blocked"
    assert _json(removed.report_bytes)["changed"] is True
    assert _delta(removed)["removed"] == [removed_id]
    plan = _json(removed.staging_plan_bytes)
    assert plan["status"] == "blocked"
    assert plan["repository_candidates"] == []
    blockers = plan["blockers"]
    assert isinstance(blockers, list)
    assert "current_catalog_removal_detected" in blockers


def test_same_title_distinct_identity_is_added_not_merged() -> None:
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    rows[-1] = replace(rows[-1], title=rows[0].title)
    snapshot = _refingerprint(snapshot, rows)
    candidate = _candidate(snapshot)
    current = _public_rows(candidate)[:-1]
    added_id = candidate.rows[-1].paper_id
    current_details = _details_bytes(
        candidate,
        papers=[
            [item.paper_id, item.abstract]
            for item in candidate.details
            if item.paper_id != added_id
        ],
    )
    result = _run(
        snapshot=snapshot,
        current_rows=current,
        current_details_bytes=current_details,
    )
    assert _delta(result)["added"] == [candidate.rows[-1].paper_id]
    assert _delta(result)["metadata_changed"] == []


def test_formatting_and_row_order_are_bytes_changes_not_metadata_changes() -> None:
    rows = _public_rows()
    formatted = json.dumps(rows, ensure_ascii=False, indent=2).encode()
    formatting = _run(current_catalog_bytes=formatted)
    assert formatting.outcome == "changes_detected"
    assert _delta(formatting)["catalog_bytes_changed"] is True
    assert _delta(formatting)["order_changed"] is False
    assert _delta(formatting)["metadata_changed"] == []

    reordered = _run(current_catalog_bytes=_catalog_bytes(list(reversed(rows))))
    assert reordered.outcome == "changes_detected"
    assert _delta(reordered)["order_changed"] is True
    assert _delta(reordered)["metadata_changed"] == []
    assert _delta(reordered)["unchanged"] == sorted(str(row["paper_id"]) for row in rows)


def test_full_abstract_tail_change_is_detected_beyond_equal_preview() -> None:
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    common = ("shared abstract words " * 30)[:500]
    rows[0] = replace(rows[0], abstract=common + "candidate tail")
    snapshot = _refingerprint(snapshot, rows)
    candidate = _candidate(snapshot)
    current_rows = _public_rows(candidate)
    old_full = common + "different old tail"
    assert _abstract_preview(old_full) == current_rows[0]["abstract"]
    target_id = str(current_rows[0]["paper_id"])
    current_details = [
        [item.paper_id, old_full if item.paper_id == target_id else item.abstract]
        for item in candidate.details
    ]

    result = _run(
        snapshot=snapshot,
        current_rows=current_rows,
        current_details_bytes=_details_bytes(candidate, papers=current_details),
    )
    assert result.outcome == "changes_detected"
    assert _delta(result)["metadata_changed"] == []
    assert _delta(result)["full_abstract_changed"] == [candidate.rows[0].paper_id]
    assert old_full not in result.report_bytes.decode()


def test_report_hashes_all_six_payloads_and_plan_binds_report_only_forward() -> None:
    result = _run(current_catalog_bytes=json.dumps(_public_rows()).encode())
    report = _json(result.report_bytes)
    artifacts = report["artifacts"]
    assert isinstance(artifacts, dict)
    payloads = {
        "candidate_catalog": result.candidate_catalog_bytes,
        "catalog_rows": result.catalog_rows_bytes,
        "details": result.details_bytes,
        "summary_csv": result.summary_csv_bytes,
        "source_quality": result.source_quality_bytes,
        "run_binding": result.run_binding_bytes,
    }
    assert set(artifacts) == set(payloads)
    for name, payload in payloads.items():
        assert artifacts[name] == {
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size_bytes": len(payload),
        }
    assert b"staging_plan" not in result.report_bytes
    plan = _json(result.staging_plan_bytes)
    assert plan["report"] == {
        "sha256": hashlib.sha256(result.report_bytes).hexdigest(),
        "size_bytes": len(result.report_bytes),
    }
    assert plan["status"] == "planned_not_materialized"
    assert plan["repository_candidates"] == [
        {
            "path": f"docs/{_edition().edition_id}/papers.json",
            "sha256": hashlib.sha256(result.candidate_catalog_bytes).hexdigest(),
            "size_bytes": len(result.candidate_catalog_bytes),
        },
        {
            "path": f"paperpilot/output/{_edition().edition_id}/summary.csv",
            "sha256": hashlib.sha256(result.summary_csv_bytes).hexdigest(),
            "size_bytes": len(result.summary_csv_bytes),
        },
    ]


def test_all_authority_is_false_and_required_regeneration_is_explicit() -> None:
    result = _run()
    required = [
        "catalog_date",
        "paper_links",
        "conferences_index",
        "identity_aliases_and_coverage",
        "search_indexes_and_id_blocks",
        "full_detail_shards",
        "lineage_quality",
        "asset_versions",
    ]
    for payload in (result.report_bytes, result.staging_plan_bytes):
        value = _json(payload)
        authority = value["authority"]
        assert isinstance(authority, dict)
        assert set(authority.values()) == {False}
    plan = _json(result.staging_plan_bytes)
    assert plan["required_regeneration"] == required
    assert plan["blockers"] == [
        "catalog_date_projection_unresolved",
        "shared_projection_not_materialized",
    ]
    report = _json(result.report_bytes)
    gates = report["gates"]
    assert isinstance(gates, dict)
    assert gates["previous_edition_ratio"] == "not_checked"
    assert gates["first_edition_human_dry_run"] == "not_checked"


def test_candidate_projection_matches_existing_summary_reader(tmp_path: Path) -> None:
    result = _run()
    summary = tmp_path / "summary.csv"
    summary.write_bytes(result.summary_csv_bytes)
    papers, details = load_summary_with_details(summary)
    assert result.candidate_catalog_bytes == json.dumps(
        papers, ensure_ascii=False, indent=0
    ).encode("utf-8")
    assert details == {detail.paper_id: detail.abstract for detail in _candidate().details}


@pytest.mark.parametrize(
    "payload",
    [
        b'{"not":"a list"}',
        b'[{"duplicate":1,"duplicate":2}]',
        b"[NaN]",
        (b"[" * 1_100) + (b"]" * 1_100),
        b"[]",
    ],
)
def test_rejects_malformed_duplicate_nonfinite_deep_and_empty_catalog(payload: bytes) -> None:
    with pytest.raises(CatalogDryRunError) as caught:
        _run(current_catalog_bytes=payload)
    assert caught.value.code.startswith("current_catalog_")
    assert str(caught.value) == caught.value.code


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "utf-32"])
def test_rejects_non_plain_utf8_catalog_encodings(encoding: str) -> None:
    payload = _catalog_bytes(_public_rows()).decode("utf-8").encode(encoding)
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_invalid$"):
        _run(current_catalog_bytes=payload)


@pytest.mark.parametrize(
    ("field", "value"), [("title", "bad\u0085title"), ("authors", ["bad\u009fauthor"])]
)
def test_rejects_c1_controls_in_catalog_text(field: str, value: object) -> None:
    rows = _public_rows()
    rows[0][field] = value
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_row_invalid$"):
        _run(current_rows=rows)


def test_rejects_c1_controls_in_full_details() -> None:
    candidate = _candidate()
    papers = [[detail.paper_id, detail.abstract] for detail in candidate.details]
    papers[0][1] += "\u0085"
    with pytest.raises(CatalogDryRunError, match=r"^current_details_row_invalid$"):
        _run(current_details_bytes=_details_bytes(candidate, papers=papers))


def test_rejects_catalog_type_size_shape_metric_duplicate_and_identity_errors() -> None:
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_bytes_required$"):
        build_catalog_update_dry_run(
            _edition(),
            _ready(_snapshot()),
            _snapshot(),
            current_catalog_bytes="[]",  # type: ignore[arg-type]
        )
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_size$"):
        _run(current_catalog_bytes=b" " * (MAX_CATALOG_BYTES + 1))

    rows = _public_rows()
    rows[0]["extra"] = "forbidden"
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_row_invalid$"):
        _run(current_rows=rows)

    rows = _public_rows()
    rows[0]["citation_count"] = True
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_row_invalid$"):
        _run(current_rows=rows)

    invalid_types: tuple[object, ...] = ([], {})
    for invalid_type in invalid_types:
        rows = _public_rows()
        rows[0]["type"] = invalid_type
        with pytest.raises(CatalogDryRunError, match=r"^current_catalog_row_invalid$"):
            _run(current_rows=rows)

    rows = _public_rows()
    rows[1] = dict(rows[0])
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_duplicate_id$"):
        _run(current_rows=rows)

    rows = _public_rows()
    rows[0]["pdf_url"] = "https://openreview.net/pdf?id=other"
    with pytest.raises(CatalogDryRunError, match=r"^current_catalog_identity_invalid$"):
        _run(current_rows=rows)


@pytest.mark.parametrize("mode", ["missing", "extra", "edition", "preview", "duplicate"])
def test_rejects_inconsistent_current_full_details(mode: str) -> None:
    candidate = _candidate()
    papers = [[detail.paper_id, detail.abstract] for detail in candidate.details]
    edition_id = candidate.edition_id
    if mode == "missing":
        papers.pop()
        code = "current_details_id_set"
    elif mode == "extra":
        papers.append(["f" * 40, "extra"])
        code = "current_details_id_set"
    elif mode == "edition":
        edition_id = "other-2026"
        code = "current_details_edition"
    elif mode == "preview":
        papers[0][1] = "inconsistent preview"
        code = "current_details_preview_mismatch"
    else:
        papers.append(list(papers[0]))
        code = "current_details_duplicate_id"
    payload = canonical_json_bytes(
        {
            "schema_version": "conference-current-details-v1",
            "edition_id": edition_id,
            "papers": papers,
        }
    )
    with pytest.raises(CatalogDryRunError, match=rf"^{code}$"):
        _run(current_details_bytes=payload)


def test_rejects_candidate_that_exceeds_narrow_public_profile() -> None:
    snapshot = _snapshot()
    rows = list(snapshot.rows)
    rows[0] = replace(rows[0], title="x" * 2_049)
    snapshot = _refingerprint(snapshot, rows)
    with pytest.raises(CatalogDryRunError, match=r"^candidate_catalog_row_invalid$"):
        _run(snapshot=snapshot, current_rows=_public_rows())


def test_candidate_validation_errors_are_preserved_without_details() -> None:
    snapshot = _snapshot()
    with pytest.raises(CatalogDryRunError, match=r"^CONF_CANDIDATE_READINESS_INVALID$"):
        build_catalog_update_dry_run(
            _edition(),
            replace(_ready(snapshot), stable_observations=1),
            snapshot,
            current_catalog_bytes=_catalog_bytes(_public_rows()),
        )
    with pytest.raises(CatalogDryRunError, match=r"^CONF_CANDIDATE_MISMATCH$"):
        build_catalog_update_dry_run(
            _edition(),
            _ready(snapshot),
            replace(snapshot, source_fingerprint="f" * 64),
            current_catalog_bytes=_catalog_bytes(_public_rows()),
        )
