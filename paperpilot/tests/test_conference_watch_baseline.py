"""Synthetic acceptance checks for local previous-edition evidence binding."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import FrozenInstanceError, replace
from typing import Any

import pytest

from paperpilot.conference_watch.models import (
    ConferenceRegistry,
    CountGate,
    Edition,
    EditionState,
    ReadinessPhase,
    RegistryDefaults,
    TrackPolicy,
    Venue,
)
from paperpilot.identity.source_ids import make_paper_id


def _case():
    gate = CountGate(1, 0.7, 1.5)
    tracks = TrackPolicy(True, ("oral", "poster"), ("oral",))
    venue = Venue(
        "synthetic",
        False,
        "top",
        "Synthetic {year}",
        "synthetic-{year}",
        "openreview-v2",
        "Synthetic.cc/{year}/Conference",
        2020,
        (1,),
        gate,
        tracks,
    )
    registry = ConferenceRegistry(
        "conference-sources-v1", False, RegistryDefaults(6, 6, 24, 1), (venue,)
    )
    edition = Edition(
        "synthetic-2026",
        "synthetic",
        2026,
        "Synthetic 2026",
        "openreview-v2",
        "Synthetic.cc/2026/Conference",
        gate,
        tracks,
        6,
        24,
    )
    state = EditionState(
        "synthetic-2025",
        "synthetic",
        2025,
        phase=ReadinessPhase.PUBLISHED,
        published_count=2,
        published_source_ids=("SyntheticA", "SyntheticB"),
        published_fingerprint="a" * 64,
    )
    rows = [
        {
            "title": "Synthetic title",
            "type": "Poster",
            "tags": ["Other"],
            "venue": "Synthetic 2025",
            "authors": ["Synthetic Author"],
            "arxiv_url": f"https://openreview.net/forum?id={sid}",
            "pdf_url": f"https://openreview.net/pdf?id={sid}",
            "abstract": "Synthetic abstract",
            "arxiv_id": "",
            "citation_count": None,
            "venue_tier": None,
            "github_stars": None,
            "paper_id": make_paper_id("openreview", sid),
            "source": "openreview",
            "source_id": sid,
        }
        for sid in state.published_source_ids
    ]
    return registry, edition, state, json.dumps(rows).encode()


def _module():
    return importlib.import_module("paperpilot.conference_watch.baseline")


def _validate(case):
    registry, edition, state, catalog = case
    return _module()._validate_previous_baseline(
        registry, edition, state, previous_catalog_bytes=catalog
    )


def test_valid_disabled_baseline_is_frozen_deterministic_and_non_mutating():
    case = _case()
    original = repr(case)
    result = _validate(case)
    assert result == _validate(case)
    assert result.previous_count == 2
    assert result.previous_year == 2025
    assert result.previous_edition_id == "synthetic-2025"
    assert result.published_fingerprint == "a" * 64
    assert result.previous_catalog_sha256 == hashlib.sha256(case[3]).hexdigest()
    assert repr(case) == original
    with pytest.raises(FrozenInstanceError):
        result.previous_count = 99


@pytest.mark.parametrize("position", range(4))
def test_wrong_outer_input_is_closed(position):
    case = list(_case())
    case[position] = None
    with pytest.raises(_module().PreviousEditionRatioAssessmentError) as exc:
        _validate(case)
    assert str(exc.value) == exc.value.code
    assert exc.value.code in {"CONF_BASELINE_INPUT_INVALID", "CONF_BASELINE_CATALOG_INVALID"}


@pytest.mark.parametrize(
    "changes",
    [
        {"year": 2024},
        {"year": True},
        {"venue_key": "other"},
        {"edition_id": "synthetic-2024"},
        {"phase": ReadinessPhase.READY},
        {"phase": "published"},
        {"published_count": True},
        {"published_count": 0},
        {"published_count": -1},
        {"published_count": 25001},
        {"published_count": 1.0},
        {"published_count": 10**10000},
        {"published_source_ids": ["SyntheticA", "SyntheticB"]},
        {"published_source_ids": ("SyntheticA", "SyntheticA")},
        {"published_source_ids": ("SyntheticA", [])},
        {"published_source_ids": ("SyntheticA", "bad/id")},
        {"published_source_ids": ("SyntheticA",)},
        {"published_fingerprint": None},
        {"published_fingerprint": "A" * 64},
        {"published_fingerprint": "x" * 64},
    ],
    ids=lambda value: None,
)
def test_published_state_rejects_invalid_evidence(changes):
    registry, edition, state, catalog = _case()
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_STATE_INVALID$"
    ):
        _validate((registry, edition, replace(state, **changes), catalog))


@pytest.mark.parametrize(
    "changes",
    [
        {"edition_id": "other-2026"},
        {"venue_key": "other"},
        {"year": 2027},
        {"year": True},
        {"display_name": "Other 2026"},
        {"adapter": "other"},
        {"source_id": "Other.cc/2026/Conference"},
        {"count_gate": CountGate(2, 0.7, 1.5)},
        {"tracks": TrackPolicy(True, ("poster",), ("poster",))},
        {"stable_min_separation_hours": 7},
        {"stable_max_separation_hours": 25},
    ],
)
def test_all_current_edition_fields_are_bound(changes):
    registry, edition, state, catalog = _case()
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_EDITION_MISMATCH$"
    ):
        _validate((registry, replace(edition, **changes), state, catalog))


def test_first_year_is_not_a_successful_baseline():
    registry, edition, state, catalog = _case()
    registry = replace(registry, venues=(replace(registry.venues[0], first_year=2026),))
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_FIRST_EDITION$"
    ):
        _validate((registry, edition, state, catalog))


@pytest.mark.parametrize(
    "ratio",
    [True, float("nan"), float("inf"), 0, -1, 11, 10**10000],
    ids=["bool", "nan", "inf", "zero", "negative", "over-limit", "huge-int"],
)
def test_registry_ratio_is_bounded_before_numeric_conversion(ratio):
    registry, edition, state, catalog = _case()
    venue = registry.venues[0]
    bad = replace(venue, count_gate=replace(venue.count_gate, previous_edition_min_ratio=ratio))
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_REGISTRY_INVALID$"
    ):
        _validate((replace(registry, venues=(bad,)), edition, state, catalog))


@pytest.mark.parametrize(
    "payload",
    [b"", b"[]", b"{}", b"[", b"\xff", b"\xef\xbb\xbf[]", b"[NaN]", b" " * (16 * 1024 * 1024 + 1)],
    ids=["empty", "empty-list", "object", "truncated", "utf8", "bom", "nan", "oversized"],
)
def test_invalid_catalog_maps_to_fixed_error(payload):
    registry, edition, state, _ = _case()
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_CATALOG_INVALID$"
    ):
        _validate((registry, edition, state, payload))


def test_catalog_count_and_id_set_bind_but_order_only_changes_hash():
    registry, edition, state, catalog = _case()
    rows = json.loads(catalog)
    first = _validate((registry, edition, state, catalog))
    second = _validate((registry, edition, state, json.dumps(rows[::-1]).encode()))
    assert first.previous_count == second.previous_count
    assert first.previous_catalog_sha256 != second.previous_catalog_sha256
    for altered in (rows[:1], [rows[0], rows[0]]):
        with pytest.raises(_module().PreviousEditionRatioAssessmentError):
            _validate((registry, edition, state, json.dumps(altered).encode()))
    wrong = replace(state, published_source_ids=("SyntheticA", "SyntheticC"))
    with pytest.raises(
        _module().PreviousEditionRatioAssessmentError, match=r"^CONF_BASELINE_CATALOG_MISMATCH$"
    ):
        _validate((registry, edition, wrong, catalog))


def test_pure_baseline_uses_no_io(monkeypatch):
    case = _case()
    module = _module()

    def forbidden(*args: Any, **kwargs: Any):
        pytest.fail("baseline validation must not use I/O")

    with monkeypatch.context() as scoped:
        for name in ("builtins.open", "io.open", "os.open", "socket.socket", "subprocess.Popen"):
            scoped.setattr(name, forbidden)
        assert (
            module._validate_previous_baseline(
                *case[:3], previous_catalog_bytes=case[3]
            ).previous_count
            == 2
        )


@pytest.mark.parametrize(
    ("position", "field", "code"),
    [
        (0, "venues", "CONF_BASELINE_REGISTRY_INVALID"),
        (1, "source_id", "CONF_BASELINE_EDITION_MISMATCH"),
        (2, "published_source_ids", "CONF_BASELINE_STATE_INVALID"),
    ],
)
def test_missing_dataclass_fields_have_closed_errors(position, field, code):
    case = _case()
    object.__delattr__(case[position], field)
    with pytest.raises(_module().PreviousEditionRatioAssessmentError) as exc:
        _validate(case)
    assert str(exc.value) == code


@pytest.mark.parametrize("kind", ["list", "duplicate", "oversized", "surrogate", "template"])
def test_handmade_registry_is_reparsed_and_bounded(kind):
    registry, edition, state, catalog = _case()
    venue = registry.venues[0]
    if kind == "list":
        registry = replace(registry, venues=list(registry.venues))
    elif kind == "duplicate":
        registry = replace(registry, venues=(venue, venue))
    else:
        value = {"oversized": "x" * 65537, "surrogate": "\ud800", "template": "{unknown}"}[kind]
        registry = replace(registry, venues=(replace(venue, display_template=value),))
    with pytest.raises(_module().PreviousEditionRatioAssessmentError) as exc:
        _validate((registry, edition, state, catalog))
    assert str(exc.value) == "CONF_BASELINE_REGISTRY_INVALID"
