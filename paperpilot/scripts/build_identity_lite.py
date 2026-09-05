"""Build additive catalog IDs and the Identity Lite alias sidecar."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from paperpilot.identity.projector import IdentityProjection, project_catalogs

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"
COVERAGE_PATH = ROOT / "paperpilot" / "data" / "identity-coverage-v1.json"


def _json_bytes(value: Any, *, indent: int | None = None) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=indent,
            separators=None if indent is not None else (",", ":"),
        ).encode()
        + b"\n"
    )


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.paperpilot-tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def load_conference_names(docs_root: Path) -> list[str]:
    rows = json.loads((docs_root / "conferences.json").read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError("conferences.json must be an array")
    names = [row.get("name") for row in rows if isinstance(row, dict)]
    if not names or not all(isinstance(name, str) and name for name in names):
        raise ValueError("every conference must have a non-empty name")
    if len(set(names)) != len(names):
        raise ValueError("conference names must be unique")
    return names


def build(
    *,
    docs_root: Path,
    conference_names: list[str],
    as_of: str,
    coverage_path: Path,
    check: bool = False,
    report_only: bool = False,
) -> IdentityProjection:
    """Validate all inputs before replacing any public identity projection."""

    projection = project_catalogs(docs_root, conference_names, as_of=as_of)
    coverage_payload = _json_bytes(projection.coverage, indent=2)
    if check:
        if coverage_path.read_bytes() != coverage_payload:
            raise ValueError("identity coverage report is stale")
    else:
        _atomic_write(coverage_path, coverage_payload)

    if report_only:
        return projection
    if not projection.valid:
        raise ValueError("identity coverage gate failed; public files were not replaced")

    expected: dict[Path, bytes] = {
        docs_root / "identity-aliases-v1.json": _json_bytes(projection.aliases),
    }
    for conference, rows in projection.catalogs.items():
        expected[docs_root / conference / "papers.json"] = _json_bytes(rows, indent=0)

    if check:
        stale = [str(path) for path, payload in expected.items() if path.read_bytes() != payload]
        if stale:
            raise ValueError("identity projections are stale: " + ", ".join(stale))
        return projection

    for path, payload in expected.items():
        _atomic_write(path, payload)
    return projection


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-root", type=Path, default=DOCS_ROOT)
    parser.add_argument("--coverage-path", type=Path, default=COVERAGE_PATH)
    parser.add_argument("--as-of", required=True, help="timezone-aware ISO-8601 projection time")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args()

    projection = build(
        docs_root=args.docs_root,
        conference_names=load_conference_names(args.docs_root),
        as_of=args.as_of,
        coverage_path=args.coverage_path,
        check=args.check,
        report_only=args.report_only,
    )
    coverage = projection.coverage
    print(
        f"Identity Lite: {coverage['resolved_rows']:,}/{coverage['input_rows']:,} rows, "
        f"{coverage['unique_paper_ids']:,} unique IDs, valid={coverage['valid']}"
    )


if __name__ == "__main__":
    main()
