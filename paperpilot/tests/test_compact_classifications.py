"""Classification-cache v2 compaction contract."""

from paperpilot.scripts.compact_classifications import _cache_endpoints


def test_cache_endpoints_supports_legacy_and_opaque_v2_keys() -> None:
    assert _cache_endpoints("a->b", {}) == ("a", "b")
    assert _cache_endpoints("v2:" + "f" * 64, {"src": "a", "dst": "b"}) == ("a", "b")


def test_cache_endpoints_rejects_malformed_v2_values() -> None:
    assert _cache_endpoints("v2:" + "f" * 64, {}) is None
    assert _cache_endpoints("not-a-pair", {}) is None
