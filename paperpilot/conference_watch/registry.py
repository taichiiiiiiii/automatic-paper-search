"""Closed curated registry loading and bounded edition planning."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from .models import (
    ConferenceRegistry,
    CountGate,
    Edition,
    RegistryDefaults,
    RegistryError,
    TrackPolicy,
    Venue,
)

SCHEMA_VERSION = "conference-sources-v1"
SUPPORTED_ADAPTER = "openreview-v2"
STABLE_PROBE_COUNT = 2
MAX_REGISTRY_BYTES = 64 * 1024
MAX_REGISTRY_NODES = 10_000
MAX_REGISTRY_DEPTH = 12

_VENUE_KEY_RE = re.compile(r"^[a-z0-9-]+$")
_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_LABEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,63}/[0-9]{4}/Conference$")

_TOP_KEYS = {"schema_version", "apply_enabled", "defaults", "venues"}
_DEFAULT_KEYS = {
    "probe_interval_hours",
    "stable_min_separation_hours",
    "stable_max_separation_hours",
    "max_future_years",
}
_VENUE_KEYS = {
    "venue_key",
    "enabled",
    "curated_class",
    "display_template",
    "slug_template",
    "adapter",
    "source_id_template",
    "first_year",
    "active_months_utc",
    "count_gate",
    "tracks",
}
_COUNT_KEYS = {
    "minimum_absolute",
    "previous_edition_min_ratio",
    "previous_edition_max_ratio",
}
_TRACK_KEYS = {
    "accepted_only",
    "accepted_decision_labels",
    "highlighted_labels",
}


class _UniqueKeyLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: _UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> Any:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise RegistryError("registry mapping keys must be scalar and hashable") from exc
        if duplicate:
            raise RegistryError(f"duplicate registry key: {key!r}")
        try:
            mapping[key] = loader.construct_object(value_node, deep=deep)
        except TypeError as exc:
            raise RegistryError("registry mapping keys must be scalar and hashable") from exc
    return mapping


_UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def _closed(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RegistryError(f"{label} must be an object")
    raw_keys = list(value)
    if not all(isinstance(key, str) for key in raw_keys):
        raise RegistryError(f"{label} keys must be strings")
    keys = set(raw_keys)
    missing = expected - keys
    unknown = keys - expected
    if missing or unknown:
        raise RegistryError(
            f"{label} keys are not closed (missing={sorted(missing)}, unknown={sorted(unknown)})"
        )
    return value


def _validate_structure(value: Any) -> None:
    nodes = 0
    active: set[int] = set()

    def walk(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_REGISTRY_NODES or depth > MAX_REGISTRY_DEPTH:
            raise RegistryError("conference registry exceeds structural limits")
        if isinstance(item, dict):
            identity = id(item)
            if identity in active:
                raise RegistryError("conference registry must not contain recursive aliases")
            active.add(identity)
            try:
                for key, child in item.items():
                    walk(key, depth + 1)
                    walk(child, depth + 1)
            finally:
                active.remove(identity)
        elif isinstance(item, list):
            identity = id(item)
            if identity in active:
                raise RegistryError("conference registry must not contain recursive aliases")
            active.add(identity)
            try:
                for child in item:
                    walk(child, depth + 1)
            finally:
                active.remove(identity)
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            raise RegistryError("conference registry contains an unsupported YAML value")

    walk(value, 0)


def _plain_int(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise RegistryError(f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


def _ratio(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RegistryError(f"{label} must be a number")
    result = float(value)
    if not 0 < result <= 10:
        raise RegistryError(f"{label} must be in (0, 10]")
    return result


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise RegistryError(f"{label} must be a non-empty trimmed string")
    return value


def expand_year_template(template: str, year: int, *, label: str) -> str:
    """Expand the sole supported template token, rejecting all format syntax."""

    template = _string(template, label)
    if template.count("{year}") != 1:
        raise RegistryError(f"{label} must contain exactly one {{year}} token")
    remainder = template.replace("{year}", "")
    if "{" in remainder or "}" in remainder:
        raise RegistryError(f"{label} contains forbidden template syntax")
    return template.replace("{year}", str(year))


def _labels(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise RegistryError(f"{label} must be a non-empty array")
    if any(not isinstance(item, str) or not _LABEL_RE.fullmatch(item) for item in value):
        raise RegistryError(f"{label} contains an invalid decision label")
    normalized = tuple(value)
    if len(set(normalized)) != len(normalized):
        raise RegistryError(f"{label} must not contain duplicates")
    return normalized


def parse_registry(value: Any) -> ConferenceRegistry:
    """Validate an already-decoded closed registry and return typed values."""

    root = _closed(value, _TOP_KEYS, "registry")
    if root["schema_version"] != SCHEMA_VERSION:
        raise RegistryError(f"schema_version must equal {SCHEMA_VERSION!r}")
    if not isinstance(root["apply_enabled"], bool):
        raise RegistryError("apply_enabled must be boolean")

    raw_defaults = _closed(root["defaults"], _DEFAULT_KEYS, "defaults")
    defaults = RegistryDefaults(
        probe_interval_hours=_plain_int(
            raw_defaults["probe_interval_hours"], "probe_interval_hours", minimum=1, maximum=24
        ),
        stable_min_separation_hours=_plain_int(
            raw_defaults["stable_min_separation_hours"],
            "stable_min_separation_hours",
            minimum=1,
            maximum=168,
        ),
        stable_max_separation_hours=_plain_int(
            raw_defaults["stable_max_separation_hours"],
            "stable_max_separation_hours",
            minimum=1,
            maximum=336,
        ),
        max_future_years=_plain_int(
            raw_defaults["max_future_years"], "max_future_years", minimum=0, maximum=1
        ),
    )
    if defaults.stable_max_separation_hours < defaults.stable_min_separation_hours:
        raise RegistryError("stable_max_separation_hours must be >= minimum")

    raw_venues = root["venues"]
    if not isinstance(raw_venues, list) or not 1 <= len(raw_venues) <= 32:
        raise RegistryError("venues must contain between 1 and 32 entries")
    venues: list[Venue] = []
    seen_keys: set[str] = set()
    for index, raw_value in enumerate(raw_venues):
        raw = _closed(raw_value, _VENUE_KEYS, f"venues[{index}]")
        key = _string(raw["venue_key"], f"venues[{index}].venue_key")
        if not _VENUE_KEY_RE.fullmatch(key) or key in {"daily"}:
            raise RegistryError(f"invalid or reserved venue_key: {key!r}")
        if key in seen_keys:
            raise RegistryError(f"duplicate venue_key: {key!r}")
        seen_keys.add(key)
        if not isinstance(raw["enabled"], bool):
            raise RegistryError(f"venues[{index}].enabled must be boolean")
        if raw["curated_class"] != "top":
            raise RegistryError("curated_class must equal 'top'")
        if raw["adapter"] != SUPPORTED_ADAPTER:
            raise RegistryError(f"unsupported adapter: {raw['adapter']!r}")

        count_raw = _closed(raw["count_gate"], _COUNT_KEYS, f"venues[{index}].count_gate")
        count_gate = CountGate(
            minimum_absolute=_plain_int(
                count_raw["minimum_absolute"], "minimum_absolute", minimum=1, maximum=25_000
            ),
            previous_edition_min_ratio=_ratio(
                count_raw["previous_edition_min_ratio"], "previous_edition_min_ratio"
            ),
            previous_edition_max_ratio=_ratio(
                count_raw["previous_edition_max_ratio"], "previous_edition_max_ratio"
            ),
        )
        if count_gate.previous_edition_max_ratio < count_gate.previous_edition_min_ratio:
            raise RegistryError("previous edition maximum ratio must be >= minimum ratio")

        tracks_raw = _closed(raw["tracks"], _TRACK_KEYS, f"venues[{index}].tracks")
        if tracks_raw["accepted_only"] is not True:
            raise RegistryError("v1 requires tracks.accepted_only=true")
        accepted_labels = _labels(
            tracks_raw["accepted_decision_labels"], "accepted_decision_labels"
        )
        highlighted_labels = _labels(tracks_raw["highlighted_labels"], "highlighted_labels")
        if not set(highlighted_labels).issubset(accepted_labels):
            raise RegistryError("highlighted labels must be accepted decision labels")

        months_raw = raw["active_months_utc"]
        if not isinstance(months_raw, list) or not months_raw:
            raise RegistryError("active_months_utc must be a non-empty array")
        months = tuple(
            _plain_int(month, "active month", minimum=1, maximum=12) for month in months_raw
        )
        if len(set(months)) != len(months):
            raise RegistryError("active_months_utc must not contain duplicates")

        display_template = _string(raw["display_template"], "display_template")
        slug_template = _string(raw["slug_template"], "slug_template")
        source_template = _string(raw["source_id_template"], "source_id_template")
        sample_year = 2000
        expand_year_template(display_template, sample_year, label="display_template")
        sample_slug = expand_year_template(slug_template, sample_year, label="slug_template")
        sample_source_id = expand_year_template(
            source_template, sample_year, label="source_id_template"
        )
        if not _SLUG_RE.fullmatch(sample_slug) or sample_slug == "daily":
            raise RegistryError(f"expanded slug is invalid: {sample_slug!r}")
        if not _SOURCE_ID_RE.fullmatch(sample_source_id):
            raise RegistryError(f"expanded OpenReview source_id is invalid: {sample_source_id!r}")

        venues.append(
            Venue(
                venue_key=key,
                enabled=raw["enabled"],
                curated_class="top",
                display_template=display_template,
                slug_template=slug_template,
                adapter=SUPPORTED_ADAPTER,
                source_id_template=source_template,
                first_year=_plain_int(raw["first_year"], "first_year", minimum=2000, maximum=2100),
                active_months_utc=months,
                count_gate=count_gate,
                tracks=TrackPolicy(True, accepted_labels, highlighted_labels),
            )
        )
    return ConferenceRegistry(SCHEMA_VERSION, root["apply_enabled"], defaults, tuple(venues))


def load_registry(path: Path) -> ConferenceRegistry:
    """Load a YAML registry while rejecting duplicate keys and unsafe shapes."""

    try:
        payload = path.read_bytes()
        if len(payload) > MAX_REGISTRY_BYTES:
            raise RegistryError("conference registry exceeds the 64 KiB limit")
        raw = yaml.load(payload.decode("utf-8", errors="strict"), Loader=_UniqueKeyLoader)
        _validate_structure(raw)
    except RegistryError:
        raise
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        raise RegistryError("unable to load conference registry") from exc
    return parse_registry(raw)


def _edition(
    registry: ConferenceRegistry, venue: Venue, year: int, *, current_year: int
) -> Edition:
    if not venue.first_year <= year <= current_year + registry.defaults.max_future_years:
        raise RegistryError("edition year is outside the registry bound")
    slug = expand_year_template(venue.slug_template, year, label="slug_template")
    if not _SLUG_RE.fullmatch(slug) or slug == "daily":
        raise RegistryError("expanded edition slug is invalid")
    return Edition(
        edition_id=slug,
        venue_key=venue.venue_key,
        year=year,
        display_name=expand_year_template(venue.display_template, year, label="display_template"),
        adapter=venue.adapter,
        source_id=expand_year_template(venue.source_id_template, year, label="source_id_template"),
        count_gate=venue.count_gate,
        tracks=venue.tracks,
        stable_min_separation_hours=registry.defaults.stable_min_separation_hours,
        stable_max_separation_hours=registry.defaults.stable_max_separation_hours,
    )


def plan_editions(
    registry: ConferenceRegistry,
    now: datetime,
) -> tuple[Edition, ...]:
    """Plan only enabled current/next-year editions in their active window."""

    if now.tzinfo is None:
        raise RegistryError("planning time must be timezone-aware")
    utc_now = now.astimezone(timezone.utc)
    upper_year = utc_now.year + registry.defaults.max_future_years
    editions: list[Edition] = []
    for venue in registry.venues:
        if not venue.enabled:
            continue
        if utc_now.month not in venue.active_months_utc:
            continue
        for year in range(max(venue.first_year, utc_now.year), upper_year + 1):
            editions.append(_edition(registry, venue, year, current_year=utc_now.year))
    return tuple(sorted(editions, key=lambda item: item.edition_id))
