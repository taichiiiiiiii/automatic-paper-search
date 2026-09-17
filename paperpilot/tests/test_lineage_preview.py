"""Local synthetic preview must not serve arbitrary repository files."""

import pytest

from paperpilot.tests.viewer.lineage_preview import response_for


def test_preview_html_is_marked_and_assets_are_served():
    mime, body = response_for("/lineage/?paper=" + "1" * 40)
    assert mime == "text/html"
    assert b"SYNTHETIC TEST ONLY" in body
    assert b"lineage-focus.js" in body
    assert response_for("/assets/lineage-focus.js?v=11")[0] == "text/javascript"


def test_preview_uses_fixture_not_public_index():
    assert b"synthetic-release-v1" in response_for("/lineage-pilot-index-v1.json")[1]
    assert b"synthetic" in response_for("/synthetic-pilot/papers.json")[1]


def test_directory_resources_are_limited_to_index_references():
    from paperpilot.tests.viewer.lineage_preview import FIXTURE, directory_resources

    resources = directory_resources(FIXTURE)
    assert len(resources) == 5
    assert "/synthetic-pilot/papers.json" in resources
    assert "/catalog.json" not in resources


def test_comparison_preview_uses_validated_memory_bundle():
    import json

    from paperpilot.tests.viewer.lineage_preview import comparison_resources

    resources = comparison_resources()
    index = json.loads(resources["/lineage-pilot-index-v1.json"])
    path = "/" + index["entries"][0]["artifact"]["path"]
    assert json.loads(resources[path])["claims"][0]["relation"] == "contrasts"
    assert response_for(path, resources)[1] == resources[path]


@pytest.mark.parametrize("path", ["/", "/AGENTS.md", "/.env", "/assets/../AGENTS.md",
                                  "/assets/%2e%2e/AGENTS.md", "//assets/style.css",
                                  "/assets/versions.json", "/lineage-pilots/missing.json"])
def test_preview_rejects_unlisted_paths(path):
    with pytest.raises(FileNotFoundError):
        response_for(path)
