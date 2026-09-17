"""Strict, fail-closed contracts for lineage v2 artifacts and release quality.

This module intentionally does not import or coerce the v1 contract.  All three
validators are stdlib-only so producers and browser-facing manifest builders can
share one interpretation before publication.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from collections.abc import Iterator, Mapping
from datetime import date, datetime, timezone
from pathlib import PurePosixPath
from typing import Any, NamedTuple, cast
from urllib.parse import urlparse

from paperpilot.identity.source_ids import IdentityError, normalize_alias
from paperpilot.replay import canonical_json_sha256

ARTIFACT_VERSION = "lineage-artifact-v2"
FIXTURE_VERSION = "lineage-audit-fixtures-v2"
QUALITY_VERSION = "lineage-quality-v2"
RELEASE_PROFILES = frozenset({"claim-verified-pilot-v1", "automated-calibrated-v1"})
DECISIONS = frozenset({"accepted", "unknown", "abstained", "rejected"})
TRUST_TIERS = frozenset({"verified", "corroborated", "tentative"})
GENEALOGY = frozenset({"supersedes", "successor", "extends"})
COMPARISON = frozenset({"ablation", "baseline_only", "contrasts"})
RELATIONS = GENEALOGY | COMPARISON
CLASSIFICATION_METHODS = frozenset(
    {
        "human_review",
        "llm",
        "citation_heuristic",
        "intent_map",
        "context_pattern",
        "year_cite",
        "title_version",
        "foundational_allowlist",
    }
)
ALIAS_NAMESPACES = frozenset({"arxiv", "openreview", "acl_anthology", "cvf", "doi"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[a-z]+:[A-Za-z0-9._:-]+$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_JSON_DEPTH = 64
MAX_JSON_VALUES = 100_000
MAX_NODES = 10_000
MAX_LINKS = 50_000
MAX_EVIDENCE = 50_000
MAX_CLAIMS = 50_000
MAX_BOUND_BYTES = 64 * 1024 * 1024
MAX_STRING_BYTES = 1024 * 1024
MAX_INTEGER_BITS = 256


class ContractIssue(NamedTuple):
    """One stable, machine-readable contract failure."""

    code: str
    path: str
    detail: str


def _issue(code: str, path: str, detail: str) -> ContractIssue:
    return ContractIssue(code, path, detail)


def _exact(value: object, keys: set[str]) -> bool:
    return isinstance(value, Mapping) and set(value) == keys


def _text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _nullable_text(value: object) -> bool:
    return value is None or _text(value)


def _nonnegative_int(value: object) -> bool:
    return type(value) is int and value >= 0


def _unit_number(value: object, *, nullable: bool = True) -> bool:
    if nullable and value is None:
        return True
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    if not 0 <= value <= 1:
        return False
    return not isinstance(value, float) or math.isfinite(value)


def _text_list(value: object, *, nonempty: bool = False) -> bool:
    return (
        isinstance(value, list)
        and (not nonempty or bool(value))
        and all(_text(item) for item in value)
        and len(value) == len(set(value))
    )


def _safe_relative_json_path(value: object) -> bool:
    if not isinstance(value, str) or not value.endswith(".json"):
        return False
    if value.startswith("/") or "\\" in value or re.match(r"^[A-Za-z]:", value):
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    segments = value.split("/")
    if any(segment in {"", ".", ".."} or segment.lower() == ".git" for segment in segments):
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and str(path) == value


def _bounded_json(value: object) -> bool:
    """Return whether a value is finite, acyclic, bounded JSON data."""

    stack: list[tuple[object, int]] = [(value, 0)]
    seen_containers: set[int] = set()
    value_count = 0
    while stack:
        item, depth = stack.pop()
        value_count += 1
        if value_count > MAX_JSON_VALUES or depth > MAX_JSON_DEPTH:
            return False
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, str):
            try:
                encoded = item.encode("utf-8")
            except UnicodeEncodeError:
                return False
            if len(encoded) > MAX_STRING_BYTES:
                return False
            continue
        if isinstance(item, int):
            if item.bit_length() > MAX_INTEGER_BITS:
                return False
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                return False
            continue
        if isinstance(item, (list, Mapping)):
            identity = id(item)
            if identity in seen_containers:
                return False
            seen_containers.add(identity)
            if isinstance(item, Mapping):
                if not all(isinstance(key, str) for key in item):
                    return False
                stack.extend((nested, depth + 1) for nested in item.values())
            else:
                stack.extend((nested, depth + 1) for nested in item)
            continue
        return False
    return True


def _sha(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _timestamp(value: object) -> bool:
    if not isinstance(value, str) or "T" not in value:
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _date_or_timestamp(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if "T" in value:
        return _timestamp(value)
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _date_key(value: object) -> datetime | None:
    if not isinstance(value, str) or not _date_or_timestamp(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _unique_ids(values: object, path: str, prefix: str) -> tuple[set[str], list[ContractIssue]]:
    issues: list[ContractIssue] = []
    if not isinstance(values, list):
        return set(), [_issue(f"{prefix}_shape", path, "array required")]
    ids: list[str] = []
    for index, value in enumerate(values):
        item_id = value.get("id") if isinstance(value, Mapping) else None
        if not _text(item_id):
            issues.append(_issue(f"{prefix}_id", f"{path}[{index}].id", "non-empty id required"))
        else:
            assert isinstance(item_id, str)
            ids.append(item_id)
    for item_id, count in Counter(ids).items():
        if count > 1:
            issues.append(_issue(f"{prefix}_duplicate", path, f"duplicate id: {item_id}"))
    return set(ids), issues


def validate_lineage_artifact_v2(
    data: object,
    *,
    kind: str | None = None,
    catalog_ids: set[str] | None = None,
) -> list[ContractIssue]:
    """Validate one v2 artifact without repairing, defaulting, or reading v1."""

    if not _bounded_json(data):
        return [_issue("artifact_bounds", "$", "finite bounded acyclic JSON required")]
    if not isinstance(data, Mapping):
        return [_issue("artifact_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    top = {
        "schema_version",
        "release_id",
        "root",
        "nodes",
        "links",
        "evidence",
        "claims",
        "clusters",
        "meta",
    }
    if not _exact(data, top):
        issues.append(_issue("artifact_fields", "$", "closed v2 top-level object required"))
    if data.get("schema_version") != ARTIFACT_VERSION:
        issues.append(_issue("artifact_schema_version", "$.schema_version", ARTIFACT_VERSION))
    if not _text(data.get("release_id")):
        issues.append(_issue("release_id", "$.release_id", "immutable release id required"))

    nodes = data.get("nodes")
    links = data.get("links")
    evidence = data.get("evidence")
    claims = data.get("claims")
    bounded_arrays = (
        (nodes, MAX_NODES, "nodes"),
        (links, MAX_LINKS, "links"),
        (evidence, MAX_EVIDENCE, "evidence"),
        (claims, MAX_CLAIMS, "claims"),
    )
    oversized = False
    for value, maximum, name in bounded_arrays:
        if isinstance(value, list) and len(value) > maximum:
            issues.append(_issue(f"{name}_limit", f"$.{name}", f"at most {maximum} records"))
            oversized = True
    if oversized:
        return issues
    node_ids, node_id_issues = _unique_ids(nodes, "$.nodes", "node")
    _, link_id_issues = _unique_ids(links, "$.links", "link")
    evidence_ids, evidence_id_issues = _unique_ids(evidence, "$.evidence", "evidence")
    _, claim_id_issues = _unique_ids(claims, "$.claims", "claim")
    issues += node_id_issues + link_id_issues + evidence_id_issues + claim_id_issues

    node_dates: dict[str, datetime] = {}
    focus_nodes: list[Mapping[str, Any]] = []
    alias_owners: dict[tuple[str, str], str] = {}
    if isinstance(nodes, list):
        node_keys = {"id", "title", "first_published_at", "is_focus", "seed_paper_id", "aliases"}
        for i, node in enumerate(nodes):
            path = f"$.nodes[{i}]"
            if not _exact(node, node_keys):
                issues.append(_issue("node_fields", path, "closed node object required"))
                continue
            if not _text(node["id"]):
                issues.append(_issue("node_id", f"{path}.id", "non-empty id required"))
            if not _text(node["title"]):
                issues.append(_issue("node_title", f"{path}.title", "non-empty title required"))
            when = _date_key(node["first_published_at"])
            if when is None:
                issues.append(
                    _issue(
                        "node_first_published",
                        f"{path}.first_published_at",
                        "ISO date/time required",
                    )
                )
            elif _text(node["id"]):
                node_dates[node["id"]] = when
            if not isinstance(node["is_focus"], bool):
                issues.append(_issue("node_focus", f"{path}.is_focus", "boolean required"))
            if node["is_focus"] is True:
                focus_nodes.append(node)
                if (
                    not isinstance(node["seed_paper_id"], str)
                    or PAPER_ID_RE.fullmatch(node["seed_paper_id"]) is None
                ):
                    issues.append(
                        _issue(
                            "focus_seed", f"{path}.seed_paper_id", "canonical 40-hex id required"
                        )
                    )
                elif catalog_ids is not None and node["seed_paper_id"] not in catalog_ids:
                    issues.append(
                        _issue(
                            "catalog_seed_membership",
                            f"{path}.seed_paper_id",
                            "seed absent from catalog",
                        )
                    )
            elif node["seed_paper_id"] is not None:
                issues.append(
                    _issue(
                        "nonfocus_seed", f"{path}.seed_paper_id", "only focus node may carry seed"
                    )
                )
            if not isinstance(node["aliases"], list):
                issues.append(_issue("aliases_shape", f"{path}.aliases", "array required"))
            else:
                for j, alias in enumerate(node["aliases"]):
                    if not (
                        isinstance(alias, list) and len(alias) == 2 and all(_text(x) for x in alias)
                    ):
                        issues.append(
                            _issue(
                                "alias_shape", f"{path}.aliases[{j}]", "[namespace,value] required"
                            )
                        )
                        continue
                    alias_key = (alias[0], alias[1])
                    if alias[0] not in ALIAS_NAMESPACES:
                        issues.append(
                            _issue(
                                "alias_namespace",
                                f"{path}.aliases[{j}]",
                                "unknown canonical namespace",
                            )
                        )
                    else:
                        try:
                            normalized = normalize_alias(alias[0], alias[1])
                        except IdentityError:
                            issues.append(
                                _issue(
                                    "alias_value", f"{path}.aliases[{j}]", "invalid canonical alias"
                                )
                            )
                        else:
                            if normalized != alias_key:
                                issues.append(
                                    _issue(
                                        "alias_not_canonical",
                                        f"{path}.aliases[{j}]",
                                        "alias must already be normalized",
                                    )
                                )
                    if alias_key in alias_owners and alias_owners[alias_key] == node["id"]:
                        issues.append(
                            _issue("alias_duplicate", f"{path}.aliases[{j}]", "duplicate alias")
                        )
                    owner = alias_owners.setdefault(
                        alias_key, node["id"] if _text(node["id"]) else path
                    )
                    if _text(node["id"]) and owner != node["id"]:
                        issues.append(
                            _issue(
                                "alias_conflict", f"{path}.aliases[{j}]", f"also owned by {owner}"
                            )
                        )

    root = data.get("root")
    if root is None and node_ids:
        issues.append(_issue("root_missing", "$.root", "non-empty artifact requires a root"))
    elif root is not None and (not _text(root) or root not in node_ids):
        issues.append(_issue("root_resolution", "$.root", "root must resolve exactly"))
    root_focus = [n for n in focus_nodes if n.get("id") == root]
    if node_ids and len(root_focus) != 1:
        issues.append(_issue("root_focus", "$.root", "root must be the unique focus node"))
    if node_ids and len(focus_nodes) != 1:
        issues.append(_issue("focus_count", "$.nodes", "exactly one focus node required"))

    evidence_by_id: dict[str, Mapping[str, Any]] = {}
    if isinstance(evidence, list):
        ev_keys = {
            "id",
            "source",
            "kind",
            "source_work_id",
            "cited_work_id",
            "citing_work_id",
            "url",
            "locator",
            "excerpt",
            "excerpt_sha256",
            "input_sha256",
            "retrieved_at",
            "snapshot_ref",
        }
        locator_keys = {
            "page",
            "section",
            "reference_marker",
            "sentence_ordinal",
            "paragraph_ordinal",
        }
        for i, item in enumerate(evidence):
            path = f"$.evidence[{i}]"
            if not _exact(item, ev_keys):
                issues.append(_issue("evidence_fields", path, "closed evidence object required"))
                continue
            if not _text(item["id"]):
                issues.append(_issue("evidence_id", f"{path}.id", "non-empty id required"))
            else:
                evidence_by_id[item["id"]] = item
            for key in ("source", "kind", "source_work_id", "url", "snapshot_ref"):
                if not _text(item[key]):
                    issues.append(
                        _issue("evidence_identity", f"{path}.{key}", "non-empty value required")
                    )
            try:
                parsed_url = urlparse(item["url"]) if isinstance(item["url"], str) else None
            except ValueError:
                # Hostile bracketed/NFKC authorities are validation failures,
                # not exceptions that escape the closed artifact boundary.
                parsed_url = None
            if (
                parsed_url is None
                or parsed_url.scheme not in {"https", "http"}
                or not parsed_url.netloc
            ):
                issues.append(
                    _issue("evidence_url", f"{path}.url", "absolute primary HTTP(S) URL required")
                )
            if (
                not _text(item["cited_work_id"])
                or not _text(item["citing_work_id"])
                or item["cited_work_id"] not in node_ids
                or item["citing_work_id"] not in node_ids
                or item["cited_work_id"] == item["citing_work_id"]
            ):
                issues.append(
                    _issue("evidence_endpoint_binding", path, "cited and citing work ids required")
                )
            locator = item["locator"]
            locator_types_valid = _exact(locator, locator_keys) and (
                (locator["page"] is None or (type(locator["page"]) is int and locator["page"] >= 1))
                and (locator["section"] is None or _text(locator["section"]))
                and (locator["reference_marker"] is None or _text(locator["reference_marker"]))
                and (
                    locator["sentence_ordinal"] is None
                    or (
                        type(locator["sentence_ordinal"]) is int
                        and locator["sentence_ordinal"] >= 0
                    )
                )
                and (
                    locator["paragraph_ordinal"] is None
                    or (
                        type(locator["paragraph_ordinal"]) is int
                        and locator["paragraph_ordinal"] >= 0
                    )
                )
            )
            if not locator_types_valid or not any(value is not None for value in locator.values()):
                issues.append(
                    _issue(
                        "evidence_locator", f"{path}.locator", "closed, non-empty locator required"
                    )
                )
            excerpt = item["excerpt"]
            if not _text(excerpt) or len(excerpt) > 280:
                issues.append(
                    _issue("evidence_excerpt", f"{path}.excerpt", "1..280 chars required")
                )
            elif item["excerpt_sha256"] != hashlib.sha256(excerpt.encode("utf-8")).hexdigest():
                issues.append(
                    _issue(
                        "evidence_excerpt_hash",
                        f"{path}.excerpt_sha256",
                        "must hash exact UTF-8 excerpt",
                    )
                )
            if not _sha(item["input_sha256"]):
                issues.append(
                    _issue("evidence_input_hash", f"{path}.input_sha256", "sha256 required")
                )
            if not _timestamp(item["retrieved_at"]):
                issues.append(
                    _issue(
                        "evidence_retrieved_at",
                        f"{path}.retrieved_at",
                        "timezone timestamp required",
                    )
                )

    connected_nodes: set[str] = set()
    if isinstance(links, list):
        link_keys = {"id", "src", "dst", "type", "evidence_ids"}
        for i, link in enumerate(links):
            path = f"$.links[{i}]"
            if not _exact(link, link_keys):
                issues.append(_issue("link_fields", path, "closed citation link required"))
                continue
            if not _text(link["id"]):
                issues.append(_issue("link_id", f"{path}.id", "non-empty id required"))
            if link["type"] != "citation":
                issues.append(
                    _issue("link_type", f"{path}.type", "only observed citation is allowed")
                )
            endpoints_valid = (
                _text(link["src"])
                and _text(link["dst"])
                and link["src"] in node_ids
                and link["dst"] in node_ids
            )
            if not endpoints_valid:
                issues.append(_issue("link_endpoint", path, "dangling endpoint"))
            else:
                connected_nodes.update((link["src"], link["dst"]))
            if endpoints_valid and link["src"] == link["dst"]:
                issues.append(
                    _issue("link_self_loop", path, "self citation is not a cross-work link")
                )
            if not _text_list(link["evidence_ids"], nonempty=True):
                issues.append(
                    _issue(
                        "link_evidence", f"{path}.evidence_ids", "non-empty evidence ids required"
                    )
                )
            elif any(eid not in evidence_ids for eid in link["evidence_ids"]):
                issues.append(
                    _issue("link_evidence_binding", f"{path}.evidence_ids", "unknown evidence id")
                )
            elif endpoints_valid and any(
                evidence_by_id[eid].get("citing_work_id") != link["src"]
                or evidence_by_id[eid].get("cited_work_id") != link["dst"]
                for eid in link["evidence_ids"]
                if eid in evidence_by_id
            ):
                issues.append(
                    _issue(
                        "link_evidence_endpoint_binding",
                        f"{path}.evidence_ids",
                        "citation evidence direction must match link endpoints",
                    )
                )

    accepted_graph: dict[str, set[str]] = {node_id: set() for node_id in node_ids}
    accepted_pairs: set[tuple[str, str]] = set()
    decision_counts: Counter[str] = Counter()
    if isinstance(claims, list):
        claim_keys = {
            "id",
            "src",
            "dst",
            "claim_family",
            "relation",
            "decision",
            "trust_tier",
            "raw_score",
            "calibrated_probability",
            "calibration_id",
            "evidence_ids",
            "rationale",
            "classification",
            "reason_codes",
            "review_binding",
        }
        classification_keys = {"method", "provider", "model", "prompt_version", "schema_version"}
        review_keys = {"review_id", "fixture_id", "evidence_sha256"}
        for i, claim in enumerate(claims):
            path = f"$.claims[{i}]"
            if not _exact(claim, claim_keys):
                issues.append(_issue("claim_fields", path, "closed claim ledger record required"))
                continue
            decision = claim["decision"]
            family = claim["claim_family"]
            relation = claim["relation"]
            if not _text(claim["id"]):
                issues.append(_issue("claim_id", f"{path}.id", "non-empty id required"))
            if isinstance(decision, str):
                decision_counts[decision] += 1
            if not isinstance(decision, str) or decision not in DECISIONS:
                issues.append(_issue("claim_decision", f"{path}.decision", "unknown decision"))
            if not isinstance(family, str) or family not in {"genealogy", "comparison"}:
                issues.append(_issue("claim_family", f"{path}.claim_family", "unknown family"))
            expected_relations = GENEALOGY if family == "genealogy" else COMPARISON
            if decision in ("accepted", "rejected") and (
                not isinstance(relation, str) or relation not in expected_relations
            ):
                issues.append(
                    _issue(
                        "claim_relation",
                        f"{path}.relation",
                        "asserted decision needs family relation",
                    )
                )
            if decision in ("unknown", "abstained") and relation is not None:
                issues.append(
                    _issue(
                        "claim_unknown_relation",
                        f"{path}.relation",
                        "unknown/abstained relation must be null",
                    )
                )
            if not isinstance(claim["trust_tier"], str) or claim["trust_tier"] not in TRUST_TIERS:
                issues.append(
                    _issue("claim_trust_tier", f"{path}.trust_tier", "unknown trust tier")
                )
            endpoints_valid = _text(claim["src"]) and _text(claim["dst"])
            if not endpoints_valid or claim["src"] not in node_ids or claim["dst"] not in node_ids:
                issues.append(_issue("claim_endpoint", path, "dangling endpoint"))
                endpoints_valid = False
            else:
                connected_nodes.update((claim["src"], claim["dst"]))
            if decision == "accepted" and claim["src"] == claim["dst"]:
                issues.append(_issue("accepted_self_loop", path, "accepted self-loop forbidden"))
            for field in ("raw_score", "calibrated_probability"):
                score = claim[field]
                if not _unit_number(score):
                    issues.append(
                        _issue("claim_score", f"{path}.{field}", "null or number in [0,1] required")
                    )
            if not _nullable_text(claim["calibration_id"]):
                issues.append(
                    _issue(
                        "calibration_id",
                        f"{path}.calibration_id",
                        "null or non-empty text required",
                    )
                )
            if (claim["calibrated_probability"] is None) != (claim["calibration_id"] is None):
                issues.append(
                    _issue(
                        "calibration_binding",
                        path,
                        "probability and calibration id are inseparable",
                    )
                )
            if claim["trust_tier"] == "corroborated" and decision == "accepted":
                if claim["calibrated_probability"] is None:
                    issues.append(_issue("corroborated_calibration", path, "calibration required"))
                evidence_refs = (
                    claim["evidence_ids"] if isinstance(claim["evidence_ids"], list) else []
                )
                bound = [evidence_by_id.get(eid) for eid in evidence_refs if _text(eid)]
                independent = {
                    (e.get("source"), e.get("kind")) for e in bound if isinstance(e, Mapping)
                }
                source_works = {
                    e.get("source_work_id")
                    for e in bound
                    if isinstance(e, Mapping) and _text(e.get("source_work_id"))
                }
                if len(independent) < 2 or len(source_works) < 2:
                    issues.append(
                        _issue(
                            "corroborated_evidence",
                            path,
                            "two independent source/kind pairs and source works required",
                        )
                    )
            if not isinstance(claim["rationale"], str):
                issues.append(
                    _issue("claim_rationale_type", f"{path}.rationale", "string required")
                )
            if decision in ("accepted", "rejected") and not _text(claim["rationale"]):
                issues.append(
                    _issue(
                        "claim_rationale", f"{path}.rationale", "asserted decision needs rationale"
                    )
                )
            reason_codes_valid = _text_list(claim["reason_codes"])
            if not reason_codes_valid:
                issues.append(
                    _issue(
                        "claim_reason_codes_shape",
                        f"{path}.reason_codes",
                        "unique text array required",
                    )
                )
            if decision in ("unknown", "abstained") and not _text_list(
                claim["reason_codes"], nonempty=True
            ):
                issues.append(
                    _issue(
                        "claim_reason_codes",
                        f"{path}.reason_codes",
                        "unknown/abstained needs reason",
                    )
                )
            if not _text_list(claim["evidence_ids"]):
                issues.append(
                    _issue("claim_evidence", f"{path}.evidence_ids", "unique text array required")
                )
            elif any(eid not in evidence_ids for eid in claim["evidence_ids"]):
                issues.append(
                    _issue("claim_evidence_binding", f"{path}.evidence_ids", "unknown evidence id")
                )
            else:
                bound_claim_evidence = [
                    evidence_by_id[eid] for eid in claim["evidence_ids"] if eid in evidence_by_id
                ]
                if endpoints_valid and any(
                    not (
                        (
                            item.get("cited_work_id") == claim["src"]
                            and item.get("citing_work_id") == claim["dst"]
                        )
                        or (
                            item.get("cited_work_id") == claim["dst"]
                            and item.get("citing_work_id") == claim["src"]
                        )
                    )
                    for item in bound_claim_evidence
                ):
                    issues.append(
                        _issue(
                            "claim_evidence_endpoint_binding",
                            f"{path}.evidence_ids",
                            "candidate evidence must bind the exact claim endpoint pair",
                        )
                    )
                if decision == "accepted" and (
                    not claim["evidence_ids"]
                    or any(
                        item.get("cited_work_id") != claim["src"]
                        or item.get("citing_work_id") != claim["dst"]
                        for item in bound_claim_evidence
                    )
                ):
                    issues.append(
                        _issue(
                            "accepted_evidence_direction",
                            f"{path}.evidence_ids",
                            "accepted evidence must be non-empty and point cited src to citing dst",
                        )
                    )
            classification = claim["classification"]
            if not _exact(classification, classification_keys):
                issues.append(
                    _issue(
                        "classification_fields",
                        f"{path}.classification",
                        "closed classification identity required",
                    )
                )
            elif (
                not isinstance(classification["method"], str)
                or classification["method"] not in CLASSIFICATION_METHODS
            ):
                issues.append(
                    _issue(
                        "classification_method", f"{path}.classification.method", "unknown method"
                    )
                )
            else:
                if not all(
                    _nullable_text(classification[key])
                    for key in ("provider", "model", "prompt_version")
                ) or not _text(classification["schema_version"]):
                    issues.append(
                        _issue(
                            "classification_identity",
                            f"{path}.classification",
                            "typed provider/model/prompt/schema identity required",
                        )
                    )
                if classification["method"] == "llm" and not all(
                    _text(classification[key])
                    for key in ("provider", "model", "prompt_version", "schema_version")
                ):
                    issues.append(
                        _issue(
                            "llm_identity",
                            f"{path}.classification",
                            "complete LLM identity required",
                        )
                    )
            binding = claim["review_binding"]
            if binding is not None and (
                not _exact(binding, review_keys)
                or not _text(binding.get("review_id"))
                or not _text(binding.get("fixture_id"))
                or not _sha(binding.get("evidence_sha256"))
            ):
                issues.append(
                    _issue(
                        "review_binding", f"{path}.review_binding", "closed hash binding required"
                    )
                )
            elif binding is not None:
                evidence_refs = (
                    claim["evidence_ids"] if isinstance(claim["evidence_ids"], list) else []
                )
                bound_evidence = [
                    evidence_by_id[eid]
                    for eid in evidence_refs
                    if _text(eid) and eid in evidence_by_id
                ]
                try:
                    expected_evidence_hash = canonical_json_sha256(
                        sorted(bound_evidence, key=lambda item: item["id"])
                    )
                except (TypeError, ValueError):
                    expected_evidence_hash = None
                if binding["evidence_sha256"] != expected_evidence_hash:
                    issues.append(
                        _issue(
                            "review_evidence_hash",
                            f"{path}.review_binding.evidence_sha256",
                            "must hash bound evidence records",
                        )
                    )
            if decision == "accepted" and claim["trust_tier"] == "verified" and binding is None:
                issues.append(
                    _issue(
                        "verified_review_missing",
                        path,
                        "verified claim requires claim-specific review",
                    )
                )

            if (
                decision == "accepted"
                and family == "genealogy"
                and isinstance(relation, str)
                and relation in GENEALOGY
                and endpoints_valid
            ):
                pair = (claim["src"], claim["dst"])
                if (pair[1], pair[0]) in accepted_pairs:
                    issues.append(
                        _issue("accepted_bidirectional", path, "reverse accepted genealogy exists")
                    )
                accepted_pairs.add(pair)
                accepted_graph.setdefault(pair[0], set()).add(pair[1])
                src_date, dst_date = node_dates.get(pair[0]), node_dates.get(pair[1])
                if src_date is None or dst_date is None:
                    issues.append(
                        _issue(
                            "accepted_temporal_missing",
                            path,
                            "accepted genealogy requires both dates",
                        )
                    )
                elif src_date > dst_date:
                    issues.append(
                        _issue("accepted_temporal_reversal", path, "src must not postdate dst")
                    )

    colors: dict[str, int] = {}
    has_cycle = False
    for start in node_ids:
        if colors.get(start, 0) != 0:
            continue
        colors[start] = 1
        stack: list[tuple[str, Iterator[str]]] = [(start, iter(accepted_graph.get(start, ())))]
        while stack and not has_cycle:
            current, children = stack[-1]
            try:
                child = next(children)
            except StopIteration:
                colors[current] = 2
                stack.pop()
                continue
            child_color = colors.get(child, 0)
            if child_color == 1:
                has_cycle = True
            elif child_color == 0:
                colors[child] = 1
                stack.append((child, iter(accepted_graph.get(child, ()))))
        if has_cycle:
            break
    if has_cycle:
        issues.append(_issue("accepted_cycle", "$.claims", "accepted genealogy must be a DAG"))
    isolated = node_ids - connected_nodes - ({root} if _text(root) else set())
    if isolated:
        issues.append(
            _issue(
                "isolated_nodes",
                "$.nodes",
                "non-root nodes must participate in a link or candidate claim: "
                + ",".join(sorted(isolated)),
            )
        )

    meta = data.get("meta")
    meta_keys = {"kind", "producer", "generated_at", "candidate_universe"}
    producer_keys = {"name", "version"}
    universe_keys = {"snapshot_ref", "input_sha256", "selection_method", "candidate_count"}
    if not _exact(meta, meta_keys):
        issues.append(_issue("meta_fields", "$.meta", "closed meta required"))
    else:
        assert isinstance(meta, Mapping)
        if (
            not isinstance(meta["kind"], str)
            or meta["kind"] not in {"conference", "theme", "deep"}
            or (kind is not None and meta["kind"] != kind)
        ):
            issues.append(_issue("artifact_kind", "$.meta.kind", "unexpected kind"))
        if not _exact(meta["producer"], producer_keys) or not all(
            _text(v) for v in meta["producer"].values()
        ):
            issues.append(_issue("producer_identity", "$.meta.producer", "name/version required"))
        if not _timestamp(meta["generated_at"]):
            issues.append(
                _issue("generated_at", "$.meta.generated_at", "timezone timestamp required")
            )
        universe = meta["candidate_universe"]
        if (
            not _exact(universe, universe_keys)
            or not _text(universe.get("snapshot_ref"))
            or not _sha(universe.get("input_sha256"))
            or not _text(universe.get("selection_method"))
            or not _nonnegative_int(universe.get("candidate_count"))
        ):
            issues.append(
                _issue(
                    "candidate_universe",
                    "$.meta.candidate_universe",
                    "frozen snapshot/hash/selection required",
                )
            )
        elif universe["candidate_count"] != (len(claims) if isinstance(claims, list) else -1):
            issues.append(
                _issue(
                    "ledger_coverage",
                    "$.meta.candidate_universe.candidate_count",
                    "must equal complete claims ledger",
                )
            )
    if not isinstance(data.get("clusters"), list):
        issues.append(_issue("clusters_shape", "$.clusters", "array required"))
    return issues


def validate_lineage_audit_fixtures_v2(data: object) -> list[ContractIssue]:
    """Validate frozen edge labels and independent human review bindings."""

    if not _bounded_json(data):
        return [_issue("fixture_bounds", "$", "finite bounded acyclic JSON required")]
    if not isinstance(data, Mapping):
        return [_issue("fixture_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    if not _exact(data, {"schema_version", "fixture_id", "created_at", "collections"}):
        issues.append(_issue("fixture_fields", "$", "closed fixture object required"))
    if data.get("schema_version") != FIXTURE_VERSION:
        issues.append(_issue("fixture_schema_version", "$.schema_version", FIXTURE_VERSION))
    if not _text(data.get("fixture_id")) or not _timestamp(data.get("created_at")):
        issues.append(_issue("fixture_identity", "$", "fixture id and timestamp required"))
    collections = data.get("collections")
    if not isinstance(collections, list):
        return [*issues, _issue("fixture_collections", "$.collections", "array required")]
    collection_keys = {
        "collection_id",
        "release_id",
        "artifact_sha256",
        "candidate_universe",
        "focus_labels",
        "edge_labels",
    }
    universe_keys = {"snapshot_ref", "input_sha256", "selection_method", "candidate_count"}
    label_keys = {
        "review_id",
        "collection_id",
        "src",
        "dst",
        "evidence_sha256",
        "reviews",
        "adjudication",
    }
    review_keys = {
        "reviewer_id",
        "blind_to_model",
        "blind_to_peer",
        "citation_valid",
        "gold_family",
        "gold_relation",
        "evidence_support",
        "notes",
        "reviewed_at",
    }
    adjudication_keys = {
        "adjudicator_id",
        "citation_valid",
        "gold_family",
        "gold_relation",
        "evidence_support",
        "notes",
        "reviewed_at",
    }
    seen_reviews: set[str] = set()
    seen_collections: set[str] = set()
    for ci, collection in enumerate(collections):
        cpath = f"$.collections[{ci}]"
        if not _exact(collection, collection_keys):
            issues.append(
                _issue("fixture_collection_fields", cpath, "closed collection fixture required")
            )
            continue
        if (
            not _text(collection["collection_id"])
            or not _text(collection["release_id"])
            or not _sha(collection["artifact_sha256"])
        ):
            issues.append(
                _issue(
                    "fixture_collection_identity",
                    cpath,
                    "collection/release/artifact hash required",
                )
            )
        elif collection["collection_id"] in seen_collections:
            issues.append(
                _issue("fixture_collection_duplicate", cpath, "collection id must be unique")
            )
        else:
            seen_collections.add(collection["collection_id"])
        universe = collection["candidate_universe"]
        if (
            not _exact(universe, universe_keys)
            or not _text(universe.get("snapshot_ref"))
            or not _sha(universe.get("input_sha256"))
            or not _text(universe.get("selection_method"))
            or not _nonnegative_int(universe.get("candidate_count"))
        ):
            issues.append(
                _issue(
                    "fixture_candidate_universe",
                    f"{cpath}.candidate_universe",
                    "frozen universe required",
                )
            )
            continue
        focus_labels = collection["focus_labels"]
        if not isinstance(focus_labels, list) or not focus_labels:
            issues.append(
                _issue("focus_labels_shape", f"{cpath}.focus_labels", "non-empty array required")
            )
        else:
            focus_node_ids: list[str] = []
            for fi, focus_label in enumerate(focus_labels):
                fpath = f"{cpath}.focus_labels[{fi}]"
                if not _exact(focus_label, {"node_id", "on_topic"}):
                    issues.append(
                        _issue("focus_label_fields", fpath, "closed focus label required")
                    )
                    continue
                if not _text(focus_label["node_id"]):
                    issues.append(
                        _issue("focus_label_node", f"{fpath}.node_id", "non-empty node id required")
                    )
                else:
                    focus_node_ids.append(focus_label["node_id"])
                if type(focus_label["on_topic"]) is not bool:
                    issues.append(
                        _issue("focus_label_topic", f"{fpath}.on_topic", "boolean required")
                    )
            if len(focus_node_ids) != len(set(focus_node_ids)):
                issues.append(
                    _issue(
                        "focus_label_duplicate",
                        f"{cpath}.focus_labels",
                        "node labels must be unique",
                    )
                )
        labels = collection["edge_labels"]
        if not isinstance(labels, list) or len(labels) != universe.get("candidate_count"):
            issues.append(
                _issue(
                    "fixture_ledger_coverage",
                    f"{cpath}.edge_labels",
                    "100% candidate labels required",
                )
            )
            continue
        candidate_identities: set[tuple[str, str, str]] = set()
        collection_reviewers: frozenset[str] | None = None
        for li, label in enumerate(labels):
            path = f"{cpath}.edge_labels[{li}]"
            if not _exact(label, label_keys):
                issues.append(_issue("edge_label_fields", path, "closed edge label required"))
                continue
            if (
                not _text(label["collection_id"])
                or label["collection_id"] != collection["collection_id"]
                or not _text(label["src"])
                or not _text(label["dst"])
                or not _sha(label["evidence_sha256"])
            ):
                issues.append(
                    _issue("edge_label_binding", path, "collection/evidence binding mismatch")
                )
            else:
                identity = (label["src"], label["dst"], label["evidence_sha256"])
                if identity in candidate_identities:
                    issues.append(
                        _issue("edge_label_duplicate", path, "candidate identity must be unique")
                    )
                candidate_identities.add(identity)
            if not _text(label["review_id"]):
                issues.append(
                    _issue("review_id", f"{path}.review_id", "non-empty review id required")
                )
            elif label["review_id"] in seen_reviews:
                issues.append(
                    _issue("review_id_duplicate", f"{path}.review_id", "review id must be unique")
                )
            else:
                seen_reviews.add(label["review_id"])
            reviews = label["reviews"]
            if not isinstance(reviews, list) or len(reviews) != 2:
                issues.append(
                    _issue(
                        "double_blind_reviews",
                        f"{path}.reviews",
                        "exactly two independent reviews required",
                    )
                )
                continue
            reviewers: set[str] = set()
            review_times: list[datetime] = []
            for ri, review in enumerate(reviews):
                rpath = f"{path}.reviews[{ri}]"
                if not _exact(review, review_keys):
                    issues.append(_issue("review_fields", rpath, "closed review required"))
                    continue
                if _text(review["reviewer_id"]):
                    reviewers.add(review["reviewer_id"])
                else:
                    issues.append(
                        _issue(
                            "reviewer_id", f"{rpath}.reviewer_id", "non-empty reviewer id required"
                        )
                    )
                if review["blind_to_model"] is not True or review["blind_to_peer"] is not True:
                    issues.append(
                        _issue("review_not_blind", rpath, "both blind flags must be true")
                    )
                if (
                    type(review["citation_valid"]) is not bool
                    or not isinstance(review["evidence_support"], str)
                    or review["evidence_support"] not in ("supports", "insufficient", "conflicts")
                    or not isinstance(review["notes"], str)
                    or not _timestamp(review["reviewed_at"])
                ):
                    issues.append(
                        _issue(
                            "review_semantics", rpath, "typed citation/support/timestamp required"
                        )
                    )
                else:
                    reviewed_at = _date_key(review["reviewed_at"])
                    if reviewed_at is not None:
                        review_times.append(reviewed_at)
                family = review["gold_family"]
                relation = review["gold_relation"]
                if not (
                    family is None
                    or (isinstance(family, str) and family in {"genealogy", "comparison"})
                ) or not (
                    relation is None or (isinstance(relation, str) and relation in RELATIONS)
                ):
                    issues.append(_issue("review_gold_enum", rpath, "unknown gold family/relation"))
                elif (relation is None) != (family is None) or (
                    relation is not None
                    and (
                        (family == "genealogy" and relation not in GENEALOGY)
                        or (family == "comparison" and relation not in COMPARISON)
                    )
                ):
                    issues.append(
                        _issue("review_gold_family", rpath, "gold family/relation mismatch")
                    )
            if len(reviewers) != 2:
                issues.append(
                    _issue(
                        "reviewer_independence",
                        f"{path}.reviews",
                        "two distinct reviewers required",
                    )
                )
            elif collection_reviewers is None:
                collection_reviewers = frozenset(reviewers)
            elif frozenset(reviewers) != collection_reviewers:
                issues.append(
                    _issue(
                        "reviewer_panel_mismatch",
                        f"{path}.reviews",
                        "all candidates must use the same two independent reviewers",
                    )
                )
            adjudication = label["adjudication"]
            if (
                not _exact(adjudication, adjudication_keys)
                or not _text(adjudication.get("adjudicator_id"))
                or adjudication.get("adjudicator_id") in reviewers
            ):
                issues.append(
                    _issue(
                        "adjudication", f"{path}.adjudication", "independent adjudicator required"
                    )
                )
            else:
                afamily = adjudication["gold_family"]
                arelation = adjudication["gold_relation"]
                if (
                    type(adjudication["citation_valid"]) is not bool
                    or not isinstance(adjudication["evidence_support"], str)
                    or adjudication["evidence_support"]
                    not in ("supports", "insufficient", "conflicts")
                    or not isinstance(adjudication["notes"], str)
                    or not _timestamp(adjudication["reviewed_at"])
                ):
                    issues.append(
                        _issue(
                            "adjudication_semantics",
                            f"{path}.adjudication",
                            "typed adjudication required",
                        )
                    )
                else:
                    adjudicated_at = _date_key(adjudication["reviewed_at"])
                    if (
                        adjudicated_at is not None
                        and review_times
                        and adjudicated_at < max(review_times)
                    ):
                        issues.append(
                            _issue(
                                "adjudication_time",
                                f"{path}.adjudication.reviewed_at",
                                "adjudication must not predate either blind review",
                            )
                        )
                if not (
                    afamily is None
                    or (isinstance(afamily, str) and afamily in {"genealogy", "comparison"})
                ) or not (
                    arelation is None or (isinstance(arelation, str) and arelation in RELATIONS)
                ):
                    issues.append(
                        _issue(
                            "adjudication_gold_enum",
                            f"{path}.adjudication",
                            "unknown gold family/relation",
                        )
                    )
                elif (arelation is None) != (afamily is None) or (
                    arelation is not None
                    and (
                        (afamily == "genealogy" and arelation not in GENEALOGY)
                        or (afamily == "comparison" and arelation not in COMPARISON)
                    )
                ):
                    issues.append(
                        _issue(
                            "adjudication_gold_family",
                            f"{path}.adjudication",
                            "gold family/relation mismatch",
                        )
                    )
            if (
                isinstance(reviews[0], Mapping)
                and isinstance(reviews[1], Mapping)
                and isinstance(adjudication, Mapping)
            ):
                fields = ("citation_valid", "gold_family", "gold_relation", "evidence_support")
                t0 = tuple(reviews[0].get(f) for f in fields)
                t1 = tuple(reviews[1].get(f) for f in fields)
                ta = tuple(adjudication.get(f) for f in fields)
                if t0 == t1 and t0 != ta:
                    issues.append(
                        _issue(
                            "adjudication_confirmation_mismatch",
                            f"{path}.adjudication",
                            "third-party final review must confirm agreed judgments",
                        )
                    )
    return issues


def _artifact_hash(value: object) -> str | None:
    try:
        if isinstance(value, bytes):
            if len(value) > MAX_BOUND_BYTES:
                return None
            return hashlib.sha256(value).hexdigest()
        if not _bounded_json(value):
            return None
        if isinstance(value, Mapping):
            return cast(str, canonical_json_sha256(value))
    except (TypeError, ValueError):
        return None
    return None


def _at_least(value: object, threshold: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= threshold


def _at_most(value: object, threshold: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value <= threshold


def _cohen_kappa(pairs: list[tuple[str | None, str | None]]) -> float | None:
    """Compute unweighted Cohen's kappa, returning None for a degenerate margin."""

    if not pairs:
        return None
    first = Counter(pair[0] for pair in pairs)
    second = Counter(pair[1] for pair in pairs)
    total = len(pairs)
    observed = sum(left == right for left, right in pairs) / total
    categories = set(first) | set(second)
    expected = sum(first[item] * second[item] for item in categories) / (total * total)
    if math.isclose(expected, 1.0):
        return None
    return (observed - expected) / (1.0 - expected)


def validate_lineage_quality_v2(
    data: object,
    *,
    artifacts: Mapping[str, object] | None = None,
    fixtures: Mapping[str, object] | None = None,
    catalog_ids: Mapping[str, set[str]] | None = None,
) -> list[ContractIssue]:
    """Validate a v2 quality manifest and bind every ready row to actual inputs.

    A ``ready + passed`` row is eligible only when its parsed artifact, parsed
    fixture, and the actual canonical catalog ID set for that collection are
    supplied.  A caller assertion such as ``identity_passed=True`` is not an
    identity proof and is intentionally not accepted by this API.
    """

    if not _bounded_json(data):
        return [_issue("quality_bounds", "$", "finite bounded acyclic JSON required")]
    if not isinstance(data, Mapping):
        return [_issue("quality_shape", "$", "object required")]
    issues: list[ContractIssue] = []
    if not _exact(data, {"schema_version", "audit_version", "as_of", "collections"}):
        issues.append(_issue("quality_fields", "$", "closed quality manifest required"))
    if data.get("schema_version") != QUALITY_VERSION or data.get("audit_version") != "audit-v2":
        issues.append(_issue("quality_version", "$", "lineage-quality-v2/audit-v2 required"))
    if not _timestamp(data.get("as_of")):
        issues.append(_issue("quality_as_of", "$.as_of", "timezone timestamp required"))
    quality_as_of = _date_key(data.get("as_of"))
    rows = data.get("collections")
    if not isinstance(rows, list):
        return [*issues, _issue("quality_collections", "$.collections", "array required")]
    row_keys = {
        "collection_id",
        "kind",
        "slug",
        "label",
        "path",
        "release_id",
        "release_profile",
        "availability",
        "audit_status",
        "artifact_schema_version",
        "artifact_sha256",
        "fixture_sha256",
        "node_count",
        "link_count",
        "claim_decision_count",
        "accepted_genealogy_count",
        "accepted_comparison_count",
        "decision_counts",
        "calibration",
        "review",
        "checks",
    }
    decision_keys = {"accepted", "unknown", "abstained", "rejected"}
    calibration_keys = {
        "status",
        "reason",
        "sample_count",
        "wilson_lower_bound",
        "supersedes_wilson_lower_bound",
        "macro_precision",
        "ece",
        "brier",
        "accepted_coverage",
        "unknown_abstained_recall",
    }
    review_keys = {"status", "reviewed_claim_count", "agreement", "fixture_id"}
    seen: set[str] = set()
    for i, row in enumerate(rows):
        path = f"$.collections[{i}]"
        if not _exact(row, row_keys):
            issues.append(_issue("quality_collection_fields", path, "closed quality row required"))
            continue
        raw_collection_id = row["collection_id"]
        if not _text(raw_collection_id):
            issues.append(
                _issue(
                    "quality_collection_id",
                    f"{path}.collection_id",
                    "non-empty collection id required",
                )
            )
            collection_id = f"<invalid:{i}>"
        else:
            collection_id = raw_collection_id
        if collection_id in seen:
            issues.append(_issue("quality_collection_duplicate", path, "duplicate collection id"))
        seen.add(collection_id)
        profile = row["release_profile"]
        if not isinstance(profile, str) or profile not in RELEASE_PROFILES:
            issues.append(_issue("release_profile", f"{path}.release_profile", "unknown profile"))
        kind = row["kind"]
        slug = row["slug"]
        ready = row["availability"] == "ready" and row["audit_status"] == "passed"
        if not isinstance(kind, str) or kind not in ("conference", "theme", "deep"):
            issues.append(_issue("quality_kind", f"{path}.kind", "unknown collection kind"))
        if (
            not isinstance(row["availability"], str)
            or row["availability"] not in ("unavailable", "sparse", "ready", "failed")
            or not isinstance(row["audit_status"], str)
            or row["audit_status"] not in ("unknown", "passed", "failed")
        ):
            issues.append(_issue("quality_status", path, "unknown availability/audit status"))
        if not isinstance(slug, str) or SLUG_RE.fullmatch(slug) is None:
            issues.append(
                _issue("quality_slug", f"{path}.slug", "canonical lowercase slug required")
            )
        if not _text(row["label"]):
            issues.append(_issue("quality_label", f"{path}.label", "non-empty label required"))
        if not _safe_relative_json_path(row["path"]):
            issues.append(
                _issue("quality_path", f"{path}.path", "safe relative JSON path required")
            )
        elif isinstance(slug, str) and slug not in row["path"].split("/"):
            issues.append(
                _issue("quality_path_slug", f"{path}.path", "path must contain slug segment")
            )
        if not _text(row["release_id"]):
            issues.append(
                _issue("quality_release_id", f"{path}.release_id", "non-empty release id required")
            )
        if (
            isinstance(kind, str)
            and isinstance(slug, str)
            and kind in {"conference", "theme"}
            and collection_id != f"{kind}:{slug}"
        ):
            issues.append(
                _issue("quality_collection_identity", path, "collection id must bind kind and slug")
            )
        for field in (
            "node_count",
            "link_count",
            "claim_decision_count",
            "accepted_genealogy_count",
            "accepted_comparison_count",
        ):
            if not _nonnegative_int(row[field]):
                issues.append(
                    _issue("quality_count", f"{path}.{field}", "nonnegative integer required")
                )
        if row["artifact_schema_version"] != ARTIFACT_VERSION:
            issues.append(
                _issue(
                    "quality_artifact_version",
                    f"{path}.artifact_schema_version",
                    "v2 only; no inference",
                )
            )
        counts = row["decision_counts"]
        if not _exact(counts, decision_keys) or any(
            not _nonnegative_int(v) for v in counts.values()
        ):
            issues.append(
                _issue(
                    "quality_decision_counts",
                    f"{path}.decision_counts",
                    "four nonnegative counts required",
                )
            )
        elif (
            _nonnegative_int(row["claim_decision_count"])
            and sum(counts.values()) != row["claim_decision_count"]
        ):
            issues.append(
                _issue("quality_ledger_coverage", path, "decision counts must cover 100% ledger")
            )
        calibration = row["calibration"]
        review = row["review"]
        if not _exact(calibration, calibration_keys):
            issues.append(
                _issue(
                    "quality_calibration_fields",
                    f"{path}.calibration",
                    "closed calibration result required",
                )
            )
            calibration = {}
        else:
            if not isinstance(calibration["status"], str) or calibration["status"] not in {
                "passed",
                "failed",
                "insufficient_sample",
                "not_applicable",
            }:
                issues.append(
                    _issue(
                        "quality_calibration_status",
                        f"{path}.calibration.status",
                        "unknown calibration status",
                    )
                )
            if not isinstance(calibration["reason"], str) or not _nonnegative_int(
                calibration["sample_count"]
            ):
                issues.append(
                    _issue(
                        "quality_calibration_identity",
                        f"{path}.calibration",
                        "reason and sample count have invalid types",
                    )
                )
            for field in (
                "wilson_lower_bound",
                "supersedes_wilson_lower_bound",
                "macro_precision",
                "ece",
                "brier",
                "accepted_coverage",
                "unknown_abstained_recall",
            ):
                if not _unit_number(calibration[field]):
                    issues.append(
                        _issue(
                            "quality_calibration_metric",
                            f"{path}.calibration.{field}",
                            "null or number in [0,1] required",
                        )
                    )
        if not _exact(review, review_keys):
            issues.append(
                _issue("quality_review_fields", f"{path}.review", "closed review result required")
            )
            review = {}
        else:
            if not isinstance(review["status"], str) or review["status"] not in {
                "unknown",
                "passed",
                "failed",
                "not_applicable",
            }:
                issues.append(
                    _issue(
                        "quality_review_status", f"{path}.review.status", "unknown review status"
                    )
                )
            if not _nonnegative_int(review["reviewed_claim_count"]):
                issues.append(
                    _issue(
                        "quality_review_count",
                        f"{path}.review.reviewed_claim_count",
                        "nonnegative integer required",
                    )
                )
            if not _unit_number(review["agreement"]):
                issues.append(
                    _issue(
                        "quality_review_agreement",
                        f"{path}.review.agreement",
                        "null or number in [0,1] required",
                    )
                )
            if not _nullable_text(review["fixture_id"]):
                issues.append(
                    _issue(
                        "quality_review_fixture",
                        f"{path}.review.fixture_id",
                        "null or non-empty fixture id required",
                    )
                )
        if profile == "claim-verified-pilot-v1":
            if calibration.get("status") != "not_applicable" or not _text(
                calibration.get("reason")
            ):
                issues.append(
                    _issue(
                        "pilot_calibration",
                        f"{path}.calibration",
                        "must be not_applicable with reason",
                    )
                )
            accepted_total = (
                row["accepted_genealogy_count"] + row["accepted_comparison_count"]
                if _nonnegative_int(row["accepted_genealogy_count"])
                and _nonnegative_int(row["accepted_comparison_count"])
                else None
            )
            if ready and (
                review.get("status") != "passed"
                or review.get("reviewed_claim_count") != accepted_total
                or not _at_least(review.get("agreement"), 0.70)
            ):
                issues.append(
                    _issue(
                        "pilot_review_gate",
                        f"{path}.review",
                        "all accepted claims, agreement >= .70 required",
                    )
                )
        elif profile == "automated-calibrated-v1":
            metrics = (
                _at_least(calibration.get("sample_count"), 300)
                and _at_least(calibration.get("wilson_lower_bound"), 0.80)
                and _at_least(calibration.get("supersedes_wilson_lower_bound"), 0.90)
                and _at_least(calibration.get("macro_precision"), 0.80)
                and _at_most(calibration.get("ece"), 0.10)
                and _at_most(calibration.get("brier"), 0.15)
                and _at_least(calibration.get("accepted_coverage"), 0.20)
                and _at_least(calibration.get("unknown_abstained_recall"), 0.90)
            )
            if ready and (calibration.get("status") != "passed" or not metrics):
                issues.append(
                    _issue(
                        "automated_calibration_gate",
                        f"{path}.calibration",
                        "§4.3 thresholds required",
                    )
                )
            if ready:
                issues.append(
                    _issue(
                        "automated_profile_unsupported",
                        path,
                        "slice-level frozen calibration producer is not implemented",
                    )
                )
        for field in ("artifact_sha256", "fixture_sha256"):
            if row[field] is not None and not _sha(row[field]):
                issues.append(
                    _issue("quality_hash_type", f"{path}.{field}", "null or sha256 required")
                )
        if ready and (not _sha(row["artifact_sha256"]) or not _sha(row["fixture_sha256"])):
            issues.append(
                _issue("quality_hash_binding", path, "ready row needs artifact and fixture hashes")
            )
        if ready and (artifacts is None or fixtures is None or catalog_ids is None):
            issues.append(
                _issue(
                    "ready_bindings_unverified",
                    path,
                    "ready+passed validation requires actual artifact, fixture, and catalog IDs",
                )
            )
        checks = row["checks"]
        checks_valid = isinstance(checks, list)
        if checks_valid:
            for check_index, check in enumerate(checks):
                check_path = f"{path}.checks[{check_index}]"
                if not _exact(check, {"name", "status", "detail"}):
                    issues.append(
                        _issue("quality_check_fields", check_path, "closed check required")
                    )
                    checks_valid = False
                    continue
                if (
                    not _text(check["name"])
                    or not isinstance(check["status"], str)
                    or check["status"] not in {"unknown", "passed", "failed", "not_applicable"}
                    or not isinstance(check["detail"], str)
                ):
                    issues.append(
                        _issue("quality_check_semantics", check_path, "typed check fields required")
                    )
                    checks_valid = False
        else:
            issues.append(_issue("quality_checks_shape", f"{path}.checks", "array required"))
        if ready and (
            not checks_valid
            or not checks
            or any(
                check.get("status") != "passed" for check in checks if isinstance(check, Mapping)
            )
        ):
            issues.append(
                _issue(
                    "quality_checks",
                    f"{path}.checks",
                    "ready row requires non-empty all-passed checks",
                )
            )
        if ready and isinstance(checks, list):
            required_checks = {
                "artifact_contract_v2",
                "identity",
                "evidence_binding",
                "review_binding",
                "accepted_dag",
                "accepted_temporal",
                "frozen_candidate_ledger",
            }
            present_checks = {
                check.get("name")
                for check in checks
                if isinstance(check, Mapping) and isinstance(check.get("name"), str)
            }
            if len(present_checks) != len(checks):
                issues.append(
                    _issue(
                        "quality_check_duplicate", f"{path}.checks", "check names must be unique"
                    )
                )
            if profile == "automated-calibrated-v1":
                required_checks.add("automated_calibration")
            if not required_checks <= present_checks:
                issues.append(
                    _issue(
                        "quality_required_checks",
                        f"{path}.checks",
                        "required structural/profile gates missing",
                    )
                )
        artifact: object = artifacts.get(collection_id) if artifacts is not None else None
        artifact_mapping: Mapping[str, Any] | None = None
        if artifacts is not None:
            actual_hash = _artifact_hash(artifact)
            if artifact is None or actual_hash != row["artifact_sha256"]:
                issues.append(
                    _issue("artifact_hash_mismatch", path, "actual artifact bytes/hash mismatch")
                )
            elif not isinstance(artifact, Mapping):
                issues.append(
                    _issue(
                        "artifact_bytes_unparsed",
                        path,
                        "ready validation requires parsed strict artifact, not bytes alone",
                    )
                )
            else:
                bound_catalog = catalog_ids.get(collection_id) if catalog_ids is not None else None
                if not isinstance(bound_catalog, set) or not all(
                    isinstance(item, str) and PAPER_ID_RE.fullmatch(item) is not None
                    for item in bound_catalog
                ):
                    issues.append(
                        _issue(
                            "catalog_binding_missing",
                            path,
                            "actual canonical catalog ID set required",
                        )
                    )
                    bound_catalog = set()
                artifact_issues = validate_lineage_artifact_v2(
                    artifact,
                    kind=kind if isinstance(kind, str) else None,
                )
                issues += [
                    ContractIssue(x.code, f"{path}.artifact{x.path[1:]}", x.detail)
                    for x in artifact_issues
                ]
                if not artifact_issues:
                    artifact_mapping = artifact
                    artifact_nodes_for_catalog = artifact.get("nodes")
                    if isinstance(artifact_nodes_for_catalog, list):
                        for node_index, node in enumerate(artifact_nodes_for_catalog):
                            if (
                                isinstance(node, Mapping)
                                and node.get("is_focus") is True
                                and node.get("seed_paper_id") not in bound_catalog
                            ):
                                issues.append(
                                    _issue(
                                        "catalog_seed_membership",
                                        f"{path}.artifact.nodes[{node_index}].seed_paper_id",
                                        "seed absent from actual catalog",
                                    )
                                )
                artifact_nodes = artifact.get("nodes")
                artifact_links = artifact.get("links")
                artifact_claims = artifact.get("claims")
                if (
                    not isinstance(artifact_nodes, list)
                    or not isinstance(artifact_links, list)
                    or not isinstance(artifact_claims, list)
                    or len(artifact_nodes) != row["node_count"]
                    or len(artifact_links) != row["link_count"]
                    or len(artifact_claims) != row["claim_decision_count"]
                ):
                    issues.append(
                        _issue(
                            "artifact_count_mismatch", path, "declared counts differ from artifact"
                        )
                    )
                safe_claims = artifact_claims if isinstance(artifact_claims, list) else []
                accepted_g = sum(
                    isinstance(claim, Mapping)
                    and claim.get("decision") == "accepted"
                    and claim.get("claim_family") == "genealogy"
                    for claim in safe_claims
                )
                accepted_c = sum(
                    isinstance(claim, Mapping)
                    and claim.get("decision") == "accepted"
                    and claim.get("claim_family") == "comparison"
                    for claim in safe_claims
                )
                if (
                    accepted_g != row["accepted_genealogy_count"]
                    or accepted_c != row["accepted_comparison_count"]
                ):
                    issues.append(
                        _issue("accepted_count_mismatch", path, "accepted family counts differ")
                    )
                actual_decisions = Counter(
                    claim.get("decision")
                    for claim in safe_claims
                    if isinstance(claim, Mapping)
                    and isinstance(claim.get("decision"), str)
                    and claim.get("decision") in DECISIONS
                )
                if _exact(counts, decision_keys) and any(
                    counts[decision] != actual_decisions[decision] for decision in DECISIONS
                ):
                    issues.append(
                        _issue(
                            "decision_count_mismatch",
                            path,
                            "decision counts differ from artifact ledger",
                        )
                    )
                if artifact.get("release_id") != row["release_id"]:
                    issues.append(
                        _issue(
                            "artifact_release_mismatch",
                            path,
                            "artifact and quality release ids differ",
                        )
                    )
                if (
                    profile == "claim-verified-pilot-v1"
                    and ready
                    and any(
                        claim.get("decision") == "accepted"
                        and claim.get("trust_tier") != "verified"
                        for claim in safe_claims
                        if isinstance(claim, Mapping)
                    )
                ):
                    issues.append(
                        _issue(
                            "pilot_trust_gate", path, "pilot accepted claims must all be verified"
                        )
                    )
                if kind == "deep" and isinstance(slug, str):
                    focus_seeds = (
                        [
                            node.get("seed_paper_id")
                            for node in artifact_nodes
                            if isinstance(node, Mapping) and node.get("is_focus") is True
                        ]
                        if isinstance(artifact_nodes, list)
                        else []
                    )
                    expected_id = (
                        f"deep:{slug}:paper:{focus_seeds[0]}"
                        if len(focus_seeds) == 1 and _text(focus_seeds[0])
                        else None
                    )
                    if collection_id != expected_id:
                        issues.append(
                            _issue(
                                "deep_collection_identity",
                                path,
                                "deep collection id must bind the canonical focus seed",
                            )
                        )
        if fixtures is not None:
            fixture = fixtures.get(collection_id)
            if fixture is None or _artifact_hash(fixture) != row["fixture_sha256"]:
                issues.append(_issue("fixture_hash_mismatch", path, "actual fixture hash mismatch"))
            elif not isinstance(fixture, Mapping):
                issues.append(
                    _issue(
                        "fixture_bytes_unparsed",
                        path,
                        "ready validation requires parsed strict fixture, not bytes alone",
                    )
                )
            elif isinstance(fixture, Mapping):
                fixture_issues = validate_lineage_audit_fixtures_v2(fixture)
                issues += [
                    ContractIssue(x.code, f"{path}.fixture{x.path[1:]}", x.detail)
                    for x in fixture_issues
                ]
                fixture_collections = fixture.get("collections")
                safe_fixture_collections = (
                    fixture_collections if isinstance(fixture_collections, list) else []
                )
                candidates = [
                    item
                    for item in safe_fixture_collections
                    if isinstance(item, Mapping) and item.get("collection_id") == collection_id
                ]
                if len(candidates) != 1:
                    issues.append(
                        _issue(
                            "fixture_collection_binding",
                            path,
                            "fixture must contain exactly one matching collection",
                        )
                    )
                else:
                    fixture_row = candidates[0]
                    if (
                        fixture_row.get("release_id") != row["release_id"]
                        or fixture_row.get("artifact_sha256") != row["artifact_sha256"]
                    ):
                        issues.append(
                            _issue(
                                "fixture_release_binding",
                                path,
                                "fixture release/artifact binding mismatch",
                            )
                        )
                    if review.get("fixture_id") != fixture.get("fixture_id"):
                        issues.append(
                            _issue(
                                "fixture_review_binding", path, "quality review fixture id mismatch"
                            )
                        )
                    if artifact_mapping is not None:
                        artifact_meta = artifact_mapping.get("meta")
                        artifact_universe = (
                            artifact_meta.get("candidate_universe")
                            if isinstance(artifact_meta, Mapping)
                            else None
                        )
                        if fixture_row.get("candidate_universe") != artifact_universe:
                            issues.append(
                                _issue(
                                    "candidate_universe_mismatch",
                                    path,
                                    "artifact and fixture frozen universes differ",
                                )
                            )
                        artifact_evidence = artifact_mapping.get("evidence")
                        safe_evidence = (
                            artifact_evidence if isinstance(artifact_evidence, list) else []
                        )
                        artifact_claims = artifact_mapping.get("claims")
                        safe_claims = artifact_claims if isinstance(artifact_claims, list) else []
                        artifact_nodes = artifact_mapping.get("nodes")
                        safe_nodes = artifact_nodes if isinstance(artifact_nodes, list) else []
                        artifact_node_ids = {
                            node.get("id")
                            for node in safe_nodes
                            if isinstance(node, Mapping) and _text(node.get("id"))
                        }
                        artifact_root = artifact_mapping.get("root")
                        focus_labels = fixture_row.get("focus_labels")
                        safe_focus_labels = focus_labels if isinstance(focus_labels, list) else []
                        labelled_focus_ids = [
                            item.get("node_id")
                            for item in safe_focus_labels
                            if isinstance(item, Mapping) and _text(item.get("node_id"))
                        ]
                        root_labels = [
                            item
                            for item in safe_focus_labels
                            if isinstance(item, Mapping) and item.get("node_id") == artifact_root
                        ]
                        off_topic = sum(
                            item.get("on_topic") is False
                            for item in safe_focus_labels
                            if isinstance(item, Mapping)
                        )
                        if (
                            any(node_id not in artifact_node_ids for node_id in labelled_focus_ids)
                            or len(root_labels) != 1
                            or root_labels[0].get("on_topic") is not True
                            or not safe_focus_labels
                            or off_topic / len(safe_focus_labels) > 0.10
                        ):
                            issues.append(
                                _issue(
                                    "focus_label_binding",
                                    path,
                                    "focus labels must bind artifact nodes and the on-topic root",
                                )
                            )
                        fixture_labels = fixture_row.get("edge_labels")
                        safe_labels = fixture_labels if isinstance(fixture_labels, list) else []
                        generated_at = (
                            _date_key(artifact_meta.get("generated_at"))
                            if isinstance(artifact_meta, Mapping)
                            else None
                        )
                        fixture_created_at = _date_key(fixture.get("created_at"))
                        review_dates: list[datetime] = []
                        for label_item in safe_labels:
                            if not isinstance(label_item, Mapping):
                                continue
                            label_reviews = label_item.get("reviews")
                            if isinstance(label_reviews, list):
                                review_dates.extend(
                                    reviewed_at
                                    for review_item in label_reviews
                                    if isinstance(review_item, Mapping)
                                    and (reviewed_at := _date_key(review_item.get("reviewed_at")))
                                    is not None
                                )
                            adjudication_item = label_item.get("adjudication")
                            if isinstance(adjudication_item, Mapping):
                                adjudicated_at = _date_key(adjudication_item.get("reviewed_at"))
                                if adjudicated_at is not None:
                                    review_dates.append(adjudicated_at)
                        if (
                            generated_at is None
                            or fixture_created_at is None
                            or quality_as_of is None
                            or not review_dates
                            or generated_at > fixture_created_at
                            or any(
                                review_date < generated_at
                                or review_date < fixture_created_at
                                or review_date > quality_as_of
                                for review_date in review_dates
                            )
                        ):
                            issues.append(
                                _issue(
                                    "review_timeline_binding",
                                    path,
                                    "generated <= fixture/reviews <= quality as_of required",
                                )
                            )
                        claim_rows: dict[tuple[str, str, str], Mapping[str, Any]] = {}
                        duplicate_claim_identity = False
                        for claim in safe_claims:
                            if (
                                not isinstance(claim, Mapping)
                                or not _text(claim.get("src"))
                                or not _text(claim.get("dst"))
                                or not isinstance(claim.get("evidence_ids"), list)
                            ):
                                continue
                            bound = [
                                item
                                for item in safe_evidence
                                if isinstance(item, Mapping)
                                and item.get("id") in claim.get("evidence_ids", [])
                            ]
                            if any(not _text(item.get("id")) for item in bound):
                                continue
                            evidence_hash = canonical_json_sha256(
                                sorted(bound, key=lambda item: item["id"])
                            )
                            identity = (claim["src"], claim["dst"], evidence_hash)
                            if identity in claim_rows:
                                duplicate_claim_identity = True
                            claim_rows[identity] = claim
                        label_rows: dict[tuple[str, str, str], Mapping[str, Any]] = {}
                        duplicate_label_identity = False
                        for item in safe_labels:
                            if (
                                not isinstance(item, Mapping)
                                or not _text(item.get("src"))
                                or not _text(item.get("dst"))
                                or not _sha(item.get("evidence_sha256"))
                            ):
                                continue
                            identity = (item["src"], item["dst"], item["evidence_sha256"])
                            if identity in label_rows:
                                duplicate_label_identity = True
                            label_rows[identity] = item
                        if (
                            duplicate_claim_identity
                            or duplicate_label_identity
                            or set(claim_rows) != set(label_rows)
                        ):
                            issues.append(
                                _issue(
                                    "candidate_label_bijection",
                                    path,
                                    "every frozen candidate must have exactly one matching label",
                                )
                            )
                        relation_pairs: list[tuple[str | None, str | None]] = []
                        support_pairs: list[tuple[str | None, str | None]] = []
                        for identity, label_item in label_rows.items():
                            reviews = label_item.get("reviews")
                            if (
                                not isinstance(reviews, list)
                                or len(reviews) != 2
                                or not all(
                                    isinstance(item, Mapping) and _text(item.get("reviewer_id"))
                                    for item in reviews
                                )
                            ):
                                continue
                            ordered_reviews = sorted(reviews, key=lambda item: item["reviewer_id"])
                            first_tuple = (
                                ordered_reviews[0].get("citation_valid"),
                                ordered_reviews[0].get("gold_family"),
                                ordered_reviews[0].get("gold_relation"),
                                ordered_reviews[0].get("evidence_support"),
                            )
                            second_tuple = (
                                ordered_reviews[1].get("citation_valid"),
                                ordered_reviews[1].get("gold_family"),
                                ordered_reviews[1].get("gold_relation"),
                                ordered_reviews[1].get("evidence_support"),
                            )
                            agreed = first_tuple == second_tuple
                            first_relation = ordered_reviews[0].get("gold_relation")
                            second_relation = ordered_reviews[1].get("gold_relation")
                            first_support = ordered_reviews[0].get("evidence_support")
                            second_support = ordered_reviews[1].get("evidence_support")
                            if (first_relation is None or isinstance(first_relation, str)) and (
                                second_relation is None or isinstance(second_relation, str)
                            ):
                                relation_pairs.append((first_relation, second_relation))
                            if isinstance(first_support, str) and isinstance(second_support, str):
                                support_pairs.append((first_support, second_support))
                            final = ordered_reviews[0] if agreed else label_item.get("adjudication")
                            claim = claim_rows.get(identity)
                            if not isinstance(final, Mapping):
                                issues.append(
                                    _issue(
                                        "adjudication_final_missing",
                                        path,
                                        "disagreement requires a valid third-human adjudication",
                                    )
                                )
                                continue
                            if (
                                isinstance(claim, Mapping)
                                and claim.get("decision") == "accepted"
                                and (
                                    final.get("citation_valid") is not True
                                    or final.get("evidence_support") != "supports"
                                    or final.get("gold_family") != claim.get("claim_family")
                                    or final.get("gold_relation") != claim.get("relation")
                                )
                            ):
                                issues.append(
                                    _issue(
                                        "accepted_gold_mismatch",
                                        path,
                                        "accepted claim disagrees with final human gold",
                                    )
                                )
                        relation_kappa = _cohen_kappa(relation_pairs)
                        support_kappa = _cohen_kappa(support_pairs)
                        if relation_kappa is None or support_kappa is None:
                            issues.append(
                                _issue(
                                    "review_agreement_undefined",
                                    path,
                                    "relation/support kappa requires non-degenerate frozen labels",
                                )
                            )
                        else:
                            observed_agreement = min(relation_kappa, support_kappa)
                            declared_agreement = review.get("agreement")
                            if (
                                not isinstance(declared_agreement, (int, float))
                                or isinstance(declared_agreement, bool)
                                or not math.isclose(
                                    declared_agreement,
                                    observed_agreement,
                                    abs_tol=1e-12,
                                )
                            ):
                                issues.append(
                                    _issue(
                                        "review_agreement_mismatch",
                                        path,
                                        "declared agreement must equal min(relation kappa, support kappa)",
                                    )
                                )
                            if ready and observed_agreement < 0.70:
                                issues.append(
                                    _issue(
                                        "review_agreement_gate",
                                        path,
                                        "relation/support kappa must both be >= .70",
                                    )
                                )
                        labels = {
                            item.get("review_id"): item
                            for item in safe_labels
                            if isinstance(item, Mapping) and _text(item.get("review_id"))
                        }
                        for claim in safe_claims:
                            if (
                                not isinstance(claim, Mapping)
                                or claim.get("decision") != "accepted"
                                or claim.get("trust_tier") != "verified"
                            ):
                                continue
                            binding = claim.get("review_binding")
                            review_id = (
                                binding.get("review_id") if isinstance(binding, Mapping) else None
                            )
                            label_row = labels.get(review_id) if _text(review_id) else None
                            if (
                                not isinstance(binding, Mapping)
                                or binding.get("fixture_id") != fixture.get("fixture_id")
                                or not isinstance(label_row, Mapping)
                                or label_row.get("evidence_sha256")
                                != binding.get("evidence_sha256")
                                or label_row.get("src") != claim.get("src")
                                or label_row.get("dst") != claim.get("dst")
                            ):
                                issues.append(
                                    _issue(
                                        "claim_review_fixture_binding",
                                        path,
                                        "verified claim does not match edge label",
                                    )
                                )
    return issues


def build_lineage_quality_v2(
    *,
    as_of: str,
    artifact: Mapping[str, Any],
    fixture: Mapping[str, Any],
    collection_id: str,
    slug: str,
    label: str,
    path: str,
    release_profile: str,
    calibration: Mapping[str, Any],
    review: Mapping[str, Any],
    checks: list[Mapping[str, Any]],
    catalog_ids: set[str],
) -> dict[str, Any]:
    """Produce one bound ready quality manifest, or reject it fail closed.

    Human review and calibration results are inputs rather than inferred labels.
    ``catalog_ids`` must be the actual canonical ID set used to build the
    selected catalog; a boolean identity assertion is deliberately unsupported.
    """

    artifact_issues = validate_lineage_artifact_v2(artifact, catalog_ids=catalog_ids)
    fixture_issues = validate_lineage_audit_fixtures_v2(fixture)
    if artifact_issues or fixture_issues:
        codes = ",".join(issue.code for issue in [*artifact_issues, *fixture_issues])
        raise ValueError(f"invalid lineage v2 inputs: {codes}")
    claims = artifact["claims"]
    decisions = Counter(claim["decision"] for claim in claims)
    row = {
        "collection_id": collection_id,
        "kind": artifact["meta"]["kind"],
        "slug": slug,
        "label": label,
        "path": path,
        "release_id": artifact["release_id"],
        "release_profile": release_profile,
        "availability": "ready",
        "audit_status": "passed",
        "artifact_schema_version": ARTIFACT_VERSION,
        "artifact_sha256": canonical_json_sha256(artifact),
        "fixture_sha256": canonical_json_sha256(fixture),
        "node_count": len(artifact["nodes"]),
        "link_count": len(artifact["links"]),
        "claim_decision_count": len(claims),
        "accepted_genealogy_count": sum(
            claim["decision"] == "accepted" and claim["claim_family"] == "genealogy"
            for claim in claims
        ),
        "accepted_comparison_count": sum(
            claim["decision"] == "accepted" and claim["claim_family"] == "comparison"
            for claim in claims
        ),
        "decision_counts": {decision: decisions[decision] for decision in sorted(DECISIONS)},
        "calibration": dict(calibration),
        "review": dict(review),
        "checks": [dict(check) for check in checks],
    }
    manifest = {
        "schema_version": QUALITY_VERSION,
        "audit_version": "audit-v2",
        "as_of": as_of,
        "collections": [row],
    }
    issues = validate_lineage_quality_v2(
        manifest,
        artifacts={collection_id: artifact},
        fixtures={collection_id: fixture},
        catalog_ids={collection_id: catalog_ids},
    )
    if issues:
        raise ValueError(
            "invalid lineage v2 quality row: " + ",".join(issue.code for issue in issues)
        )
    return manifest
