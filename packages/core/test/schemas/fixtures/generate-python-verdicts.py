"""Produce the ground-truth Python jsonschema verdicts for the TS/ajv agreement test.

Why this exists (see docs/migration/schema-inventory.md and
docs/design/39-typescript-cloudflare-migration.md §3, §7.2): P1 needs one
authoritative run of ``jsonschema.Draft202012Validator`` over every
(published file, schema) pair discovered during the schema inventory, so
that ``packages/core/test/schemas/agreement.test.ts`` can compare the ajv
(TypeScript) verdict against a frozen Python verdict without re-invoking
Python on every CI run (no network/process-spawn coupling between the two
toolchains).

Run once, from the repo root:

    uv run --extra dev python packages/core/test/schemas/fixtures/generate-python-verdicts.py

It overwrites ``packages/core/test/schemas/fixtures/python-verdicts.json``
(committed). Re-run and re-commit whenever a schema or a published file the
"cases" list below walks is intentionally changed.

Scope notes:
- ``cases``: every pair the TS agreement test actually checks. All file
  discovery below is done with globs against the live repo tree, not
  hand-typed paths, so re-running after new conferences/shards are added
  picks them up automatically.
- ``excluded``: pairs that exist conceptually but are intentionally left
  out of the ajv/TS comparison, with the reason recorded (currently just
  ``conference-sources-v1``, whose published artifact is YAML; see
  schema-inventory.md §5). The Python verdict is still recorded here for
  completeness, it is just not asserted against ajv.
- Schemas with zero published files (dormant features / future contracts
  per schema-inventory.md §4) contribute no cases; this script does not
  invent fixtures for them.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker

REPO_ROOT = Path(__file__).resolve().parents[5]
SCHEMAS_DIR = REPO_ROOT / "schemas"
OUT_PATH = Path(__file__).resolve().parent / "python-verdicts.json"

MAX_SAMPLE_ERRORS = 5


def _load_schema(name: str) -> dict[str, Any]:
    path = SCHEMAS_DIR / f"{name}.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _verdict(schema_name: str, data: Any) -> dict[str, Any]:
    schema = _load_schema(schema_name)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    return {
        "ok": not errors,
        "errorCount": len(errors),
        "sampleErrors": [
            {
                "path": "/" + "/".join(str(p) for p in e.absolute_path),
                "message": e.message[:300],
            }
            for e in errors[:MAX_SAMPLE_ERRORS]
        ],
    }


def _rel(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def _case(path: Path, schema_name: str) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    verdict = _verdict(schema_name, data)
    return {"file": _rel(path), "schema": schema_name, **verdict}


def build_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    # identity-aliases-v1
    cases.append(_case(REPO_ROOT / "docs" / "identity-aliases-v1.json", "identity-aliases-v1"))

    # identity-coverage-v1 (state file, not under docs/)
    cases.append(
        _case(REPO_ROOT / "paperpilot" / "data" / "identity-coverage-v1.json", "identity-coverage-v1")
    )

    # lineage-pilot-index-v1
    cases.append(
        _case(REPO_ROOT / "docs" / "lineage-pilot-index-v1.json", "lineage-pilot-index-v1")
    )

    # lineage-quality-v1
    cases.append(_case(REPO_ROOT / "docs" / "lineage-quality-v1.json", "lineage-quality-v1"))

    # lineage-audit-fixtures-v1 (state file, not under docs/)
    cases.append(
        _case(
            REPO_ROOT / "paperpilot" / "data" / "lineage-audit-fixtures-v1.json",
            "lineage-audit-fixtures-v1",
        )
    )

    # search-index-v2
    cases.append(_case(REPO_ROOT / "docs" / "search-index-v2.json", "search-index-v2"))

    # deep-manifest-v1 (glob: only iclr-2026 has one today, per
    # schema-inventory.md this one is a known mismatch: the published file
    # is a bare array, not the {schema_version, conference, generated_at,
    # entries} object the schema requires)
    for path in sorted((REPO_ROOT / "docs").glob("*/deep-manifest.json")):
        cases.append(_case(path, "deep-manifest-v1"))

    # paper-details-v1 shard tree (all 256 shards)
    for path in sorted((REPO_ROOT / "docs" / "paper-details-v1").glob("*.json")):
        cases.append(_case(path, "paper-details-v1"))

    # search-paper-ids-v1 shard tree (all 111 shards)
    for path in sorted((REPO_ROOT / "docs" / "search-paper-ids-v1").glob("*.json")):
        cases.append(_case(path, "search-paper-ids-v1"))

    # lineage-artifact-v1: conference lineage.json (10, mostly empty stubs
    # + 2 real: iclr-2026, eccv-2024) + theme lineage.json (3). Per
    # schema-inventory.md §5 these are a KNOWN mismatch today (missing
    # required `schema_version`, conference ones missing `meta`, theme
    # ones missing `clusters`) -- both validators are expected to agree
    # they are all invalid, which is itself the thing being asserted.
    conf_lineage = sorted(
        p
        for p in (REPO_ROOT / "docs").glob("*/lineage.json")
        if p.parent.name != "themes"
    )
    theme_lineage = sorted((REPO_ROOT / "docs" / "themes").glob("*/lineage.json"))
    for path in conf_lineage + theme_lineage:
        cases.append(_case(path, "lineage-artifact-v1"))

    return cases


def build_excluded() -> list[dict[str, Any]]:
    """Pairs recorded for documentation but not asserted against ajv.

    conference-sources-v1's only published artifact is YAML
    (paperpilot/data/conference-sources-v1.yaml). packages/core may not add
    a YAML dependency (hard limit for this task), so there is no ajv-side
    parse to compare against. The Python verdict is still computed here so
    the gap is visible instead of silently dropped.
    """

    excluded: list[dict[str, Any]] = []
    yaml_path = REPO_ROOT / "paperpilot" / "data" / "conference-sources-v1.yaml"
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    verdict = _verdict("conference-sources-v1", data)
    excluded.append(
        {
            "file": _rel(yaml_path),
            "schema": "conference-sources-v1",
            **verdict,
            "reason": (
                "published artifact is YAML; packages/core has no YAML parser "
                "dependency available under the P1 hard limits (no new npm deps), "
                "so this pair is excluded from the ajv/TS agreement assertion. "
                "See docs/migration/schema-inventory.md §5."
            ),
        }
    )
    return excluded


def main() -> None:
    cases = build_cases()
    excluded = build_excluded()
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generator": "packages/core/test/schemas/fixtures/generate-python-verdicts.py",
        "validator": "jsonschema.Draft202012Validator(format_checker=FormatChecker())",
        "caseCount": len(cases),
        "cases": cases,
        "excluded": excluded,
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok_count = sum(1 for c in cases if c["ok"])
    print(f"wrote {OUT_PATH} ({len(cases)} cases, {ok_count} ok / {len(cases) - ok_count} invalid)")


if __name__ == "__main__":
    main()
