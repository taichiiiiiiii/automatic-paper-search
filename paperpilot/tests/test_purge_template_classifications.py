"""Unit tests for purge_template_classifications.

The script removes cached LLM classifications whose rationale is one of
the heuristic templates — they short-circuit future LLM rescue calls
(see paperpilot/scripts/purge_template_classifications.py docstring).
"""

from __future__ import annotations

import json

from paperpilot.llm.base import TEMPLATE_RATIONALES
from paperpilot.scripts.purge_template_classifications import (
    purge_template_entries,
)


def _sample_template() -> str:
    """Return a known heuristic template rationale (first one)."""
    return next(iter(TEMPLATE_RATIONALES.values()))


def test_purge_drops_entries_with_template_rationale():
    cache = {
        "a->b": {
            "relation": "extends",
            "confidence": 0.8,
            "rationale": _sample_template(),
        },
        "c->d": {
            "relation": "successor",
            "confidence": 0.9,
            "rationale": "B のスペクトル畳み込みは A の局所演算を周波数領域で再定式化している",
        },
    }
    kept, dropped = purge_template_entries(cache)
    assert dropped == 1
    assert kept == {"c->d": cache["c->d"]}


def test_purge_idempotent_on_clean_cache():
    cache = {
        "a->b": {
            "relation": "extends",
            "confidence": 0.8,
            "rationale": "real paper-specific reason from LLM",
        }
    }
    kept, dropped = purge_template_entries(cache)
    assert dropped == 0
    assert kept == cache


def test_purge_drops_every_known_template():
    """Every entry in TEMPLATE_RATIONALES must trigger a drop. Pins the
    coupling: if a new template is added without updating the purger
    via TEMPLATE_RATIONALES, this catches the drift."""
    cache = {
        f"k{i}->v{i}": {
            "relation": "extends",
            "confidence": 0.7,
            "rationale": tmpl,
        }
        for i, tmpl in enumerate(TEMPLATE_RATIONALES.values())
    }
    kept, dropped = purge_template_entries(cache)
    assert dropped == len(TEMPLATE_RATIONALES)
    assert kept == {}


def test_purge_preserves_non_dict_entries():
    """Malformed entries (string / list / null) are kept untouched so a
    human can inspect them rather than have them silently swept."""
    cache: dict[str, object] = {
        "broken": "not a dict",
        "also_broken": None,
        "good": {
            "relation": "extends",
            "confidence": 0.9,
            "rationale": "specific reason",
        },
        "templated": {
            "relation": "extends",
            "confidence": 0.8,
            "rationale": _sample_template(),
        },
    }
    kept, dropped = purge_template_entries(cache)  # type: ignore[arg-type]
    assert dropped == 1
    assert "broken" in kept and "also_broken" in kept and "good" in kept
    assert "templated" not in kept


def test_purge_handles_whitespace_around_template():
    """Templates with surrounding whitespace are still recognised — the
    LLM occasionally adds trailing spaces or newlines to its JSON value."""
    template = _sample_template()
    cache = {
        "a->b": {
            "relation": "extends",
            "confidence": 0.7,
            "rationale": f"  {template}  ",
        },
    }
    kept, dropped = purge_template_entries(cache)
    assert dropped == 1
    assert kept == {}


def test_purge_keeps_entries_with_no_rationale_field():
    """Entries missing 'rationale' are kept (script doesn't claim
    authority over malformed cache shapes)."""
    cache = {"a->b": {"relation": "extends", "confidence": 0.7}}
    kept, dropped = purge_template_entries(cache)
    assert dropped == 0
    assert kept == cache


def test_cli_dry_run_does_not_modify_file(tmp_path, capsys):
    """--dry-run prints the would-be-dropped count but leaves the file
    untouched."""
    from paperpilot.scripts import purge_template_classifications as mod

    cache_path = tmp_path / "classifications.json"
    cache = {
        "a->b": {
            "relation": "extends",
            "confidence": 0.7,
            "rationale": _sample_template(),
        },
    }
    cache_path.write_text(json.dumps(cache), encoding="utf-8")

    # Drive main() with argv that mimics CLI invocation.
    import sys as _sys
    old_argv = _sys.argv
    _sys.argv = [
        "purge_template_classifications.py",
        "--cache", str(cache_path),
        "--dry-run",
    ]
    try:
        rc = mod.main()
    finally:
        _sys.argv = old_argv

    assert rc == 0
    assert json.loads(cache_path.read_text()) == cache  # unchanged
    captured = capsys.readouterr().out
    assert "drop : 1" in captured
    assert "--dry-run" in captured


def test_cli_writes_purged_cache_back(tmp_path):
    """Non-dry-run mode writes the kept entries back to the same path."""
    from paperpilot.scripts import purge_template_classifications as mod

    cache_path = tmp_path / "classifications.json"
    kept_entry = {
        "relation": "extends",
        "confidence": 0.9,
        "rationale": "specific paper reason",
    }
    cache = {
        "drop->me": {
            "relation": "extends",
            "confidence": 0.7,
            "rationale": _sample_template(),
        },
        "keep->me": kept_entry,
    }
    cache_path.write_text(json.dumps(cache), encoding="utf-8")

    import sys as _sys
    old_argv = _sys.argv
    _sys.argv = [
        "purge_template_classifications.py",
        "--cache", str(cache_path),
    ]
    try:
        rc = mod.main()
    finally:
        _sys.argv = old_argv

    assert rc == 0
    after = json.loads(cache_path.read_text())
    assert after == {"keep->me": kept_entry}


def test_cli_missing_cache_file_is_no_op(tmp_path):
    """Missing cache file → exit 0, no error. Used as a defensive
    invocation in CI / postdeploy hooks."""
    from paperpilot.scripts import purge_template_classifications as mod

    missing = tmp_path / "does-not-exist.json"
    import sys as _sys
    old_argv = _sys.argv
    _sys.argv = [
        "purge_template_classifications.py",
        "--cache", str(missing),
    ]
    try:
        rc = mod.main()
    finally:
        _sys.argv = old_argv
    assert rc == 0


def test_cli_malformed_cache_returns_nonzero(tmp_path):
    """Unparseable cache → exit 1 (operator should investigate, not
    auto-overwrite)."""
    from paperpilot.scripts import purge_template_classifications as mod

    bad = tmp_path / "bad.json"
    bad.write_text("this is not json{", encoding="utf-8")

    import sys as _sys
    old_argv = _sys.argv
    _sys.argv = [
        "purge_template_classifications.py",
        "--cache", str(bad),
    ]
    try:
        rc = mod.main()
    finally:
        _sys.argv = old_argv
    assert rc == 1
