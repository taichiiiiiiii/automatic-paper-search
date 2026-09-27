"""Tests for paperpilot.utils.atomic and paperpilot.utils.versioned_cache."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from paperpilot.utils import atomic
from paperpilot.utils.versioned_cache import (
    CACHE_MISS,
    read_versioned_cache,
    write_versioned_cache,
)


def test_atomic_write_replaces_content_and_leaves_no_temp(tmp_path: Path) -> None:
    out = tmp_path / "sub" / "a.json"
    atomic.atomic_write_text(out, "one")
    atomic.atomic_write_text(out, "two")
    assert out.read_text() == "two"
    assert [p.name for p in out.parent.iterdir()] == ["a.json"]


def test_failed_replace_keeps_the_old_file_and_cleans_up(tmp_path: Path, monkeypatch) -> None:
    out = tmp_path / "a.json"
    out.write_text("previous")

    def boom(*_a, **_kw):
        raise OSError("disk full")

    monkeypatch.setattr(atomic.os, "replace", boom)
    with pytest.raises(OSError):
        atomic.atomic_write_text(out, "new")
    assert out.read_text() == "previous"
    assert [p.name for p in tmp_path.iterdir()] == ["a.json"]


def test_each_write_uses_a_distinct_temporary_name(tmp_path: Path, monkeypatch) -> None:
    """A bare `.tmp` / `.tmp.<pid>` suffix collides across concurrent runs."""
    sources: list[str] = []
    real = os.replace

    def spy(src, dst):
        sources.append(os.fspath(src))
        return real(src, dst)

    monkeypatch.setattr(atomic.os, "replace", spy)
    out = tmp_path / "a.json"
    atomic.atomic_write_text(out, "1")
    atomic.atomic_write_text(out, "2")
    assert len(set(sources)) == 2
    assert all(Path(s).parent == tmp_path for s in sources)


def test_new_file_is_world_readable_and_existing_mode_is_kept(tmp_path: Path) -> None:
    """NamedTemporaryFile's 0o600 would hide a published artifact from a
    web server running as another user."""
    fresh = tmp_path / "fresh.json"
    atomic.atomic_write_text(fresh, "x")
    assert stat.S_IMODE(fresh.stat().st_mode) == 0o644

    private = tmp_path / "private.json"
    private.write_text("x")
    private.chmod(0o600)
    atomic.atomic_write_text(private, "y")
    assert stat.S_IMODE(private.stat().st_mode) == 0o600


def test_atomic_write_bytes_round_trips(tmp_path: Path) -> None:
    out = tmp_path / "a.bin"
    atomic.atomic_write_bytes(out, b"\x00\x01")
    assert out.read_bytes() == b"\x00\x01"


@pytest.mark.parametrize(
    "content",
    ["[]", '{"data": []}', '{"schema_version": "other", "data": []}', "not json", '"false"'],
    ids=["legacy-list", "no-version", "other-version", "truncated", "string"],
)
def test_versioned_cache_treats_anything_unversioned_as_a_miss(tmp_path: Path, content) -> None:
    path = tmp_path / "c.json"
    path.write_text(content)
    assert read_versioned_cache(path, "v1") is CACHE_MISS


def test_versioned_cache_round_trips_a_trusted_empty(tmp_path: Path) -> None:
    path = tmp_path / "c.json"
    assert read_versioned_cache(path, "v1") is CACHE_MISS
    write_versioned_cache(path, "v1", [])
    assert read_versioned_cache(path, "v1") == []
    assert json.loads(path.read_text()) == {"schema_version": "v1", "data": []}
