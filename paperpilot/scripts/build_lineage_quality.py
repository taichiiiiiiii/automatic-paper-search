"""Build the fail-closed conference/theme/deep lineage quality read model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from paperpilot.identity.source_ids import IdentityError, normalize_alias

from ._lineage_contract import (
    canonical_focus_node,
    is_paper_id,
    validate_deep_manifest,
    validate_lineage_artifact,
)

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"
FIXTURES_PATH = ROOT / "paperpilot" / "data" / "lineage-audit-fixtures-v1.json"
POLICY_PATH = ROOT / "paperpilot" / "data" / "lineage-quality-policy-v1.json"
OUTPUT_PATH = DOCS_ROOT / "lineage-quality-v1.json"


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _hash_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _hash_bytes(payload.encode())


def _catalog_identity(rows: object) -> tuple[set[str], dict[str, str], list[str]]:
    """Return exact, unambiguous same-row paper_id/arXiv pairs."""

    if not isinstance(rows, list):
        return set(), {}, ["catalog-not-array"]
    catalog_ids: set[str] = set()
    arxiv_by_paper: dict[str, str] = {}
    paper_by_arxiv: dict[str, str] = {}
    failures: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not is_paper_id(row.get("paper_id")):
            continue
        paper_id = row["paper_id"]
        catalog_ids.add(paper_id)
        candidates: list[str] = []
        if isinstance(row.get("arxiv_id"), str) and row["arxiv_id"].strip():
            candidates.append(row["arxiv_id"])
        if row.get("source") == "arxiv" and isinstance(row.get("source_id"), str):
            candidates.append(row["source_id"])
        normalized: set[str] = set()
        for candidate in candidates:
            try:
                _, arxiv_id = normalize_alias("arxiv", candidate)
            except IdentityError:
                failures.append(f"catalog-row-{index}-invalid-arxiv")
                continue
            normalized.add(arxiv_id)
        if len(normalized) > 1:
            failures.append(f"catalog-paper-{paper_id}-ambiguous-arxiv")
            continue
        if not normalized:
            continue
        arxiv_id = next(iter(normalized))
        previous_arxiv = arxiv_by_paper.get(paper_id)
        previous_paper = paper_by_arxiv.get(arxiv_id)
        if previous_arxiv not in {None, arxiv_id} or previous_paper not in {
            None,
            paper_id,
        }:
            failures.append("catalog-ambiguous-paper-arxiv-mapping")
            continue
        arxiv_by_paper[paper_id] = arxiv_id
        paper_by_arxiv[arxiv_id] = paper_id
    return catalog_ids, arxiv_by_paper, sorted(set(failures))


def _check(
    name: str,
    status: str,
    observed: int | float | str | None,
    expected: int | float | str | None,
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "observed": observed,
        "expected": expected,
        "evidence": (evidence or [])[:20],
    }


def _node_id(node: object) -> str | None:
    if not isinstance(node, dict):
        return None
    value = node.get("id") or node.get("paperId")
    return value if isinstance(value, str) and value else None


def _edge_confidence(edge: dict[str, Any]) -> object:
    return edge["confidence"] if "confidence" in edge else edge.get("conf")


def _artifact_checks(
    data: dict[str, Any],
    *,
    kind: str,
    fixture: dict[str, Any] | None,
    input_sha256: str,
    as_of: datetime,
    generated_at: str | None,
    catalog_ids: set[str] | None,
    expected_seed_paper_id: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    checks: list[dict[str, Any]] = []
    nodes = data.get("nodes")
    edges = data.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return [_check("artifact_shape", "failed", "invalid", "nodes/edges arrays")], None
    checks.append(_check("artifact_shape", "passed", 0, 0))

    contract_issues = validate_lineage_artifact(
        data,
        kind=kind,
        catalog_ids=catalog_ids,
        expected_seed_paper_id=expected_seed_paper_id,
    )
    checks.append(
        _check(
            "artifact_contract_v1",
            "failed" if contract_issues else "passed",
            len(contract_issues),
            0,
            [f"{issue.code}:{issue.path}" for issue in contract_issues],
        )
    )

    ids = [_node_id(node) for node in nodes]
    missing_ids = [str(index) for index, value in enumerate(ids) if value is None]
    duplicate_ids = sorted({value for value in ids if value and ids.count(value) > 1})
    id_failures = [*missing_ids, *duplicate_ids]
    checks.append(
        _check(
            "node_ids_unique",
            "failed" if id_failures else "passed",
            len(id_failures),
            0,
            id_failures,
        )
    )
    id_set = {value for value in ids if value}

    dangling: list[str] = []
    degree: set[str] = set()
    bad_semantics: list[str] = []
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            dangling.append(f"edge:{index}:not-object")
            bad_semantics.append(f"edge:{index}:not-object")
            continue
        src = edge.get("src")
        dst = edge.get("dst")
        if (
            not isinstance(src, str)
            or not isinstance(dst, str)
            or src not in id_set
            or dst not in id_set
        ):
            dangling.append(f"edge:{index}:{src}->{dst}")
        else:
            degree.update((src, dst))
        relation = edge.get("relation")
        confidence = _edge_confidence(edge)
        rationale = edge.get("rationale")
        provenance = edge.get("provenance")
        if (
            not isinstance(relation, str)
            or not relation.strip()
            or not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= confidence <= 1
            or not isinstance(rationale, str)
            or not rationale.strip()
            or edge.get("rel") != relation
            or edge.get("conf") != confidence
            or not isinstance(provenance, dict)
            or any(
                issue.path.startswith(f"$.edges[{index}].provenance") for issue in contract_issues
            )
        ):
            bad_semantics.append(f"edge:{index}:{src}->{dst}")
    checks.append(
        _check(
            "edge_endpoints_resolve",
            "failed" if dangling else "passed",
            len(dangling),
            0,
            dangling,
        )
    )
    checks.append(
        _check(
            "edge_semantics_complete",
            "failed" if bad_semantics else "passed",
            len(bad_semantics),
            0,
            bad_semantics,
        )
    )

    root = data.get("root")
    focus_ids = {
        node_id
        for node_id, node in zip(ids, nodes, strict=True)
        if node_id and isinstance(node, dict) and node.get("is_focus") is True
    }
    root_focus_failures: list[str] = []
    if not isinstance(root, str) or ids.count(root) != 1 or root not in focus_ids:
        root_focus_failures.append(f"root:{root}")
    if not focus_ids:
        root_focus_failures.append("focus:none")
    checks.append(
        _check(
            "root_focus_resolve",
            "failed" if root_focus_failures else "passed",
            len(root_focus_failures),
            0,
            root_focus_failures,
        )
    )

    orphan_ids = sorted(
        node_id
        for node_id in id_set
        if node_id not in degree and node_id != root and node_id not in focus_ids
    )
    checks.append(
        _check(
            "orphan_node_count",
            "failed" if orphan_ids else "passed",
            len(orphan_ids),
            0,
            orphan_ids,
        )
    )

    seed_failures: list[str] = []
    seed_values: list[str] = []
    membership_failures: list[str] = []
    for node_id, node in zip(ids, nodes, strict=True):
        if node_id in focus_ids and isinstance(node, dict):
            seed = node.get("seed_paper_id")
            if not is_paper_id(seed):
                seed_failures.append(str(node_id))
                continue
            seed_values.append(seed)
            if kind in {"conference", "deep"} and (catalog_ids is None or seed not in catalog_ids):
                membership_failures.append(str(node_id))
    duplicate_seeds = sorted({seed for seed in seed_values if seed_values.count(seed) > 1})
    seed_failures.extend(f"duplicate:{seed}" for seed in duplicate_seeds)
    checks.append(
        _check(
            "catalog_seed_ids",
            "failed" if seed_failures else "passed",
            len(seed_failures),
            0,
            seed_failures,
        )
    )
    checks.append(
        _check(
            "catalog_seed_membership",
            "failed" if membership_failures else "passed",
            len(membership_failures),
            0,
            membership_failures,
        )
    )

    timestamp_failures: list[str] = []
    if generated_at:
        try:
            if _parse_time(generated_at) > as_of:
                timestamp_failures.append(generated_at)
        except ValueError:
            timestamp_failures.append(generated_at)
    checks.append(
        _check(
            "timestamp_not_future",
            "failed" if timestamp_failures else "passed",
            len(timestamp_failures),
            0,
            timestamp_failures,
        )
    )

    fixture_sha256: str | None = None
    if fixture is None:
        checks.append(_check("golden_fixture", "unknown", None, "matching frozen fixture"))
    else:
        fixture_sha256 = _canonical_hash(fixture)
        fixture_failures: list[str] = []
        if fixture.get("input_sha256") != input_sha256:
            fixture_failures.append("input-sha-mismatch")
        if not fixture.get("reviewer") or not fixture.get("reviewed_at"):
            fixture_failures.append("review-metadata-missing")
        focus_labels = fixture.get("focus_labels")
        sample_labels = fixture.get("sample_labels")
        if not isinstance(focus_labels, list) or not isinstance(sample_labels, list):
            fixture_failures.append("labels-missing")
            focus_labels = []
            sample_labels = []
        labelled_focus = {
            row.get("node_id")
            for row in focus_labels
            if isinstance(row, dict) and row.get("on_topic") is True
        }
        missing_focus = sorted(focus_ids - labelled_focus)
        fixture_failures.extend(f"focus:{node_id}" for node_id in missing_focus)
        if len(sample_labels) > 20:
            fixture_failures.append("sample-limit-exceeded")
        invalid_samples = [
            str(row.get("node_id"))
            for row in sample_labels
            if not isinstance(row, dict)
            or row.get("node_id") not in id_set
            or not isinstance(row.get("on_topic"), bool)
        ]
        fixture_failures.extend(f"sample:{node_id}" for node_id in invalid_samples)
        labelled_samples = [row for row in sample_labels if isinstance(row, dict)]
        off_topic = sum(row.get("on_topic") is False for row in labelled_samples)
        if labelled_samples and off_topic / len(labelled_samples) > 0.10:
            fixture_failures.append("sample-off-topic-rate")
        checks.append(
            _check(
                "golden_fixture",
                "failed" if fixture_failures else "passed",
                len(fixture_failures),
                0,
                fixture_failures,
            )
        )
    return sorted(checks, key=lambda row: row["name"]), fixture_sha256


def _label_from_slug(slug: str) -> str:
    match = re.fullmatch(r"(.+)-(\d{4})", slug)
    if not match:
        return slug
    return f"{match.group(1).upper()} {match.group(2)}"


def _freshness(
    *,
    generated_at: str | None,
    snapshot_date: str | None,
    as_of: datetime,
    max_age_days: int,
) -> str:
    reference = generated_at or snapshot_date
    if not reference:
        return "stale"
    try:
        if len(reference) == 10:
            observed = datetime.fromisoformat(reference).replace(tzinfo=timezone.utc)
        else:
            observed = _parse_time(reference)
    except ValueError:
        return "stale"
    age_days = (as_of - observed).total_seconds() / 86_400
    return "fresh" if 0 <= age_days <= max_age_days else "stale"


def _collection_row(
    *,
    docs_root: Path,
    kind: str,
    slug: str,
    label: str,
    relative_path: str,
    snapshot_date: str | None,
    generated_hint: str | None,
    fixture: dict[str, Any] | None,
    as_of_text: str,
    max_age_days: int,
    catalog_ids: set[str] | None,
    collection_id: str | None = None,
    expected_seed_paper_id: str | None = None,
) -> dict[str, Any]:
    path = docs_root / relative_path
    as_of = _parse_time(as_of_text)
    try:
        payload = path.read_bytes()
    except OSError:
        return {
            "collection_id": collection_id or f"{kind}:{slug}",
            "kind": kind,
            "slug": slug,
            "label": label,
            "path": relative_path,
            "availability": "unavailable",
            "audit_status": "unknown",
            "freshness": "stale",
            "generated_at": generated_hint,
            "snapshot_date": snapshot_date,
            "node_count": 0,
            "edge_count": 0,
            "artifact_schema_version": None,
            "input_sha256": None,
            "audit": {
                "fixture_sha256": None,
                "evaluated_at": as_of_text,
                "actor": "ci:audit-v1",
                "checks": [_check("artifact_present", "unknown", 0, 1)],
            },
        }

    input_sha256 = _hash_bytes(payload)
    try:
        data = json.loads(payload)
        if not isinstance(data, dict):
            raise ValueError("lineage artifact must be an object")
    except (json.JSONDecodeError, ValueError) as exc:
        return {
            "collection_id": collection_id or f"{kind}:{slug}",
            "kind": kind,
            "slug": slug,
            "label": label,
            "path": relative_path,
            "availability": "failed",
            "audit_status": "failed",
            "freshness": "stale",
            "generated_at": generated_hint,
            "snapshot_date": snapshot_date,
            "node_count": 0,
            "edge_count": 0,
            "artifact_schema_version": None,
            "input_sha256": input_sha256,
            "audit": {
                "fixture_sha256": None,
                "evaluated_at": as_of_text,
                "actor": "ci:audit-v1",
                "checks": [_check("artifact_parse", "failed", str(exc), "valid JSON object")],
            },
        }

    nodes = data.get("nodes") if isinstance(data.get("nodes"), list) else []
    edges = data.get("edges") if isinstance(data.get("edges"), list) else []
    if not nodes:
        availability = "unavailable"
    elif not edges:
        availability = "sparse"
    elif len(nodes) >= 2:
        availability = "ready"
    else:
        availability = "failed"
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    generated_at = meta.get("generated_at") or data.get("generated_at") or generated_hint
    generated_at = generated_at if isinstance(generated_at, str) else None
    checks, fixture_sha256 = _artifact_checks(
        data,
        kind=kind,
        fixture=fixture,
        input_sha256=input_sha256,
        as_of=as_of,
        generated_at=generated_at,
        catalog_ids=catalog_ids,
        expected_seed_paper_id=expected_seed_paper_id,
    )
    if availability not in {"ready", "failed"}:
        audit_status = "unknown"
    elif availability == "failed" or any(check["status"] == "failed" for check in checks):
        audit_status = "failed"
    elif any(check["status"] == "unknown" for check in checks):
        audit_status = "unknown"
    else:
        audit_status = "passed"
    return {
        "collection_id": collection_id or f"{kind}:{slug}",
        "kind": kind,
        "slug": slug,
        "label": label,
        "path": relative_path,
        "availability": availability,
        "audit_status": audit_status,
        "freshness": _freshness(
            generated_at=generated_at,
            snapshot_date=snapshot_date,
            as_of=as_of,
            max_age_days=max_age_days,
        ),
        "generated_at": generated_at,
        "snapshot_date": snapshot_date,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "artifact_schema_version": data.get("schema_version") or meta.get("schema_version"),
        "input_sha256": input_sha256,
        "audit": {
            "fixture_sha256": fixture_sha256,
            "evaluated_at": as_of_text,
            "actor": "ci:audit-v1",
            "checks": checks,
        },
    }


def _deep_identity_failures(
    *,
    data: object,
    entry: dict[str, Any] | None,
    filename: str,
    artifact_present: bool,
    catalog_arxiv_by_paper: dict[str, str],
    catalog_identity_failures: list[str],
) -> list[str]:
    """Compare one trusted manifest entry with its artifact without inference."""

    if entry is None:
        return ["manifest-entry-missing"]
    failures: list[str] = list(catalog_identity_failures)
    if catalog_arxiv_by_paper.get(entry.get("paper_id")) != entry.get("arxiv_id"):
        failures.append("catalog-paper-arxiv-pair")
    if not artifact_present:
        return ["artifact-missing"]
    if not isinstance(data, dict):
        return ["artifact-unreadable"]
    meta = data.get("meta")
    focus = canonical_focus_node(data)
    aliases = entry.get("aliases")
    semantic_alias = None
    if isinstance(aliases, list):
        semantic_values = [
            alias[1]
            for alias in aliases
            if isinstance(alias, list) and len(alias) == 2 and alias[0] == "semantic_scholar"
        ]
        if len(semantic_values) == 1:
            semantic_alias = semantic_values[0]
    expected = {
        "paper_id": entry.get("paper_id"),
        "arxiv_id": entry.get("arxiv_id"),
        "aliases": aliases,
        "root": semantic_alias,
        "title": entry.get("title"),
        "filename": entry.get("filename"),
    }
    observed = {
        "paper_id": meta.get("seed_paper_id") if isinstance(meta, dict) else None,
        "arxiv_id": meta.get("arxiv_id") if isinstance(meta, dict) else None,
        "aliases": meta.get("aliases") if isinstance(meta, dict) else None,
        "root": data.get("root"),
        "title": focus.get("title") if focus is not None else None,
        "filename": filename,
    }
    for field in expected:
        if observed[field] != expected[field]:
            failures.append(field)
    if focus is None or focus.get("seed_paper_id") != entry.get("paper_id"):
        failures.append("root_focus_seed")
    if focus is None or focus.get("aliases") != aliases:
        failures.append("root_focus_aliases")
    return sorted(set(failures))


def _deep_collection_rows(
    *,
    docs_root: Path,
    conference: str,
    catalog_ids: set[str],
    catalog_arxiv_by_paper: dict[str, str],
    catalog_identity_failures: list[str],
    fixture_map: dict[str, dict[str, Any]],
    as_of: str,
    max_age_days: int,
) -> list[dict[str, Any]]:
    """Collect every deep artifact/reference and audit exact manifest identity."""

    conference_dir = docs_root / conference
    manifest_relative = f"{conference}/deep-manifest.json"
    manifest_path = docs_root / manifest_relative
    manifest_sha256: str | None = None
    manifest: object = None
    manifest_issues: list[str] = []
    try:
        manifest_payload = manifest_path.read_bytes()
        manifest_sha256 = _hash_bytes(manifest_payload)
        manifest = json.loads(manifest_payload)
    except (OSError, json.JSONDecodeError) as exc:
        manifest_issues.append(type(exc).__name__)
    if not manifest_issues:
        manifest_issues.extend(
            f"{issue.code}:{issue.path}"
            for issue in validate_deep_manifest(manifest, catalog_ids=catalog_ids)
        )
        if isinstance(manifest, dict) and manifest.get("conference") != conference:
            manifest_issues.append("manifest_conference_mismatch")

    trusted_entries: dict[str, dict[str, Any]] = {}
    if not manifest_issues and isinstance(manifest, dict):
        for entry in manifest["entries"]:
            trusted_entries[entry["filename"]] = entry

    filenames = {
        path.name
        for path in conference_dir.glob("deep-*.json")
        if path.name != "deep-manifest.json"
    }
    filenames.update(trusted_entries)
    rows: list[dict[str, Any]] = []
    for filename in sorted(filenames):
        entry = trusted_entries.get(filename)
        paper_id = entry.get("paper_id") if entry else None
        collection_id = (
            f"deep:{conference}:{paper_id}"
            if is_paper_id(paper_id)
            else f"deep:{conference}:file:{filename}"
        )
        relative_path = f"{conference}/{filename}"
        artifact_path = docs_root / relative_path
        artifact_present = artifact_path.is_file()
        try:
            artifact_data: object = json.loads(artifact_path.read_bytes())
        except (OSError, json.JSONDecodeError):
            artifact_data = None
        row = _collection_row(
            docs_root=docs_root,
            kind="deep",
            slug=conference,
            label=f"{_label_from_slug(conference)} deep: {entry.get('title') if entry else filename}",
            relative_path=relative_path,
            snapshot_date=None,
            generated_hint=None,
            fixture=fixture_map.get(collection_id),
            as_of_text=as_of,
            max_age_days=max_age_days,
            catalog_ids=catalog_ids,
            collection_id=collection_id,
            expected_seed_paper_id=paper_id if is_paper_id(paper_id) else None,
        )
        identity_failures = (
            ["manifest-invalid", *manifest_issues]
            if manifest_issues
            else _deep_identity_failures(
                data=artifact_data,
                entry=entry,
                filename=filename,
                artifact_present=artifact_present,
                catalog_arxiv_by_paper=catalog_arxiv_by_paper,
                catalog_identity_failures=catalog_identity_failures,
            )
        )
        checks = row["audit"]["checks"]
        checks.extend(
            [
                _check(
                    "deep_manifest_contract",
                    "failed" if manifest_issues else "passed",
                    len(manifest_issues),
                    0,
                    manifest_issues,
                ),
                _check(
                    "deep_manifest_identity",
                    "failed" if identity_failures else "passed",
                    len(identity_failures),
                    0,
                    identity_failures,
                ),
            ]
        )
        row["audit"]["checks"] = sorted(checks, key=lambda check: check["name"])
        if any(check["status"] == "failed" for check in checks):
            row["audit_status"] = "failed"
        row.update(
            {
                "conference": conference,
                "paper_id": paper_id if is_paper_id(paper_id) else None,
                "arxiv_id": entry.get("arxiv_id") if entry else None,
                "manifest_path": manifest_relative,
                "manifest_input_sha256": manifest_sha256,
            }
        )
        rows.append(row)
    return rows


def build_manifest(
    *,
    docs_root: Path,
    as_of: str,
    fixtures: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Build a deterministic quality manifest without using filesystem mtimes."""

    _parse_time(as_of)
    fixture_map = {
        row.get("collection_id"): row
        for row in fixtures.get("collections", [])
        if isinstance(row, dict) and isinstance(row.get("collection_id"), str)
    }
    collections: list[dict[str, Any]] = []
    conferences = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    for conference in conferences:
        slug = conference["name"]
        try:
            catalog = json.loads((docs_root / slug / "papers.json").read_text(encoding="utf-8"))
            (
                conference_catalog_ids,
                catalog_arxiv_by_paper,
                catalog_identity_failures,
            ) = _catalog_identity(catalog)
        except (OSError, json.JSONDecodeError):
            conference_catalog_ids = set()
            catalog_arxiv_by_paper = {}
            catalog_identity_failures = ["catalog-unavailable"]
        collections.append(
            _collection_row(
                docs_root=docs_root,
                kind="conference",
                slug=slug,
                label=_label_from_slug(slug),
                relative_path=f"{slug}/lineage.json",
                snapshot_date=conference.get("generated"),
                generated_hint=None,
                fixture=fixture_map.get(f"conference:{slug}"),
                as_of_text=as_of,
                max_age_days=int(policy["conference_max_age_days"]),
                catalog_ids=conference_catalog_ids,
            )
        )
        collections.extend(
            _deep_collection_rows(
                docs_root=docs_root,
                conference=slug,
                catalog_ids=conference_catalog_ids,
                catalog_arxiv_by_paper=catalog_arxiv_by_paper,
                catalog_identity_failures=catalog_identity_failures,
                fixture_map=fixture_map,
                as_of=as_of,
                max_age_days=int(
                    policy.get("deep_max_age_days", policy["conference_max_age_days"])
                ),
            )
        )
    theme_manifest = json.loads(
        (docs_root / "themes" / "themes-manifest.json").read_text(encoding="utf-8")
    )
    for theme in theme_manifest:
        slug = theme["slug"]
        collections.append(
            _collection_row(
                docs_root=docs_root,
                kind="theme",
                slug=slug,
                label=theme.get("theme") or slug,
                relative_path=f"themes/{slug}/lineage.json",
                snapshot_date=None,
                generated_hint=theme.get("generated_at"),
                fixture=fixture_map.get(f"theme:{slug}"),
                as_of_text=as_of,
                max_age_days=int(policy["theme_max_age_days"]),
                catalog_ids=None,
            )
        )
    return {
        "schema_version": "lineage-quality-v1",
        "as_of": as_of,
        "audit_version": "audit-v1",
        "collections": sorted(collections, key=lambda row: row["collection_id"]),
    }


def _payload(manifest: dict[str, Any]) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-root", type=Path, default=DOCS_ROOT)
    parser.add_argument("--fixtures", type=Path, default=FIXTURES_PATH)
    parser.add_argument("--policy", type=Path, default=POLICY_PATH)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    fixtures = json.loads(args.fixtures.read_text(encoding="utf-8"))
    policy = json.loads(args.policy.read_text(encoding="utf-8"))
    manifest = build_manifest(
        docs_root=args.docs_root,
        as_of=args.as_of,
        fixtures=fixtures,
        policy=policy,
    )
    payload = _payload(manifest)
    if args.check:
        if args.output.read_bytes() != payload:
            raise SystemExit("lineage quality manifest is stale")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_name(f".{args.output.name}.paperpilot-tmp")
        temporary.write_bytes(payload)
        os.replace(temporary, args.output)
    counts: dict[str, int] = {}
    for row in manifest["collections"]:
        key = f"{row['availability']}/{row['audit_status']}"
        counts[key] = counts.get(key, 0) + 1
    print("Lineage quality:", ", ".join(f"{key}={value}" for key, value in sorted(counts.items())))


if __name__ == "__main__":
    main()
