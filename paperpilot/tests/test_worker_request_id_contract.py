"""Static contracts for theme request correlation and dormant status."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_worker_dispatch_preserves_server_request_id() -> None:
    source = (ROOT / "worker/index.ts").read_text(encoding="utf-8")
    assert "requestId = createRequestId()" in source
    assert "dispatchInputs(theme, requestId)" in source
    assert "request_id: requestId" in source
    assert 'searchParams.get("theme")' not in source

    status = source[
        source.index("async function handleStatusGet") : source.index("async function handlePost")
    ]
    assert "themeStatusUnavailable()" in status
    assert "fetch(" not in status
    assert "env." not in status
    assert "GH_DISPATCH_PAT" not in status
    assert "findRecentRun" not in source
    assert "isStatusRateLimited" not in source


def test_dormant_status_contract_is_non_cacheable_cross_origin_json() -> None:
    source = (ROOT / "worker/response.js").read_text(encoding="utf-8")
    status = source[
        source.index("export function themeStatusUnavailable") : source.index("// Today's UTC")
    ]
    assert 'status: "error"' in status
    assert "status: 503" in status
    assert "completion continues through the public manifest" in status

    json_helper = source[
        source.index("export function json") : source.index(
            "export function themeStatusUnavailable"
        )
    ]
    assert '"cache-control": "no-store"' in json_helper
    assert '"access-control-allow-origin": "*"' in json_helper
    assert '"content-type": "application/json; charset=utf-8"' in json_helper


def test_frontend_retains_request_id_for_status_polling() -> None:
    source = (ROOT / "docs/assets/theme.js").read_text(encoding="utf-8")
    assert "data.request_id" in source
    assert "startProgress(slug, raw, requestId)" in source
    assert "requestId," in source
    assert "?request_id=" in source
    assert "/api/themes/status?theme=" not in source


def test_frontend_manifest_poll_remains_the_completion_source_of_truth() -> None:
    source = (ROOT / "docs/assets/theme.js").read_text(encoding="utf-8")
    polling = source[
        source.index("async function pollForCompletion") : source.index("function startProgress")
    ]
    assert 'fetch("themes-manifest.json", { cache: "no-store" })' in polling
    assert "data.some((e) => e?.slug === slug)" in polling
    assert "if (sr.ok)" in polling
    assert "Non-fatal — manifest poll + timeout" in polling


def test_workflow_and_release_preserve_original_request_id() -> None:
    source = (ROOT / ".github/workflows/theme-on-demand.yml").read_text(encoding="utf-8")
    assert "inputs.request_id" in source
    assert "request_id: ${{ inputs.request_id }}" in source
    assert "inputs.theme || 'manual' }} / ${{ inputs.request_id" in source
