"""Classification-cache v2 compaction contract."""

from paperpilot.scripts.compact_classifications import _cache_endpoints


def test_cache_endpoints_supports_legacy_and_opaque_v2_keys() -> None:
    assert _cache_endpoints("a->b", {}) == ("a", "b")
    assert _cache_endpoints("v2:" + "f" * 64, {"src": "a", "dst": "b"}) == ("a", "b")


def test_cache_endpoints_rejects_malformed_v2_values() -> None:
    assert _cache_endpoints("v2:" + "f" * 64, {}) is None
    assert _cache_endpoints("not-a-pair", {}) is None


def test_cache_endpoints_reads_theme_entries_nested_identity() -> None:
    """build_theme_lineage writes src/dst only inside cache_identity. They
    used to read as "no endpoints", which compaction treats as orphaned —
    so live theme classifications were deleted and re-paid for on the next
    rebuild."""
    theme_entry = {
        "status": "success",
        "expires_at": "2099-01-01T00:00:00Z",
        "cache_identity": {"version": 2, "src": "a", "dst": "b"},
        "classification": {"relation": "extends", "confidence": 0.8, "rationale": "r"},
    }
    assert _cache_endpoints("v2:" + "f" * 64, theme_entry) == ("a", "b")


def test_cache_endpoints_prefers_top_level_endpoints() -> None:
    """Deep-lineage entries carry both; the top level stays authoritative."""
    entry = {"src": "top-a", "dst": "top-b", "cache_identity": {"src": "x", "dst": "y"}}
    assert _cache_endpoints("v2:" + "f" * 64, entry) == ("top-a", "top-b")


def test_cache_endpoints_still_rejects_an_identity_without_endpoints() -> None:
    assert _cache_endpoints("v2:" + "f" * 64, {"cache_identity": {"version": 2}}) is None
