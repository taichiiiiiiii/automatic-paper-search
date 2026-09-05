"""Shared fail-closed contracts for public lineage artifacts.

The helpers in this module are deliberately stdlib-only.  Producers, quality
audits and manifest generators all call the same validator so a JSON Schema
implementation detail cannot create a second interpretation of the wire format.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Literal, NamedTuple

from paperpilot.identity.source_ids import IdentityError, normalize_alias

LINEAGE_ARTIFACT_VERSION = "lineage-artifact-v1"
DEEP_MANIFEST_VERSION = "deep-manifest-v1"
LINEAGE_QUALITY_VERSION = "lineage-quality-v1"

PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ARXIV_ID_RE = re.compile(r"^\d{4}\.\d{4,5}(?:v\d+)?$")
CONFERENCE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
QUALITY_TIMESTAMP_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
QUALITY_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEEP_ARTIFACT_FILENAME_RE = re.compile(r"^deep-[A-Za-z0-9._-]+\.json$")

RELATIONS = frozenset(
    {"supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"}
)
CLASSIFICATION_METHODS = frozenset(
    {
        "llm",
        "citation_heuristic",
        "intent_map",
        "context_pattern",
        "year_cite",
        "title_version",
        "foundational_allowlist",
    }
)
NODE_ALIAS_NAMESPACES = frozenset({"arxiv", "openreview", "acl_anthology", "cvf", "doi"})
LEGACY_NODE_ALIAS_NAMESPACES = frozenset({"semantic_scholar"})


class ContractIssue(NamedTuple):
    """One stable, machine-readable contract failure."""

    code: str
    path: str
    detail: str


def canonical_json_sha256(value: object) -> str:
    """Return the SHA-256 of canonical UTF-8 JSON used by cache/evidence keys."""

    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def is_paper_id(value: object) -> bool:
    return isinstance(value, str) and PAPER_ID_RE.fullmatch(value) is not None


def require_paper_id(value: object, *, field: str = "paper_id") -> str:
    if not is_paper_id(value):
        raise ValueError(f"{field} must be a lowercase 40-hex canonical paper ID")
    return value


def make_provenance(
    *,
    producer_name: str,
    producer_version: str,
    evidence_source: str,
    evidence_kind: str,
    evidence_sha256: str,
    method: str,
    provider: str | None,
    model: str | None,
    prompt_version: str | None,
    classification_schema_version: str,
) -> dict[str, Any]:
    """Build the canonical structured edge provenance object."""

    return {
        "producer": {"name": producer_name, "version": producer_version},
        "evidence": {
            "source": evidence_source,
            "kind": evidence_kind,
            "sha256": evidence_sha256,
        },
        "classification": {
            "method": method,
            "provider": provider,
            "model": model,
            "prompt_version": prompt_version,
            "schema_version": classification_schema_version,
        },
    }


def _nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _has_exact_keys(value: Mapping[str, Any], expected: set[str]) -> bool:
    """Return whether a closed wire object contains exactly its declared fields."""

    return set(value) == expected


def _is_timezone_datetime(value: object) -> bool:
    if not _nonempty(value):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return "T" in value and parsed.tzinfo is not None


def _is_quality_timestamp(value: object) -> bool:
    """Match the browser strict reader's closed timestamp grammar."""

    if not isinstance(value, str) or QUALITY_TIMESTAMP_RE.fullmatch(value) is None:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _is_quality_date(value: object) -> bool:
    if not isinstance(value, str) or QUALITY_DATE_RE.fullmatch(value) is None:
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _node_id(node: object) -> str | None:
    if not isinstance(node, Mapping):
        return None
    value = node.get("id")
    return value if _nonempty(value) else None


def canonical_focus_node(data: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Resolve exactly one declared root focus; never fall back to the first node."""

    root = data.get("root")
    nodes = data.get("nodes")
    if not _nonempty(root) or not isinstance(nodes, list):
        return None
    matches = [
        node
        for node in nodes
        if isinstance(node, Mapping) and node.get("id") == root and node.get("is_focus") is True
    ]
    return matches[0] if len(matches) == 1 else None


def _validate_provenance(value: object, path: str) -> list[ContractIssue]:
    if not isinstance(value, Mapping):
        return [ContractIssue("provenance_shape", path, "structured provenance object required")]

    issues: list[ContractIssue] = []
    if not _has_exact_keys(value, {"producer", "evidence", "classification"}):
        issues.append(
            ContractIssue(
                "provenance_fields",
                path,
                "only producer/evidence/classification are allowed and all are required",
            )
        )
    producer = value.get("producer")
    evidence = value.get("evidence")
    classification = value.get("classification")
    if (
        not isinstance(producer, Mapping)
        or not _nonempty(producer.get("name"))
        or not _nonempty(producer.get("version"))
    ):
        issues.append(
            ContractIssue("provenance_producer", f"{path}.producer", "name/version required")
        )
    elif not _has_exact_keys(producer, {"name", "version"}):
        issues.append(
            ContractIssue(
                "provenance_producer_fields",
                f"{path}.producer",
                "closed name/version object required",
            )
        )
    if (
        not isinstance(evidence, Mapping)
        or not _nonempty(evidence.get("source"))
        or not _nonempty(evidence.get("kind"))
        or not isinstance(evidence.get("sha256"), str)
        or SHA256_RE.fullmatch(evidence["sha256"]) is None
    ):
        issues.append(
            ContractIssue("provenance_evidence", f"{path}.evidence", "source/kind/sha256 required")
        )
    elif not _has_exact_keys(evidence, {"source", "kind", "sha256"}):
        issues.append(
            ContractIssue(
                "provenance_evidence_fields",
                f"{path}.evidence",
                "closed source/kind/sha256 object required",
            )
        )
    if not isinstance(classification, Mapping):
        issues.append(
            ContractIssue(
                "provenance_classification",
                f"{path}.classification",
                "classification object required",
            )
        )
        return issues

    if not _has_exact_keys(
        classification,
        {"method", "provider", "model", "prompt_version", "schema_version"},
    ):
        issues.append(
            ContractIssue(
                "provenance_classification_fields",
                f"{path}.classification",
                "closed classification identity object required",
            )
        )

    method = classification.get("method")
    if method not in CLASSIFICATION_METHODS:
        issues.append(
            ContractIssue(
                "classification_method",
                f"{path}.classification.method",
                "unknown classification method",
            )
        )
    if not _nonempty(classification.get("schema_version")):
        issues.append(
            ContractIssue(
                "classification_schema",
                f"{path}.classification.schema_version",
                "schema version required",
            )
        )
    for field in ("provider", "model", "prompt_version"):
        candidate = classification.get(field)
        if candidate is not None and not _nonempty(candidate):
            issues.append(
                ContractIssue(
                    "classification_identity",
                    f"{path}.classification.{field}",
                    "must be a nonempty string or null",
                )
            )
    if method == "llm":
        for field in ("provider", "model", "prompt_version"):
            if not _nonempty(classification.get(field)):
                issues.append(
                    ContractIssue(
                        "llm_identity",
                        f"{path}.classification.{field}",
                        "LLM provenance requires provider/model/prompt version",
                    )
                )
    return issues


def validate_lineage_artifact(
    data: object,
    *,
    kind: Literal["conference", "theme", "deep"],
    catalog_ids: set[str] | None = None,
    expected_seed_paper_id: str | None = None,
) -> list[ContractIssue]:
    """Validate the shared public lineage contract without raising on JSON input."""

    if not isinstance(data, Mapping):
        return [ContractIssue("artifact_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    if data.get("schema_version") != LINEAGE_ARTIFACT_VERSION:
        issues.append(
            ContractIssue(
                "artifact_schema_version",
                "$.schema_version",
                f"expected {LINEAGE_ARTIFACT_VERSION}",
            )
        )

    nodes = data.get("nodes")
    edges = data.get("edges")
    clusters = data.get("clusters")
    meta = data.get("meta")
    if not isinstance(nodes, list):
        issues.append(ContractIssue("nodes_shape", "$.nodes", "array required"))
        nodes = []
    if not isinstance(edges, list):
        issues.append(ContractIssue("edges_shape", "$.edges", "array required"))
        edges = []
    if not isinstance(clusters, list):
        issues.append(ContractIssue("clusters_shape", "$.clusters", "array required"))
    if not isinstance(meta, Mapping):
        issues.append(ContractIssue("meta_shape", "$.meta", "object required"))
    elif kind == "theme":
        if meta.get("kind") != "theme":
            issues.append(ContractIssue("theme_meta_kind", "$.meta.kind", "theme required"))
        if not _nonempty(meta.get("generator")):
            issues.append(
                ContractIssue(
                    "theme_meta_generator",
                    "$.meta.generator",
                    "nonempty generator required",
                )
            )
        if not _is_timezone_datetime(meta.get("generated_at")):
            issues.append(
                ContractIssue(
                    "theme_meta_generated_at",
                    "$.meta.generated_at",
                    "timezone datetime required",
                )
            )
    if kind == "theme" and isinstance(clusters, list) and clusters:
        issues.append(ContractIssue("theme_clusters", "$.clusters", "theme clusters must be empty"))

    ids: list[str | None] = [_node_id(node) for node in nodes]
    counts: dict[str, int] = {}
    for node_id in ids:
        if node_id is not None:
            counts[node_id] = counts.get(node_id, 0) + 1
    for index, node_id in enumerate(ids):
        if node_id is None:
            issues.append(ContractIssue("node_id", f"$.nodes[{index}].id", "nonempty ID required"))
        elif counts[node_id] != 1:
            issues.append(ContractIssue("node_id_duplicate", f"$.nodes[{index}].id", node_id))
    id_set = set(counts)

    root = data.get("root")
    if nodes:
        if not _nonempty(root):
            issues.append(ContractIssue("root_missing", "$.root", "nonempty graph requires root"))
        elif counts.get(root, 0) != 1:
            issues.append(ContractIssue("root_resolution", "$.root", "root must resolve once"))
    elif root is not None:
        issues.append(ContractIssue("empty_root", "$.root", "empty graph root must be null"))

    focus_seeds: list[str] = []
    aliases_seen: dict[tuple[str, str], int] = {}
    for index, node in enumerate(nodes):
        if not isinstance(node, Mapping):
            issues.append(ContractIssue("node_shape", f"$.nodes[{index}]", "object required"))
            continue
        if not isinstance(node.get("is_focus"), bool):
            issues.append(
                ContractIssue("focus_flag", f"$.nodes[{index}].is_focus", "boolean required")
            )
        if node.get("is_focus") is True:
            seed = node.get("seed_paper_id")
            if not is_paper_id(seed):
                issues.append(
                    ContractIssue(
                        "focus_seed", f"$.nodes[{index}].seed_paper_id", "canonical ID required"
                    )
                )
            elif is_paper_id(seed):
                focus_seeds.append(seed)
                if (
                    kind in {"conference", "deep"}
                    and catalog_ids is not None
                    and seed not in catalog_ids
                ):
                    issues.append(
                        ContractIssue(
                            "catalog_seed_membership",
                            f"$.nodes[{index}].seed_paper_id",
                            seed,
                        )
                    )
        elif "seed_paper_id" in node and not is_paper_id(node.get("seed_paper_id")):
            issues.append(
                ContractIssue(
                    "node_seed",
                    f"$.nodes[{index}].seed_paper_id",
                    "present seed_paper_id must be canonical",
                )
            )
        aliases = node.get("aliases")
        if aliases is None:
            continue
        if not isinstance(aliases, list):
            issues.append(
                ContractIssue("node_aliases", f"$.nodes[{index}].aliases", "array required")
            )
            continue
        node_aliases: set[tuple[str, str]] = set()
        for alias_index, alias in enumerate(aliases):
            alias_path = f"$.nodes[{index}].aliases[{alias_index}]"
            if not (
                isinstance(alias, list)
                and len(alias) == 2
                and all(isinstance(value, str) for value in alias)
            ):
                issues.append(
                    ContractIssue("node_alias_shape", alias_path, "[namespace, source_id] required")
                )
                continue
            namespace, source_id = alias
            normalized: tuple[str, str] | None = None
            if namespace in NODE_ALIAS_NAMESPACES:
                try:
                    candidate = normalize_alias(namespace, source_id)
                except IdentityError:
                    candidate = None
                if candidate == (namespace, source_id):
                    normalized = candidate
            elif (
                namespace in LEGACY_NODE_ALIAS_NAMESPACES
                and kind in {"conference", "deep"}
                and _nonempty(source_id)
                and source_id == source_id.strip()
            ):
                # Existing deep/conference artifacts expose the S2 graph ID as
                # an alias.  Keep it shape-valid for migration compatibility,
                # but consumers must never treat it as a canonical URL alias.
                normalized = (namespace, source_id)
            if normalized is None:
                issues.append(
                    ContractIssue(
                        "node_alias_normalized",
                        alias_path,
                        "known namespace with normalized source ID required",
                    )
                )
                continue
            if normalized in node_aliases:
                issues.append(
                    ContractIssue("node_alias_duplicate", alias_path, ":".join(normalized))
                )
            node_aliases.add(normalized)
            aliases_seen[normalized] = aliases_seen.get(normalized, 0) + 1
    for alias, count in sorted(aliases_seen.items()):
        if count > 1:
            issues.append(ContractIssue("node_alias_ambiguous", "$.nodes", ":".join(alias)))
    duplicate_seeds = {seed for seed in focus_seeds if focus_seeds.count(seed) > 1}
    for seed in sorted(duplicate_seeds):
        issues.append(ContractIssue("focus_seed_duplicate", "$.nodes", seed))

    focus = canonical_focus_node(data)
    if nodes and focus is None:
        issues.append(
            ContractIssue("root_focus", "$.root", "root must resolve to exactly one focus node")
        )
    if expected_seed_paper_id is not None:
        if not is_paper_id(expected_seed_paper_id):
            issues.append(
                ContractIssue("expected_seed", "$", "expected seed is not a canonical paper ID")
            )
        elif focus is None or focus.get("seed_paper_id") != expected_seed_paper_id:
            issues.append(
                ContractIssue("expected_seed_mismatch", "$.root", "root focus seed does not match")
            )

    edge_keys: set[tuple[str, str, str]] = set()
    for index, edge in enumerate(edges):
        path = f"$.edges[{index}]"
        if not isinstance(edge, Mapping):
            issues.append(ContractIssue("edge_shape", path, "object required"))
            continue
        src, dst = edge.get("src"), edge.get("dst")
        if not _nonempty(src) or not _nonempty(dst) or src not in id_set or dst not in id_set:
            issues.append(ContractIssue("edge_endpoint", path, "src/dst must resolve"))
        relation, legacy_relation = edge.get("relation"), edge.get("rel")
        if relation not in RELATIONS:
            issues.append(ContractIssue("edge_relation", f"{path}.relation", "invalid relation"))
        if legacy_relation != relation:
            issues.append(ContractIssue("edge_relation_alias", path, "rel must equal relation"))
        confidence, legacy_confidence = edge.get("confidence"), edge.get("conf")
        valid_confidence = (
            isinstance(confidence, (int, float))
            and not isinstance(confidence, bool)
            and 0 <= confidence <= 1
        )
        if not valid_confidence:
            issues.append(
                ContractIssue("edge_confidence", f"{path}.confidence", "number in [0,1] required")
            )
        if legacy_confidence != confidence:
            issues.append(
                ContractIssue("edge_confidence_alias", path, "conf must equal confidence")
            )
        if not _nonempty(edge.get("rationale")):
            issues.append(ContractIssue("edge_rationale", f"{path}.rationale", "nonempty required"))
        issues.extend(_validate_provenance(edge.get("provenance"), f"{path}.provenance"))
        if _nonempty(src) and _nonempty(dst) and isinstance(relation, str):
            key = (src, dst, relation)
            if key in edge_keys:
                issues.append(ContractIssue("edge_duplicate", path, "duplicate edge"))
            edge_keys.add(key)

    ordered_node_ids = [node_id for node_id in ids if node_id is not None]
    if len(ordered_node_ids) == len(nodes) and ordered_node_ids != sorted(ordered_node_ids):
        issues.append(
            ContractIssue("node_order", "$.nodes", "nodes must be sorted by graph-local ID")
        )
    ordered_edge_keys = [
        (edge.get("src"), edge.get("dst"), edge.get("relation"))
        for edge in edges
        if isinstance(edge, Mapping)
        and _nonempty(edge.get("src"))
        and _nonempty(edge.get("dst"))
        and isinstance(edge.get("relation"), str)
    ]
    if len(ordered_edge_keys) == len(edges) and ordered_edge_keys != sorted(ordered_edge_keys):
        issues.append(
            ContractIssue(
                "edge_order",
                "$.edges",
                "edges must be sorted by src/dst/relation",
            )
        )

    focus_ids = sorted(
        node["id"]
        for node in nodes
        if isinstance(node, Mapping) and _nonempty(node.get("id")) and node.get("is_focus") is True
    )
    if focus_ids and isinstance(root, str):
        degree: dict[str, int] = {}
        for edge in edges:
            if not isinstance(edge, Mapping):
                continue
            src, dst = edge.get("src"), edge.get("dst")
            if isinstance(src, str) and isinstance(dst, str) and src in id_set and dst in id_set:
                degree[src] = degree.get(src, 0) + 1
                degree[dst] = degree.get(dst, 0) + 1
        expected_root = min(
            focus_ids,
            key=lambda node_id: (-degree.get(node_id, 0), node_id),
        )
        if root != expected_root:
            issues.append(
                ContractIssue(
                    "root_deterministic",
                    "$.root",
                    f"expected highest-degree focus {expected_root}",
                )
            )

    return sorted(set(issues), key=lambda issue: (issue.code, issue.path, issue.detail))


def catalog_paper_ids(rows: object) -> set[str]:
    if not isinstance(rows, list):
        return set()
    return {
        row["paper_id"]
        for row in rows
        if isinstance(row, Mapping) and is_paper_id(row.get("paper_id"))
    }


def validate_deep_manifest(
    data: object,
    *,
    catalog_ids: set[str] | None = None,
) -> list[ContractIssue]:
    """Validate deep-manifest-v1 identity and filename uniqueness."""

    if not isinstance(data, Mapping):
        return [ContractIssue("manifest_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    if not _has_exact_keys(data, {"schema_version", "conference", "generated_at", "entries"}):
        issues.append(
            ContractIssue(
                "manifest_fields",
                "$",
                "only schema_version/conference/generated_at/entries are allowed",
            )
        )
    if data.get("schema_version") != DEEP_MANIFEST_VERSION:
        issues.append(
            ContractIssue(
                "manifest_schema_version",
                "$.schema_version",
                f"expected {DEEP_MANIFEST_VERSION}",
            )
        )
    conference = data.get("conference")
    if not isinstance(conference, str) or CONFERENCE_SLUG_RE.fullmatch(conference) is None:
        issues.append(ContractIssue("manifest_conference", "$.conference", "valid slug required"))
    if not _is_timezone_datetime(data.get("generated_at")):
        issues.append(
            ContractIssue("manifest_generated_at", "$.generated_at", "timezone datetime required")
        )
    entries = data.get("entries")
    if not isinstance(entries, list):
        issues.append(ContractIssue("manifest_entries", "$.entries", "array required"))
        return sorted(issues)

    paper_ids: list[str] = []
    aliases_seen: dict[tuple[str, str], int] = {}
    filenames: list[str] = []
    for index, entry in enumerate(entries):
        path = f"$.entries[{index}]"
        if not isinstance(entry, Mapping):
            issues.append(ContractIssue("manifest_entry", path, "object required"))
            continue
        if not _has_exact_keys(
            entry,
            {"paper_id", "aliases", "arxiv_id", "title", "filename"},
        ):
            issues.append(
                ContractIssue(
                    "manifest_entry_fields",
                    path,
                    "closed paper_id/aliases/arxiv_id/title/filename object required",
                )
            )
        paper_id = entry.get("paper_id")
        if not is_paper_id(paper_id):
            issues.append(ContractIssue("manifest_paper_id", f"{path}.paper_id", "invalid"))
        else:
            paper_ids.append(paper_id)
            if catalog_ids is not None and paper_id not in catalog_ids:
                issues.append(
                    ContractIssue("manifest_catalog_membership", f"{path}.paper_id", paper_id)
                )
        arxiv_id = entry.get("arxiv_id")
        if not isinstance(arxiv_id, str) or ARXIV_ID_RE.fullmatch(arxiv_id) is None:
            issues.append(ContractIssue("manifest_arxiv", f"{path}.arxiv_id", "invalid"))
        filename = entry.get("filename")
        expected_filename = f"deep-{arxiv_id}.json" if isinstance(arxiv_id, str) else None
        if filename != expected_filename:
            issues.append(
                ContractIssue("manifest_filename", f"{path}.filename", "must match arxiv_id")
            )
        elif isinstance(filename, str):
            filenames.append(filename)
        aliases = entry.get("aliases")
        expected_kinds = {"arxiv", "semantic_scholar"}
        alias_map: dict[str, str] = {}
        if not isinstance(aliases, list):
            issues.append(ContractIssue("manifest_aliases", f"{path}.aliases", "array required"))
        else:
            for alias_index, alias in enumerate(aliases):
                if (
                    not isinstance(alias, list)
                    or len(alias) != 2
                    or alias[0] not in expected_kinds
                    or not _nonempty(alias[1])
                ):
                    issues.append(
                        ContractIssue(
                            "manifest_alias",
                            f"{path}.aliases[{alias_index}]",
                            "[known namespace, nonempty value] required",
                        )
                    )
                    continue
                kind, value = alias
                if kind in alias_map:
                    issues.append(
                        ContractIssue("manifest_alias_kind_duplicate", f"{path}.aliases", kind)
                    )
                alias_map[kind] = value
                aliases_seen[(kind, value)] = aliases_seen.get((kind, value), 0) + 1
            if set(alias_map) != expected_kinds:
                issues.append(
                    ContractIssue(
                        "manifest_alias_kinds",
                        f"{path}.aliases",
                        "arxiv and semantic_scholar required",
                    )
                )
            if isinstance(arxiv_id, str) and alias_map.get("arxiv") != arxiv_id:
                issues.append(
                    ContractIssue("manifest_arxiv_alias", f"{path}.aliases", "arxiv mismatch")
                )
        if not _nonempty(entry.get("title")):
            issues.append(ContractIssue("manifest_title", f"{path}.title", "nonempty required"))

    for paper_id in sorted({value for value in paper_ids if paper_ids.count(value) > 1}):
        issues.append(ContractIssue("manifest_paper_duplicate", "$.entries", paper_id))
    for filename in sorted({value for value in filenames if filenames.count(value) > 1}):
        issues.append(ContractIssue("manifest_filename_duplicate", "$.entries", filename))
    for alias, count in sorted(aliases_seen.items()):
        if count > 1:
            issues.append(
                ContractIssue("manifest_alias_duplicate", "$.entries", f"{alias[0]}:{alias[1]}")
            )
    return sorted(set(issues), key=lambda issue: (issue.code, issue.path, issue.detail))


_QUALITY_ROW_KEYS = {
    "collection_id",
    "kind",
    "slug",
    "label",
    "path",
    "availability",
    "audit_status",
    "freshness",
    "generated_at",
    "snapshot_date",
    "node_count",
    "edge_count",
    "artifact_schema_version",
    "input_sha256",
    "audit",
}
_QUALITY_DEEP_KEYS = {
    "conference",
    "paper_id",
    "arxiv_id",
    "manifest_path",
    "manifest_input_sha256",
}
_QUALITY_AUDIT_KEYS = {"fixture_sha256", "evaluated_at", "actor", "checks"}
_QUALITY_CHECK_KEYS = {"name", "status", "observed", "expected", "evidence"}


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def validate_lineage_quality_manifest(data: object) -> list[ContractIssue]:
    """Validate the exact quality read model consumed by ``lineage-core.js``.

    This is intentionally stricter than JSON Schema alone: row and check
    ordering, uniqueness, audit-status consistency and kind/path identity are
    publication semantics.  Any issue rejects the manifest as a whole so the
    Python sitemap and browser consumers share one fail-closed decision.
    """

    if not isinstance(data, Mapping):
        return [ContractIssue("quality_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    if not _has_exact_keys(data, {"schema_version", "as_of", "audit_version", "collections"}):
        issues.append(ContractIssue("quality_fields", "$", "closed top-level object required"))
    if data.get("schema_version") != LINEAGE_QUALITY_VERSION:
        issues.append(
            ContractIssue(
                "quality_schema_version",
                "$.schema_version",
                f"expected {LINEAGE_QUALITY_VERSION}",
            )
        )
    if data.get("audit_version") != "audit-v1":
        issues.append(
            ContractIssue("quality_audit_version", "$.audit_version", "expected audit-v1")
        )
    if not _is_quality_timestamp(data.get("as_of")):
        issues.append(
            ContractIssue("quality_as_of", "$.as_of", "strict timezone datetime required")
        )
    collections = data.get("collections")
    if not isinstance(collections, list):
        issues.append(ContractIssue("quality_collections", "$.collections", "array required"))
        return sorted(set(issues))

    previous_id: str | None = None
    paths: set[str] = set()
    for index, row in enumerate(collections):
        path = f"$.collections[{index}]"
        if not isinstance(row, Mapping):
            issues.append(ContractIssue("quality_row_shape", path, "object required"))
            continue
        kind = row.get("kind")
        expected_keys = _QUALITY_ROW_KEYS | (_QUALITY_DEEP_KEYS if kind == "deep" else set())
        if not _has_exact_keys(row, expected_keys):
            issues.append(ContractIssue("quality_row_fields", path, "closed row object required"))

        collection_id = row.get("collection_id")
        slug = row.get("slug")
        artifact_path = row.get("path")
        if not _nonempty(collection_id):
            issues.append(
                ContractIssue("quality_collection_id", f"{path}.collection_id", "nonempty required")
            )
        if kind not in {"conference", "theme", "deep"}:
            issues.append(ContractIssue("quality_kind", f"{path}.kind", "closed kind required"))
        if not isinstance(slug, str) or CONFERENCE_SLUG_RE.fullmatch(slug) is None:
            issues.append(ContractIssue("quality_slug", f"{path}.slug", "strict slug required"))
        if not _nonempty(row.get("label")):
            issues.append(ContractIssue("quality_label", f"{path}.label", "nonempty required"))
        if not _nonempty(artifact_path):
            issues.append(ContractIssue("quality_path", f"{path}.path", "nonempty required"))
        if row.get("availability") not in {"unavailable", "sparse", "ready", "failed"}:
            issues.append(
                ContractIssue(
                    "quality_availability", f"{path}.availability", "closed enum required"
                )
            )
        if row.get("audit_status") not in {"unknown", "passed", "failed"}:
            issues.append(
                ContractIssue(
                    "quality_audit_status", f"{path}.audit_status", "closed enum required"
                )
            )
        if row.get("freshness") not in {"fresh", "stale"}:
            issues.append(
                ContractIssue("quality_freshness", f"{path}.freshness", "closed enum required")
            )
        generated_at = row.get("generated_at")
        if generated_at is not None and not _is_quality_timestamp(generated_at):
            issues.append(ContractIssue("quality_generated_at", f"{path}.generated_at", "invalid"))
        snapshot_date = row.get("snapshot_date")
        if snapshot_date is not None and not _is_quality_date(snapshot_date):
            issues.append(
                ContractIssue("quality_snapshot_date", f"{path}.snapshot_date", "invalid")
            )
        for field in ("node_count", "edge_count"):
            value = row.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                issues.append(
                    ContractIssue(
                        f"quality_{field}", f"{path}.{field}", "non-negative integer required"
                    )
                )
        artifact_version = row.get("artifact_schema_version")
        if artifact_version is not None and not isinstance(artifact_version, str):
            issues.append(
                ContractIssue(
                    "quality_artifact_version",
                    f"{path}.artifact_schema_version",
                    "string or null required",
                )
            )
        input_sha256 = row.get("input_sha256")
        if input_sha256 is not None and not _is_sha256(input_sha256):
            issues.append(
                ContractIssue(
                    "quality_input_sha256", f"{path}.input_sha256", "sha256 or null required"
                )
            )

        if isinstance(collection_id, str):
            if previous_id is not None and previous_id >= collection_id:
                issues.append(
                    ContractIssue(
                        "quality_collection_order",
                        "$.collections",
                        "strict ascending unique IDs required",
                    )
                )
            previous_id = collection_id
        if isinstance(artifact_path, str):
            if artifact_path in paths:
                issues.append(
                    ContractIssue("quality_path_duplicate", "$.collections", artifact_path)
                )
            paths.add(artifact_path)

        if kind == "conference" and isinstance(slug, str):
            if collection_id != f"conference:{slug}" or artifact_path != f"{slug}/lineage.json":
                issues.append(
                    ContractIssue("quality_conference_identity", path, "kind/slug/path mismatch")
                )
        elif kind == "theme" and isinstance(slug, str):
            if collection_id != f"theme:{slug}" or artifact_path != f"themes/{slug}/lineage.json":
                issues.append(
                    ContractIssue("quality_theme_identity", path, "kind/slug/path mismatch")
                )
        elif kind == "deep" and isinstance(slug, str):
            conference = row.get("conference")
            paper_id = row.get("paper_id")
            arxiv_id = row.get("arxiv_id")
            manifest_sha256 = row.get("manifest_input_sha256")
            deep_valid = (
                conference == slug
                and isinstance(conference, str)
                and CONFERENCE_SLUG_RE.fullmatch(conference) is not None
                and isinstance(collection_id, str)
                and collection_id.startswith(f"deep:{conference}:")
                and len(collection_id) > len(f"deep:{conference}:")
                and (paper_id is None or is_paper_id(paper_id))
                and (
                    arxiv_id is None
                    or (isinstance(arxiv_id, str) and ARXIV_ID_RE.fullmatch(arxiv_id) is not None)
                )
                and row.get("manifest_path") == f"{conference}/deep-manifest.json"
                and (manifest_sha256 is None or _is_sha256(manifest_sha256))
                and isinstance(artifact_path, str)
                and artifact_path.startswith(f"{conference}/")
                and DEEP_ARTIFACT_FILENAME_RE.fullmatch(artifact_path[len(conference) + 1 :])
                is not None
            )
            if not deep_valid:
                issues.append(
                    ContractIssue("quality_deep_identity", path, "deep identity/path mismatch")
                )
            if (
                row.get("availability") == "ready"
                and row.get("audit_status") == "passed"
                and (
                    not is_paper_id(paper_id)
                    or not (
                        isinstance(arxiv_id, str) and ARXIV_ID_RE.fullmatch(arxiv_id) is not None
                    )
                    or not _is_sha256(input_sha256)
                    or not _is_sha256(manifest_sha256)
                )
            ):
                issues.append(
                    ContractIssue(
                        "quality_deep_passed_fields",
                        path,
                        "passed deep identity and hashes required",
                    )
                )

        audit = row.get("audit")
        statuses: list[str] = []
        check_names: set[str] = set()
        audit_valid = isinstance(audit, Mapping)
        if not audit_valid:
            issues.append(ContractIssue("quality_audit_shape", f"{path}.audit", "object required"))
        else:
            if not _has_exact_keys(audit, _QUALITY_AUDIT_KEYS):
                issues.append(
                    ContractIssue(
                        "quality_audit_fields", f"{path}.audit", "closed audit object required"
                    )
                )
            fixture_sha = audit.get("fixture_sha256")
            if fixture_sha is not None and not _is_sha256(fixture_sha):
                issues.append(
                    ContractIssue(
                        "quality_fixture_sha256", f"{path}.audit.fixture_sha256", "invalid"
                    )
                )
            if not _is_quality_timestamp(audit.get("evaluated_at")):
                issues.append(
                    ContractIssue("quality_evaluated_at", f"{path}.audit.evaluated_at", "invalid")
                )
            if audit.get("actor") != "ci:audit-v1":
                issues.append(
                    ContractIssue("quality_actor", f"{path}.audit.actor", "expected ci:audit-v1")
                )
            checks = audit.get("checks")
            if not isinstance(checks, list):
                issues.append(
                    ContractIssue("quality_checks", f"{path}.audit.checks", "array required")
                )
            else:
                previous_name: str | None = None
                for check_index, check in enumerate(checks):
                    check_path = f"{path}.audit.checks[{check_index}]"
                    if not isinstance(check, Mapping):
                        issues.append(
                            ContractIssue("quality_check_shape", check_path, "object required")
                        )
                        continue
                    if not _has_exact_keys(check, _QUALITY_CHECK_KEYS):
                        issues.append(
                            ContractIssue(
                                "quality_check_fields", check_path, "closed check object required"
                            )
                        )
                    name = check.get("name")
                    status = check.get("status")
                    evidence = check.get("evidence")
                    if not _nonempty(name):
                        issues.append(
                            ContractIssue(
                                "quality_check_name", f"{check_path}.name", "nonempty required"
                            )
                        )
                    elif isinstance(name, str):
                        if previous_name is not None and previous_name >= name:
                            issues.append(
                                ContractIssue(
                                    "quality_check_order",
                                    f"{path}.audit.checks",
                                    "strict ascending unique names required",
                                )
                            )
                        previous_name = name
                        check_names.add(name)
                    if status not in {"unknown", "passed", "failed"}:
                        issues.append(
                            ContractIssue(
                                "quality_check_status",
                                f"{check_path}.status",
                                "closed enum required",
                            )
                        )
                    elif isinstance(status, str):
                        statuses.append(status)
                    if (
                        not isinstance(evidence, list)
                        or len(evidence) > 20
                        or not all(isinstance(item, str) for item in evidence)
                    ):
                        issues.append(
                            ContractIssue(
                                "quality_check_evidence",
                                f"{check_path}.evidence",
                                "at most 20 strings required",
                            )
                        )

        audit_status = row.get("audit_status")
        if audit_status == "passed" and (
            not statuses or any(status != "passed" for status in statuses)
        ):
            issues.append(
                ContractIssue(
                    "quality_audit_consistency",
                    f"{path}.audit_status",
                    "passed requires only passed checks",
                )
            )
        if audit_status == "failed" and "failed" not in statuses:
            issues.append(
                ContractIssue(
                    "quality_audit_consistency",
                    f"{path}.audit_status",
                    "failed requires a failed check",
                )
            )
        if row.get("availability") == "ready" and audit_status == "passed":
            fixture_sha = audit.get("fixture_sha256") if isinstance(audit, Mapping) else None
            if (
                artifact_version != LINEAGE_ARTIFACT_VERSION
                or not _is_sha256(input_sha256)
                or not _is_sha256(fixture_sha)
                or "artifact_contract_v1" not in check_names
                or "golden_fixture" not in check_names
            ):
                issues.append(
                    ContractIssue(
                        "quality_passed_contract",
                        path,
                        "passed artifact and fixture contract required",
                    )
                )

    return sorted(set(issues), key=lambda issue: (issue.code, issue.path, issue.detail))
