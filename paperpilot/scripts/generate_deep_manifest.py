"""Regenerate a strict ``deep-manifest-v1`` from audited deep artifacts.

Identity is read only from the canonical seed and exact aliases carried by a
``lineage-artifact-v1`` file. Filename, title and first-node fallbacks are
intentionally forbidden; legacy files remain unavailable until regenerated.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import TypedDict

from paperpilot.identity.source_ids import IdentityError, normalize_alias

from ._lineage_contract import (
    ARXIV_ID_RE,
    DEEP_MANIFEST_VERSION,
    LINEAGE_ARTIFACT_VERSION,
    canonical_focus_node,
    is_paper_id,
    validate_deep_manifest,
    validate_lineage_artifact,
)

_log = logging.getLogger(__name__)

_FILENAME_RE = re.compile(r"^deep-(?P<id>\d{4}\.\d{4,5}(?:v\d+)?)\.json$")
_MANIFEST_NAME = "deep-manifest.json"
_EMPTY_GENERATED_AT = "1970-01-01T00:00:00Z"


class ManifestEntry(TypedDict):
    paper_id: str
    aliases: list[list[str]]
    arxiv_id: str
    title: str
    filename: str


class DeepManifest(TypedDict):
    schema_version: str
    conference: str
    generated_at: str
    entries: list[ManifestEntry]


def _entry_from_file(
    path: Path,
    *,
    catalog_ids: set[str],
    catalog_arxiv_by_paper: dict[str, str],
) -> tuple[ManifestEntry, str] | None:
    """Return one exact, contract-valid entry and its generation timestamp."""

    match = _FILENAME_RE.fullmatch(path.name)
    if match is None:
        _log.warning("skip %s: filename is not a modern arXiv deep artifact", path.name)
        return None
    filename_arxiv = match.group("id")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _log.warning("skip %s: unreadable (%s)", path.name, exc)
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != LINEAGE_ARTIFACT_VERSION:
        _log.warning("skip %s: not %s", path.name, LINEAGE_ARTIFACT_VERSION)
        return None

    meta = payload.get("meta")
    if not isinstance(meta, dict):
        _log.warning("skip %s: missing meta", path.name)
        return None
    arxiv_id = meta.get("arxiv_id")
    seed_paper_id = meta.get("seed_paper_id")
    root = payload.get("root")
    if (
        not isinstance(arxiv_id, str)
        or ARXIV_ID_RE.fullmatch(arxiv_id) is None
        or arxiv_id != filename_arxiv
        or not is_paper_id(seed_paper_id)
        or not isinstance(root, str)
    ):
        _log.warning("skip %s: filename/arxiv/seed/root identity mismatch", path.name)
        return None
    if catalog_arxiv_by_paper.get(seed_paper_id) != arxiv_id:
        _log.warning(
            "skip %s: catalog paper_id/arxiv pair does not match artifact",
            path.name,
        )
        return None

    focus = canonical_focus_node(payload)
    aliases = [["arxiv", arxiv_id], ["semantic_scholar", root]]
    if (
        focus is None
        or focus.get("seed_paper_id") != seed_paper_id
        or focus.get("aliases") != aliases
        or meta.get("aliases") != aliases
    ):
        _log.warning("skip %s: root focus seed/aliases do not resolve exactly", path.name)
        return None
    title = focus.get("title")
    generated_at = meta.get("generated_at")
    if not isinstance(title, str) or not title.strip() or not isinstance(generated_at, str):
        _log.warning("skip %s: focus title or generated_at missing", path.name)
        return None

    issues = validate_lineage_artifact(
        payload,
        kind="deep",
        catalog_ids=catalog_ids,
        expected_seed_paper_id=seed_paper_id,
    )
    if issues:
        _log.warning("skip %s: contract failure %s", path.name, issues[0].code)
        return None
    return (
        ManifestEntry(
            paper_id=seed_paper_id,
            aliases=aliases,
            arxiv_id=arxiv_id,
            title=title.strip(),
            filename=path.name,
        ),
        generated_at,
    )


def _load_catalog_identity(docs_dir: Path) -> tuple[set[str], dict[str, str]]:
    """Return canonical IDs and unambiguous paper_id -> arXiv pairs.

    A paper ID and an arXiv ID appearing somewhere in the same catalog are not
    sufficient: publication requires both values to be declared by one row.
    Conflicting explicit aliases fail the whole manifest instead of choosing a
    row or silently dropping the ambiguity.
    """

    try:
        rows = json.loads((docs_dir / "papers.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _log.warning("catalog unavailable in %s (%s)", docs_dir, exc)
        return set(), {}
    if not isinstance(rows, list):
        raise ValueError("conference catalog must be an array")

    catalog_ids: set[str] = set()
    arxiv_by_paper: dict[str, str] = {}
    paper_by_arxiv: dict[str, str] = {}
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
            except IdentityError as exc:
                raise ValueError(f"catalog row {index} has invalid arXiv identity") from exc
            normalized.add(arxiv_id)
        if len(normalized) > 1:
            raise ValueError(f"catalog paper {paper_id} has ambiguous arXiv identities")
        if not normalized:
            continue
        arxiv_id = next(iter(normalized))
        previous_arxiv = arxiv_by_paper.get(paper_id)
        previous_paper = paper_by_arxiv.get(arxiv_id)
        if previous_arxiv not in {None, arxiv_id} or previous_paper not in {None, paper_id}:
            raise ValueError("catalog contains an ambiguous paper_id/arXiv mapping")
        arxiv_by_paper[paper_id] = arxiv_id
        paper_by_arxiv[arxiv_id] = paper_id
    return catalog_ids, arxiv_by_paper


def generate_manifest(docs_dir: Path) -> DeepManifest:
    """Scan deep artifacts and return one deterministic strict manifest."""

    catalog_ids, catalog_arxiv_by_paper = _load_catalog_identity(docs_dir)
    entries: list[ManifestEntry] = []
    timestamps: list[str] = []
    if docs_dir.is_dir():
        for path in sorted(docs_dir.glob("deep-*.json")):
            if path.name == _MANIFEST_NAME:
                continue
            result = _entry_from_file(
                path,
                catalog_ids=catalog_ids,
                catalog_arxiv_by_paper=catalog_arxiv_by_paper,
            )
            if result is not None:
                entry, generated_at = result
                entries.append(entry)
                timestamps.append(generated_at)

    entries.sort(key=lambda entry: (entry["paper_id"], entry["arxiv_id"]))
    manifest = DeepManifest(
        schema_version=DEEP_MANIFEST_VERSION,
        conference=docs_dir.name,
        generated_at=max(timestamps, default=_EMPTY_GENERATED_AT),
        entries=entries,
    )
    issues = validate_deep_manifest(manifest, catalog_ids=catalog_ids)
    if issues:
        detail = "; ".join(f"{issue.code}:{issue.path}" for issue in issues[:8])
        raise ValueError(f"deep manifest is ambiguous or invalid: {detail}")
    return manifest


def write_manifest(docs_dir: Path) -> Path:
    """Atomically replace ``deep-manifest.json`` after complete validation."""

    docs_dir.mkdir(parents=True, exist_ok=True)
    manifest = generate_manifest(docs_dir)
    out = docs_dir / _MANIFEST_NAME
    temporary = out.with_name(f".{out.name}.paperpilot-tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(out)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--docs-dir",
        required=True,
        help="Conference viewer dir (e.g. docs/iclr-2026)",
    )
    args = parser.parse_args(argv)
    docs_dir = Path(args.docs_dir)
    if not docs_dir.is_dir():
        print(f"error: {docs_dir} does not exist or is not a directory", file=sys.stderr)
        return 1
    try:
        out = write_manifest(docs_dir)
        manifest = json.loads(out.read_text(encoding="utf-8"))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"✓ Wrote {out} ({len(manifest['entries'])} entries)")
    for entry in manifest["entries"]:
        print(f"    {entry['arxiv_id']:12s}  {entry['title'][:60]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
