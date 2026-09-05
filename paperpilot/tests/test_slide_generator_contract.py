"""Offline hostile-boundary tests for SD2 provider output contracts."""

from __future__ import annotations

import json

import pytest

import paperpilot.paper_slides.generator_contract as subject
from paperpilot.paper_slides.contract import (
    PAPER_SLIDE_CITATION_INVALID,
    PAPER_SLIDE_OUTPUT_INVALID,
    PAPER_SLIDE_SECRET_DETECTED,
)
from paperpilot.paper_slides.generator_contract import (
    MAX_PROVIDER_PAYLOAD_BYTES,
    ChunkSummary,
    DeckContent,
    SlideGeneratorContractError,
    load_chunk_summary,
    load_deck_content,
)

RECORDS = ("p001-c01", "p002-c01", "p002-c02")
ABSTRACT_RECORDS = ("abstract",)


def _bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def _summary() -> dict:
    return {
        "schema_version": "chunk-summary-v1",
        "claims": [
            {
                "claim_id": "k01",
                "claim_kind": "method",
                "text": "提案手法は二段階の探索を用います。",
                "record_ids": ["p001-c01", "p002-c01"],
            },
            {
                "claim_id": "k02",
                "claim_kind": "limitation",
                "text": "評価対象は限定されています。",
                "record_ids": ["p002-c02"],
            },
        ],
    }


def _deck(*, slides: int = 6) -> dict:
    kinds = ["title", "problem", "method", "evidence", "limitations", "conclusion"]
    result = []
    for index in range(slides):
        kind = kinds[index]
        result.append(
            {
                "kind": kind,
                "title": kind,
                "bullets": []
                if kind == "title"
                else [
                    {
                        "text": f"検証済みの要点 {index} です。",
                        "record_ids": [RECORDS[index % len(RECORDS)]],
                    }
                ],
                "speaker_notes": [],
            }
        )
    return {
        "schema_version": "deck-content-v1",
        "slides": result,
        "limitations": [],
    }


def _abstract_deck() -> dict:
    value = _deck(slides=4)
    for slide in value["slides"][1:]:
        for statement in slide["bullets"] + slide["speaker_notes"]:
            statement["record_ids"] = ["abstract"]
    return value


def _error(call, *args, **kwargs) -> SlideGeneratorContractError:
    with pytest.raises(SlideGeneratorContractError) as caught:
        call(*args, **kwargs)
    error = caught.value
    assert error.__cause__ is None
    assert error.__context__ is None
    assert "p001" not in str(error)
    assert "提案" not in str(error)
    return error


def test_chunk_summary_returns_closed_immutable_objects() -> None:
    result = load_chunk_summary(_bytes(_summary()), known_record_ids=RECORDS)

    assert type(result) is ChunkSummary
    assert result.schema_version == "chunk-summary-v1"
    assert [claim.claim_id for claim in result.claims] == ["k01", "k02"]
    assert result.claims[0].record_ids == ("p001-c01", "p002-c01")
    assert "提案手法" not in repr(result.claims[0])
    assert "p001-c01" not in repr(result.claims[0])
    with pytest.raises(AttributeError):
        result.schema_version = "changed"  # type: ignore[misc]


def test_claim_ids_may_have_gaps_but_remain_strictly_ascending() -> None:
    value = _summary()
    value["claims"][1]["claim_id"] = "k12"
    result = load_chunk_summary(_bytes(value), known_record_ids=RECORDS)
    assert [claim.claim_id for claim in result.claims] == ["k01", "k12"]


def test_deck_content_enforces_coverage_slide_ranges() -> None:
    full_text = load_deck_content(
        _bytes(_deck()), known_record_ids=RECORDS, coverage_kind="full_text"
    )
    abstract = load_deck_content(
        _bytes(_abstract_deck()),
        known_record_ids=ABSTRACT_RECORDS,
        coverage_kind="abstract_only",
    )

    assert type(full_text) is DeckContent
    assert len(full_text.slides) == 6
    assert len(abstract.slides) == 4
    assert "検証済み" not in repr(full_text)


def test_abstract_is_the_only_synthetic_record_id() -> None:
    summary = _summary()
    summary["claims"][0]["record_ids"] = ["abstract"]
    summary["claims"] = summary["claims"][:1]

    result = load_chunk_summary(_bytes(summary), known_record_ids=ABSTRACT_RECORDS)

    assert result.claims[0].record_ids == ("abstract",)
    error = _error(
        load_chunk_summary,
        _bytes(summary),
        known_record_ids=("other",),
    )
    assert error.error_code == PAPER_SLIDE_CITATION_INVALID
    assert error.issue_code == "known_record_set_invalid"


@pytest.mark.parametrize(
    ("payload", "issue_code"),
    [
        (b"", "provider_payload_size"),
        (b"\xff", "provider_payload_utf8"),
        (b'{"schema_version":"chunk-summary-v1"} trailing', "provider_json_syntax"),
        (b'{"schema_version":NaN,"claims":[]}', "provider_json_non_finite"),
        (
            b'{"schema_version":"chunk-summary-v1","schema_version":"x","claims":[]}',
            "provider_json_duplicate_key",
        ),
    ],
)
def test_malformed_json_has_stable_redacted_failure(payload: bytes, issue_code: str) -> None:
    error = _error(load_chunk_summary, payload, known_record_ids=RECORDS)
    assert error.error_code == PAPER_SLIDE_OUTPUT_INVALID
    assert error.issue_code == issue_code


def test_payload_type_and_subclasses_are_rejected_without_invocation() -> None:
    class HostileBytes(bytes):
        def decode(self, *args, **kwargs):
            raise AssertionError("must not invoke hostile override")

    error = _error(load_chunk_summary, HostileBytes(b"{}"), known_record_ids=RECORDS)
    assert error.issue_code == "provider_payload_type"
    error = _error(load_chunk_summary, bytearray(b"{}"), known_record_ids=RECORDS)  # type: ignore[arg-type]
    assert error.issue_code == "provider_payload_type"


def test_payload_depth_container_scalar_structural_and_byte_limits() -> None:
    cases = [
        (b"[" * 17 + b"]" * 17, "provider_json_depth"),
        (b"[" + b",".join([b"[]"] * 512) + b"]", "provider_json_containers"),
        (_bytes("x" * 8_001), "provider_json_scalar"),
        (
            ("{" + ",".join(f'"k{i}":0' for i in range(5_500)) + "}").encode(),
            "provider_json_structural_tokens",
        ),
        (b" " * (MAX_PROVIDER_PAYLOAD_BYTES + 1), "provider_payload_size"),
    ]
    for payload, issue_code in cases:
        error = _error(load_chunk_summary, payload, known_record_ids=RECORDS)
        assert error.issue_code == issue_code


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(extra=True),
        lambda value: value["claims"][0].update(extra=True),
        lambda value: value["claims"][0].update(claim_id="k02"),
        lambda value: value["claims"][0].update(claim_kind="other"),
        lambda value: value["claims"][0].update(text=True),
        lambda value: value["claims"][0].update(text=" é "),
        lambda value: value["claims"][0].update(text="<script>alert(1)</script>"),
    ],
)
def test_chunk_summary_rejects_shape_order_bool_normalization_and_html(mutation) -> None:
    value = _summary()
    mutation(value)
    error = _error(load_chunk_summary, _bytes(value), known_record_ids=RECORDS)
    assert error.error_code == PAPER_SLIDE_OUTPUT_INVALID


@pytest.mark.parametrize(
    "text",
    [
        "https://example.org/paper",
        "ftp://example.org/paper",
        "file:/etc/passwd",
        "mailto:author@example.org",
        "urn:isbn:9780000000000",
        "www.example.org/paper",
        "javascript:alert(1)",
        "Authorization: Bearer abcdefghijk",
        "api_key=super-secret-value",
        "sk-abcdefghijklmnop",
        "author@example.org",
    ],
)
def test_generated_text_rejects_urls_and_secret_shapes(text: str) -> None:
    value = _summary()
    value["claims"][0]["text"] = text
    error = _error(load_chunk_summary, _bytes(value), known_record_ids=RECORDS)
    assert error.error_code in {PAPER_SLIDE_OUTPUT_INVALID, PAPER_SLIDE_SECRET_DETECTED}


def test_unknown_duplicate_and_out_of_order_record_ids_fail_as_citations() -> None:
    for record_ids, issue_code in [
        (["p099-c01"], "record_id_unknown"),
        (["p001-c01", "p001-c01"], "record_ids_order"),
        (["p002-c01", "p001-c01"], "record_ids_order"),
        ([], "record_ids_shape"),
    ]:
        value = _summary()
        value["claims"][0]["record_ids"] = record_ids
        error = _error(load_chunk_summary, _bytes(value), known_record_ids=RECORDS)
        assert error.error_code == PAPER_SLIDE_CITATION_INVALID
        assert error.issue_code == issue_code


def test_hostile_known_record_container_is_not_iterated() -> None:
    class HostileTuple(tuple):
        def __iter__(self):
            raise AssertionError("must not iterate hostile tuple subclass")

    error = _error(
        load_chunk_summary,
        _bytes(_summary()),
        known_record_ids=HostileTuple(RECORDS),
    )
    assert error.error_code == PAPER_SLIDE_CITATION_INVALID
    assert error.issue_code == "known_record_set_invalid"

    error = _error(
        load_chunk_summary,
        _bytes(_summary()),
        known_record_ids=tuple(reversed(RECORDS)),
    )
    assert error.issue_code == "known_record_set_invalid"


def test_hostile_mapping_from_decoder_is_not_inspected(monkeypatch: pytest.MonkeyPatch) -> None:
    class HostileMapping(dict):
        def __iter__(self):
            raise AssertionError("must not iterate hostile mapping")

    monkeypatch.setattr(subject.json, "loads", lambda *args, **kwargs: HostileMapping())
    error = _error(load_chunk_summary, _bytes(_summary()), known_record_ids=RECORDS)
    assert error.issue_code == "chunk_summary_fields"


def test_deck_requires_first_and_only_title_and_citations_on_non_title_content() -> None:
    cases = []
    value = _deck()
    value["slides"][0]["kind"] = "problem"
    cases.append(value)
    value = _deck()
    value["slides"][1]["kind"] = "title"
    cases.append(value)
    value = _deck()
    value["slides"][1]["bullets"] = []
    cases.append(value)
    value = _deck()
    value["slides"][1]["bullets"] = []
    value["slides"][1]["speaker_notes"] = [
        {"text": "注記だけではスライドを構成できません。", "record_ids": ["p001-c01"]}
    ]
    cases.append(value)
    value = _deck()
    value["slides"][0]["speaker_notes"] = [{"text": "不正な注記です。", "record_ids": ["p001-c01"]}]
    cases.append(value)
    for candidate in cases:
        _error(
            load_deck_content,
            _bytes(candidate),
            known_record_ids=RECORDS,
            coverage_kind="full_text",
        )


def test_speaker_notes_use_the_same_exact_reference_contract() -> None:
    value = _deck()
    value["slides"][1]["speaker_notes"] = [
        {"text": "発表時に確認する注記です。", "record_ids": ["p002-c02"]}
    ]
    result = load_deck_content(_bytes(value), known_record_ids=RECORDS, coverage_kind="full_text")
    assert result.slides[1].speaker_notes[0].record_ids == ("p002-c02",)


def test_provider_limitations_are_rejected_and_count_is_bounded() -> None:
    value = _deck()
    value["limitations"] = ["同じ制約です。", "同じ制約です。"]
    error = _error(
        load_deck_content,
        _bytes(value),
        known_record_ids=RECORDS,
        coverage_kind="full_text",
    )
    assert error.issue_code == "limitations_must_be_empty"

    value["limitations"] = [f"制約 {index}" for index in range(9)]
    error = _error(
        load_deck_content,
        _bytes(value),
        known_record_ids=RECORDS,
        coverage_kind="full_text",
    )
    assert error.issue_code == "limitations_shape"


def test_provider_titles_and_top_level_limitations_must_be_non_assertive() -> None:
    value = _deck()
    value["slides"][1]["title"] = "万能な治療法"
    error = _error(
        load_deck_content,
        _bytes(value),
        known_record_ids=RECORDS,
        coverage_kind="full_text",
    )
    assert error.issue_code == "slide_title_not_code_label"

    value = _deck()
    value["limitations"] = ["この方法は特定集団では失敗します。"]
    error = _error(
        load_deck_content,
        _bytes(value),
        known_record_ids=RECORDS,
        coverage_kind="full_text",
    )
    assert error.issue_code == "limitations_must_be_empty"


@pytest.mark.parametrize("coverage_kind", [True, 1, "FULL_TEXT", None])
def test_coverage_kind_is_exact_and_bool_is_not_int(coverage_kind: object) -> None:
    error = _error(
        load_deck_content,
        _bytes(_deck()),
        known_record_ids=RECORDS,
        coverage_kind=coverage_kind,
    )
    assert error.issue_code == "coverage_kind"


def test_unexpected_ordinary_failures_are_redacted_but_control_flow_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def explode(*args, **kwargs):
        raise RuntimeError("secret provider response p001-c01")

    monkeypatch.setattr(subject.json, "loads", explode)
    error = _error(load_chunk_summary, _bytes(_summary()), known_record_ids=RECORDS)
    assert error.error_code == PAPER_SLIDE_OUTPUT_INVALID
    assert error.issue_code == "generator_contract_internal_failure"
    assert "secret" not in repr(error)

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(subject.json, "loads", interrupt)
    with pytest.raises(KeyboardInterrupt):
        load_chunk_summary(_bytes(_summary()), known_record_ids=RECORDS)


def test_public_error_constructor_cannot_embed_provider_values() -> None:
    error = _error(load_chunk_summary, b"{", known_record_ids=RECORDS)
    assert vars(error) == {
        "error_code": PAPER_SLIDE_OUTPUT_INVALID,
        "issue_code": "provider_json_syntax",
    }
