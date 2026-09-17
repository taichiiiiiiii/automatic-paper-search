from __future__ import annotations

import copy
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from paperpilot.conference_watch.models import RegistryError
from paperpilot.conference_watch.registry import (
    STABLE_PROBE_COUNT,
    load_registry,
    parse_registry,
    plan_editions,
)

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = ROOT / "paperpilot" / "data" / "conference-sources-v1.yaml"
SCHEMA_PATH = ROOT / "schemas" / "conference-sources-v1.schema.json"


def _raw_registry():
    return yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))


def _fixture_registry():
    registry = load_registry(REGISTRY_PATH)
    return replace(registry, venues=(replace(registry.venues[0], enabled=True),))


def test_checked_in_registry_is_closed_disabled_fixture_profile():
    registry = load_registry(REGISTRY_PATH)
    assert registry.apply_enabled is False
    assert registry.venues[0].venue_key == "iclr"
    assert registry.venues[0].enabled is False
    assert STABLE_PROBE_COUNT == 2
    assert not hasattr(registry.defaults, "stable_probe_count")


def test_registry_matches_json_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(_raw_registry())


def test_planner_is_registry_only_current_next_and_active_window():
    registry = load_registry(REGISTRY_PATH)
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    assert plan_editions(registry, now) == ()
    editions = plan_editions(_fixture_registry(), now)
    assert [item.edition_id for item in editions] == ["iclr-2026", "iclr-2027"]
    assert [item.source_id for item in editions] == [
        "ICLR.cc/2026/Conference",
        "ICLR.cc/2027/Conference",
    ]
    assert plan_editions(_fixture_registry(), datetime(2026, 8, 1, tzinfo=timezone.utc)) == ()


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("venues", 0, "adapter"), "web-scraper"),
        (("venues", 0, "slug_template"), "iclr-{year.__class__}"),
        (("venues", 0, "slug_template"), "{year}-{year}"),
        (("venues", 0, "source_id_template"), "https://example.com/{year}"),
        (("venues", 0, "venue_key"), "daily"),
        (("defaults", "max_future_years"), 2),
    ],
)
def test_registry_rejects_scope_widening(path, value):
    raw = copy.deepcopy(_raw_registry())
    target = raw
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    with pytest.raises(RegistryError):
        parse_registry(raw)


def test_registry_rejects_unknown_key_and_configurable_probe_count():
    raw = _raw_registry()
    raw["defaults"]["stable_probe_count"] = 3
    with pytest.raises(RegistryError, match="unknown"):
        parse_registry(raw)


def test_registry_rejects_non_string_or_non_hashable_keys_as_registry_errors(tmp_path):
    raw = _raw_registry()
    raw[1] = "mixed key"
    with pytest.raises(RegistryError, match="keys must be strings"):
        parse_registry(raw)

    non_hashable = tmp_path / "non-hashable.yaml"
    non_hashable.write_text("? [a, b]\n: value\n", encoding="utf-8")
    with pytest.raises(RegistryError, match="scalar and hashable"):
        load_registry(non_hashable)


def test_registry_rejects_duplicate_venue_and_duplicate_yaml_key(tmp_path):
    raw = _raw_registry()
    raw["venues"].append(copy.deepcopy(raw["venues"][0]))
    with pytest.raises(RegistryError, match="duplicate venue_key"):
        parse_registry(raw)

    duplicate = tmp_path / "registry.yaml"
    duplicate.write_text(
        "schema_version: conference-sources-v1\nschema_version: other\n", encoding="utf-8"
    )
    with pytest.raises(RegistryError, match="duplicate registry key"):
        load_registry(duplicate)


def test_registry_rejects_oversized_or_recursive_yaml(tmp_path):
    oversized = tmp_path / "oversized.yaml"
    oversized.write_bytes(b"x" * (64 * 1024 + 1))
    with pytest.raises(RegistryError, match="64 KiB"):
        load_registry(oversized)

    recursive = tmp_path / "recursive.yaml"
    recursive.write_text("value: &loop [*loop]\n", encoding="utf-8")
    with pytest.raises(RegistryError, match="recursive aliases"):
        load_registry(recursive)


def test_registry_runtime_rejects_more_than_schema_maximum_venues():
    raw = _raw_registry()
    prototype = raw["venues"][0]
    raw["venues"] = []
    for index in range(33):
        venue = copy.deepcopy(prototype)
        venue["venue_key"] = f"venue-{index}"
        raw["venues"].append(venue)
    with pytest.raises(RegistryError, match="between 1 and 32"):
        parse_registry(raw)
