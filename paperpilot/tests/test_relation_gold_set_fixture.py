"""Schema validation tests for the relation_gold_set.jsonl fixture.

Issue #285 step 2: ensures every gold record is structurally well-formed
and uses a relation enum that the production pipeline knows. Catches
silent drift if the fixture is edited by hand later.
"""

from __future__ import annotations

import json
from pathlib import Path

from paperpilot.llm.base import _VALID_RELATIONS

FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "relation_gold_set.jsonl"
)


def _load_records() -> list[dict]:
    records = []
    for line in FIXTURE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        if record.get("_doc"):
            continue
        records.append(record)
    return records


def test_fixture_exists():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"


def test_fixture_has_at_least_29_records():
    records = _load_records()
    assert len(records) >= 29, (
        f"gold set shrunk below the original 29 LLM-decided edges — "
        f"got {len(records)}. Check for accidental deletion."
    )


def test_every_record_has_required_fields():
    required = {"id", "theme", "parent", "child", "current_rel", "gold_rel", "confidence"}
    for r in _load_records():
        missing = required - set(r)
        assert not missing, (
            f"record {r.get('id', '?')} missing fields: {missing}"
        )


def test_every_relation_in_valid_enum():
    """Both current_rel and gold_rel must be values the production
    pipeline knows. Catches typos and accidental enum expansion."""
    for r in _load_records():
        for field in ("current_rel", "gold_rel"):
            assert r[field] in _VALID_RELATIONS, (
                f"record {r['id']!r}: {field}={r[field]!r} is not in "
                f"_VALID_RELATIONS={sorted(_VALID_RELATIONS)}"
            )


def test_every_confidence_is_high_or_medium():
    for r in _load_records():
        assert r["confidence"] in ("high", "medium"), (
            f"record {r['id']!r}: confidence={r['confidence']!r} — "
            f"expected high or medium"
        )


def test_parent_and_child_have_title_year_abstract():
    for r in _load_records():
        for side in ("parent", "child"):
            paper = r[side]
            for field in ("title", "year", "abstract"):
                assert field in paper, (
                    f"record {r['id']!r} {side} missing {field!r}"
                )
            assert isinstance(paper["year"], int), (
                f"record {r['id']!r} {side} year must be int"
            )
            assert paper["title"], (
                f"record {r['id']!r} {side} title is empty"
            )


def test_record_ids_are_unique():
    ids = [r["id"] for r in _load_records()]
    assert len(ids) == len(set(ids)), (
        f"duplicate record ids: {[i for i in ids if ids.count(i) > 1]}"
    )
